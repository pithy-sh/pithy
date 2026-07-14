import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type {
  AccountTokenSummary,
  MintedAccountToken,
  TokenPermission,
} from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import type { PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import {
  type ProfileOverride,
  profilePermissions,
  resolveProfile,
  type TokenProfile,
  type TokenStore,
} from "@pithy-sh/cloudflare/src/tokens/profiles";
import { type SinkTarget, writeTokenToSink } from "./sinks";

/** The account-token control plane the engine drives — the subset of `CloudflareAccountTokensManager` it needs. */
export interface AccountTokenControl {
  mintToken(name: string, permissions: TokenPermission[]): Promise<MintedAccountToken>;
  rollToken(name: string, permissions: TokenPermission[]): Promise<MintedAccountToken>;
  findTokenByName(name: string): Promise<AccountTokenSummary | null>;
  listTokens(): Promise<AccountTokenSummary[]>;
  deleteToken(id: string): Promise<void>;
  deleteTokensByName(name: string): Promise<number>;
}

/** The audit action codes for token lifecycle events — the `cloudflare/token_*` federated taxonomy. */
export const TokenAuditActions = {
  minted: "cloudflare/token_minted",
  rotated: "cloudflare/token_rotated",
  revoked: "cloudflare/token_revoked",
} as const;

/** One token-lifecycle audit event. Never carries the token value — only its id and where it went. */
export interface TokenAuditEvent {
  action: string;
  outcome: "success" | "failure";
  profile: string;
  env: string;
  tokenId?: string;
  store?: TokenStore;
}

/** The audit sink: records a token-lifecycle event. Absent → auditing is a no-op (audit not composed). */
export type TokenAudit = (event: TokenAuditEvent) => Promise<void>;

/** Everything the engine needs to mint, store, list, rotate, and revoke a project's scoped tokens. */
export interface TokenEngine {
  /** The account tokens target. */
  accountId: string;
  /** The project root — where `.dev.vars` stores live. */
  projectDir: string;
  /** The CF account-token control plane (the bootstrap token authenticates it). */
  tokens: AccountTokenControl;
  /** The aggregated profile registry (`resolveTokenProfiles`). */
  profiles: Record<string, TokenProfile>;
  /** The declared backend of a secret name (from the composed secret registry), for the store destination. */
  secretBackend?: (secretName: string) => string | undefined;
  /** Writes to the CF Secrets Store, for the `secrets-store` destination. Absent → that destination errors. */
  putSecret?: (name: string, value: string) => Promise<void>;
  /** Records lifecycle events; a no-op when absent (audit not composed). */
  audit?: TokenAudit;
  /** Resolves an adopter's `pithy.config.ts` override for a profile. */
  override?: (profile: string) => ProfileOverride | undefined;
}

/** Per-call overrides (CLI flags) that win over the profile default and the config override. */
export interface MintOptions {
  /** Override the store (`--store`). */
  store?: TokenStore;
  /** Override the permission keys (`--permission`). */
  permissions?: PermissionKey[];
}

/** The stable CF token name for a (profile, env): one identity per pair, rolled in place on re-mint. */
export function tokenName(profile: string, env: string): string {
  return `pithy-${profile}-${env}`;
}

/** The outcome of a mint/rotate. `value` is for the caller's in-process use — never surface it in output. */
export interface TokenResult {
  profile: string;
  env: string;
  tokenId: string;
  name: string;
  /** The secret token value — for in-process use. NEVER include in CLI output or `--json`. */
  value: string;
  sink: SinkTarget;
}

/** Emit a lifecycle event through the audit sink; non-fatal — an audit failure never breaks the action. */
async function emit(engine: TokenEngine, event: TokenAuditEvent): Promise<void> {
  if (!engine.audit) return;
  try {
    await engine.audit(event);
  } catch {
    // Non-fatal by contract: an audit write never breaks the token action it records.
  }
}

/** Merge the config override and the per-call CLI flags into one override (CLI flags win). */
function mergeOverride(engine: TokenEngine, profile: string, options?: MintOptions): ProfileOverride | undefined {
  const config = engine.override?.(profile);
  const merged: ProfileOverride = { ...config };
  if (options?.store) merged.store = options.store;
  if (options?.permissions) merged.permissions = options.permissions;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Resolve where a profile's minted value is written: the `--store`/profile override if set, otherwise
 * the token's **declared secret backend** — a token can't live in the encrypted D1 store (Worker-only),
 * so a store-backed token must be declared `cf-secrets-store`; an undeclared secret with no override
 * fails with actionable guidance. This is the registry-defined storage: the secret's definition decides
 * where the value goes, and `dev-vars`/`ephemeral` are the explicit overrides.
 */
function resolveDestination(engine: TokenEngine, profile: TokenProfile): TokenStore {
  // An explicit store (a profile's `defaultStore` or a `--store` override) is the declaration itself.
  if (profile.defaultStore) return profile.defaultStore;
  // No store declared → the destination comes from the token's declared secret-registry backend.
  const backend = engine.secretBackend?.(profile.secret);
  if (backend === "cf-secrets-store") return "secrets-store";
  if (backend === "d1") {
    throw new CloudflareNotConfiguredError({
      message: `Token "${profile.name}" can't be stored in the encrypted D1 secrets store — its value is read outside the Worker.`,
      action: `Declare ${profile.secret} as cf-secrets-store, or mint with --store dev-vars.`,
    });
  }
  throw new CloudflareNotConfiguredError({
    message: `No storage is declared for token "${profile.name}".`,
    action: `Declare the secret ${profile.secret} (pithy secrets) as cf-secrets-store, or mint with --store dev-vars.`,
  });
}

/**
 * Mint the profile's token for an environment and return a usable value. **Rolls in place**: the token
 * name is a stable `(profile, env)` identity, and each mint regenerates its value with the profile's
 * *current* permissions — so adding a capability's `ciPermissions` (or an override) takes effect on the
 * next mint, without hand-editing scopes. The fresh value is written to the resolved store and returned
 * for in-process use. Audited on success/failure.
 *
 * It does not reuse a stored value: that would pin the token to its old scope, silently defeating the
 * "add a capability → the CI token grows" contract. Roll keeps one identity, so re-minting never orphans
 * a token; a Worker consumer reads the current value from its CFSS binding, and a `dev-vars` consumer
 * re-reads the refreshed file.
 */
export async function mintProfileToken(
  engine: TokenEngine,
  profileName: string,
  env: string,
  options?: MintOptions,
): Promise<TokenResult> {
  const profile = resolveProfile(engine.profiles, profileName, mergeOverride(engine, profileName, options));
  const store = resolveDestination(engine, profile);
  const name = tokenName(profileName, env);

  try {
    const minted = await engine.tokens.rollToken(name, profilePermissions(profile, engine.accountId));
    const sink = await writeTokenToSink(store, minted.value, {
      projectDir: engine.projectDir,
      env,
      secretName: profile.secret,
      putSecret: engine.putSecret,
    });
    await emit(engine, {
      action: TokenAuditActions.minted,
      outcome: "success",
      profile: profileName,
      env,
      tokenId: minted.id,
      store,
    });
    return { profile: profileName, env, tokenId: minted.id, name, value: minted.value, sink };
  } catch (error) {
    await emit(engine, { action: TokenAuditActions.minted, outcome: "failure", profile: profileName, env });
    throw error;
  }
}

/** One row of `pithy token list`: a minted token's identity, never its value. */
export interface TokenListItem {
  profile: string;
  env: string;
  name: string;
  tokenId: string;
  status?: string;
}

/** List the project's minted tokens for an environment — `pithy-<profile>-<env>` names only, no values. */
export async function listProfileTokens(engine: TokenEngine, env: string): Promise<TokenListItem[]> {
  const suffix = `-${env}`;
  const all = await engine.tokens.listTokens();
  return all
    .filter((token) => token.name.startsWith("pithy-") && token.name.endsWith(suffix))
    .map((token) => ({
      profile: token.name.slice("pithy-".length, token.name.length - suffix.length),
      env,
      name: token.name,
      tokenId: token.id,
      status: token.status,
    }));
}

/** Options for `pithy token rotate`. */
export interface RotateOptions extends MintOptions {
  /** Keep the previous token instead of deleting it — a grace window for consumers to pick up the new one. */
  keepPrevious?: boolean;
}

/**
 * Rotate the profile's token with the proven two-step (Cloudflare has no single-call rotate): mint a
 * **new** token with the same name and policies, store its value, then delete the prior token(s) by id.
 * `keepPrevious` leaves the old token in place — a grace window while a Worker consumer picks up the
 * new value (redeploy) before it is revoked. Audited on success/failure.
 */
export async function rotateProfileToken(
  engine: TokenEngine,
  profileName: string,
  env: string,
  options?: RotateOptions,
): Promise<TokenResult> {
  const profile = resolveProfile(engine.profiles, profileName, mergeOverride(engine, profileName, options));
  const store = resolveDestination(engine, profile);
  const name = tokenName(profileName, env);
  try {
    // Snapshot the prior token id(s) before creating the replacement, so we delete exactly what predates it.
    const priorIds = (await engine.tokens.listTokens()).filter((token) => token.name === name).map((token) => token.id);
    const minted = await engine.tokens.mintToken(name, profilePermissions(profile, engine.accountId));
    const sink = await writeTokenToSink(store, minted.value, {
      projectDir: engine.projectDir,
      env,
      secretName: profile.secret,
      putSecret: engine.putSecret,
    });
    if (!options?.keepPrevious) {
      for (const id of priorIds) await engine.tokens.deleteToken(id);
    }
    await emit(engine, {
      action: TokenAuditActions.rotated,
      outcome: "success",
      profile: profileName,
      env,
      tokenId: minted.id,
      store,
    });
    return { profile: profileName, env, tokenId: minted.id, name, value: minted.value, sink };
  } catch (error) {
    await emit(engine, { action: TokenAuditActions.rotated, outcome: "failure", profile: profileName, env });
    throw error;
  }
}

/** The outcome of a revoke — how many tokens of the profile's name were deleted. */
export interface RevokeResult {
  profile: string;
  env: string;
  name: string;
  revoked: number;
}

/** Revoke the profile's token(s) for an environment — deletes every token of that name. Audited. */
export async function revokeProfileToken(engine: TokenEngine, profileName: string, env: string): Promise<RevokeResult> {
  const name = tokenName(profileName, env);
  try {
    const revoked = await engine.tokens.deleteTokensByName(name);
    await emit(engine, { action: TokenAuditActions.revoked, outcome: "success", profile: profileName, env });
    return { profile: profileName, env, name, revoked };
  } catch (error) {
    await emit(engine, { action: TokenAuditActions.revoked, outcome: "failure", profile: profileName, env });
    throw error;
  }
}
