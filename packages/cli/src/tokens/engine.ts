// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type {
  AccountTokenPolicy,
  AccountTokenSummary,
  MintedAccountToken,
  TokenPermission,
} from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { PERMISSION_GROUPS, type PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import {
  CI_SYSTEM_PROFILE,
  type ProfileOverride,
  profilePermissions,
  resolveProfile,
  routePermissions,
  type TokenProfile,
  type TokenStore,
} from "@pithy-sh/cloudflare/src/tokens/profiles";
import { kebab } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { StatePathOptions } from "../notifier/state";
import { type ResolvedRouteZone, routeZoneIds } from "./routeZones";
import { type SinkTarget, writeTokenToSink } from "./sinks";

/** The account-token control plane the engine drives — the subset of `CloudflareAccountTokensManager` it needs. */
export interface AccountTokenControl {
  mintToken(name: string, permissions: TokenPermission[]): Promise<MintedAccountToken>;
  /** Resolve permission-group display names to their account ids — for reading a live token's grants. */
  resolvePermissionGroups(names: string[]): Promise<Array<{ id: string }>>;
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
  /**
   * The project name (root `pithy.config.ts` `name`, via `requireProjectName` — never guessed). The
   * first segment of every token name and of every Secrets Store entry a mint writes. Required, because
   * Cloudflare's account token list and Secrets Store are both flat: without it, two Pithy projects in
   * one account mint tokens of the same name, and `revoke` — which deletes *every* token of a name —
   * revokes the other project's credential along with its own.
   */
  project: string;
  /** The project root — for the audit sink's app-database lookup. Nothing minted is written into it (#182). */
  projectDir: string;
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test writes its own. */
  paths?: StatePathOptions;
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
  /**
   * The zones this environment's declared domains sit in, resolved against the account (#651).
   *
   * Only the `ci-system` token gets them, because only CI deploys: the route write
   * (`POST /zones/<zone>/workers/routes`) is the last step of `pithy deploy` for an environment with a
   * declared domain, and a token with no zone resource cannot make it. A resolver that answers `[]` —
   * or is absent, as it is in every caller that does not deploy — mints exactly the account-scoped
   * token this engine minted before route scoping existed.
   *
   * It may **throw**, and a throw here fails the mint. That is the design: a zone the account does not
   * hold cannot be scoped, and a token minted without it passes every local check and fails in CI.
   */
  routeZones?: () => Promise<ResolvedRouteZone[]>;
}

/** Per-call overrides (CLI flags) that win over the profile default and the config override. */
export interface MintOptions {
  /** Override the store (`--store`). */
  store?: TokenStore;
  /** Override the permission keys (`--permission`). */
  permissions?: PermissionKey[];
}

/**
 * The stable CF token name for a (project, env, profile): `<project>-<env>-<profile>`. One identity per
 * triple, rolled in place on re-mint.
 *
 * The account's API-token list is flat and account-wide, so this name is the only thing that separates
 * one project's credentials from another's in the same account. The project segment goes first because
 * that is the ownership boundary {@link tokenPrefix} filters on.
 */
export function tokenName(project: string, env: string, profile: string): string {
  return resourceNames(project).env(env).apiToken(profile);
}

/**
 * The prefix every one of a project's tokens for an environment shares — `<project>-<env>-`.
 *
 * This is the ownership filter for listing. It must be built from the same kebab-cased segments
 * {@link tokenName} composes, and only the trailing `thing` segment of a resource name is ever
 * truncated, so a prefix match here is exact: a token outside this project or this environment cannot
 * pass it.
 */
export function tokenPrefix(project: string, env: string): string {
  return `${kebab(project)}-${kebab(env)}-`;
}

/**
 * The CF Secrets Store entry name a profile's minted value is written to.
 *
 * Distinct from `profile.secret`, which is the registry join key and the `.dev.vars` **variable** name.
 * Only the store entry is scoped: the store is one flat account-wide namespace where an unscoped name
 * would let one project's mint overwrite another's live credential, whereas `.dev.vars` is a file in
 * this checkout and renaming its keys would break every CI pipeline reading `CF_TOKEN_CI_SYSTEM`.
 *
 * A `global` profile puts the literal `global` in the environment slot, so every environment resolves
 * the one entry provisioning wrote instead of minting a per-environment entry nothing binds.
 */
export function tokenStoreEntryName(project: string, env: string, profile: TokenProfile): string {
  const names = resourceNames(project);
  return (profile.secretScope === "global" ? names.global : names.env(env)).secretEntry(profile.secret);
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
  /**
   * The token's lifecycle status, when Cloudflare said — so the command can refuse to call a dead
   * credential a success.
   *
   * A mint *rolls* an existing token's value, and a roll says nothing about whether that token is still
   * alive: a `disabled` or `expired` token gives up a perfectly real new secret that fails on its first
   * call. The value was written to the sink and `Done.` was printed, which is the one thing that must
   * not happen quietly. `undefined` means the response did not say, which is not a claim that it is fine.
   */
  status?: "active" | "disabled" | "expired";
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

/**
 * The config override and the per-call CLI flags, merged — **and where the permissions came from.**
 *
 * The provenance is not decoration (#651 round three). Both a standing `tokens.overrides` entry and a
 * one-off `--permission` suppress the route policy, and the two need opposite handling: a standing
 * declaration is the adopter saying what this credential permanently is, while a flag is one command
 * that, under replace semantics, would permanently re-scope a credential CI deploys with. Merging them
 * into one indistinguishable field is what made the printed remedy a no-op loop in the first case and a
 * silent strip in the second.
 */
interface MergedOverride {
  override: ProfileOverride | undefined;
  /** Where the permission set came from, or `null` when nothing overrode it. */
  permissionsFrom: "config" | "flag" | null;
}

/** Merge the config override and the per-call CLI flags into one override (CLI flags win). */
function mergeOverride(engine: TokenEngine, profile: string, options?: MintOptions): MergedOverride {
  const config = engine.override?.(profile);
  const merged: ProfileOverride = { ...config };
  if (options?.store) merged.store = options.store;
  if (options?.permissions) merged.permissions = options.permissions;
  const permissionsFrom = options?.permissions ? "flag" : config?.permissions ? "config" : null;
  return { override: Object.keys(merged).length > 0 ? merged : undefined, permissionsFrom };
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
 * The whole policy set a profile's token carries: its own account-scoped policy, plus — for `ci-system`
 * alone — the zone-scoped route policy the project's declared domains require (#651).
 *
 * The zones resolve **before** any Cloudflare write, so an unresolvable one fails the mint rather than
 * producing a credential that deploys green and cannot attach a route. Every other profile is a
 * worker-consumer credential that never deploys, so its resolver is never called at all.
 */
async function tokenPolicies(
  engine: TokenEngine,
  profileName: string,
  profile: TokenProfile,
  override: ProfileOverride | undefined,
): Promise<TokenPermission[]> {
  const account = profilePermissions(profile, engine.accountId);
  if (profileName !== CI_SYSTEM_PROFILE) return account;
  // **An explicit narrowing means exactly what it says.** The route policy rides with the profile's
  // *default* permission set — the thing `ci-system` is, grown from the composed capabilities — and not
  // with every mint. An operator who writes `--permission d1:read`, or pins `tokens.overrides` in
  // `pithy.config.ts`, is stating what this credential may do; adding a zone grant they did not ask for
  // would make the flag a suggestion. It would also be the one scope they cannot take back, since
  // naming `routes:write` by hand is refused.
  if (override?.permissions) return account;
  const zones = (await engine.routeZones?.()) ?? [];
  return [...account, ...routePermissions(routeZoneIds(zones))];
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
  const { override } = mergeOverride(engine, profileName, options);
  const profile = resolveProfile(engine.profiles, profileName, override);
  const store = resolveDestination(engine, profile);
  const name = tokenName(engine.project, env, profileName);

  try {
    const minted = await engine.tokens.rollToken(name, await tokenPolicies(engine, profileName, profile, override));
    const sink = await writeTokenToSink(store, minted.value, {
      project: engine.project,
      env,
      secretName: profile.secret,
      storeEntryName: tokenStoreEntryName(engine.project, env, profile),
      putSecret: engine.putSecret,
      ...(engine.paths !== undefined ? { paths: engine.paths } : {}),
    });
    await emit(engine, {
      action: TokenAuditActions.minted,
      outcome: "success",
      profile: profileName,
      env,
      tokenId: minted.id,
      store,
    });
    return {
      profile: profileName,
      env,
      tokenId: minted.id,
      name,
      value: minted.value,
      sink,
      ...(minted.status !== undefined ? { status: minted.status } : {}),
    };
  } catch (error) {
    await emit(engine, { action: TokenAuditActions.minted, outcome: "failure", profile: profileName, env });
    throw error;
  }
}

/**
 * Whether a live token is scoped to the zones this environment's declared domains need (#651).
 *
 * **The token's own policies are the record.** A `ci-system` token minted before zone-scoped routes
 * carries one account policy and no zone resource, and it will fail the next deploy of a custom domain —
 * so an adopter needs to be told before that deploy, and told what to run. Nothing local can say it: a
 * mint writes a value, not a scope, and reading the token record needs `API Tokens Read`, which these
 * least-privilege tokens deliberately do not carry. The policy set on the account's own token list is
 * the one answer available, and this is it.
 */
export type RouteScope =
  /** This environment declares no domain, so there is no route to attach and no zone to scope. */
  | "not-required"
  /** Every zone this environment's domains need is on the token. */
  | "scoped"
  /** A zone this environment's domains need is **not** on the token — it predates route scoping. */
  | "stale"
  /**
   * The grant is missing **because a standing `tokens.overrides` says so**, so re-minting would produce
   * the same token again.
   *
   * Distinct from `stale` because the remedy is a different edit, and printing `stale`'s remedy here is
   * a lie the tool repeats forever: the adopter runs the command, the override strips the route policy
   * from that mint too, and the listing says `stale` again.
   */
  | "overridden"
  /**
   * The token carries the grant and **is not active**, so Cloudflare refuses it on every call.
   *
   * Its own word because a `disabled` or `expired` token with a perfect policy set is not stale — the
   * scope is right and the credential is dead — and reading the policies alone called it `scoped`,
   * which tells an operator their next deploy will work.
   */
  | "inactive"
  /** The token's policies did not come back, so nothing can be claimed either way. */
  | "unknown";

/** One row of `pithy token list`: a minted token's identity, never its value. */
export interface TokenListItem {
  profile: string;
  env: string;
  name: string;
  tokenId: string;
  status?: string;
  /** Whether this token can attach the routes this environment's declared domains need. */
  routeScope: RouteScope;
}

/**
 * What this environment needs a live `ci-system` token to carry, or why it cannot be said.
 *
 * `null` for "cannot be said", which is not the same as "carries nothing": the zones come from an
 * account call and the group id from another, and either can fail for a caller that is perfectly
 * entitled to see the listing.
 */
interface RouteRequirement {
  zoneIds: readonly string[];
  routeGroupId: string;
}

/**
 * Every zone id a policy's `resources` names, and whether it names *all* of them.
 *
 * **Two shapes, because Cloudflare writes two.** A zone resource appears as a top-level
 * `com.cloudflare.api.account.zone.<id>` key, and also nested one level inside an account key —
 * `{ "com.cloudflare.api.account.<acct>": { "com.cloudflare.api.account.zone.<id>": "*" } }`, which is
 * the form Cloudflare's own documentation gives for zones within an account. Scanning only the top
 * level read a working token as stale and sent an operator to re-mint something that already worked.
 * The `*` id is Cloudflare's all-zones wildcard and covers whatever this project declares.
 */
function zonesNamedBy(resources: Record<string, unknown>): { ids: Set<string>; all: boolean } {
  const ids = new Set<string>();
  let all = false;
  const take = (key: string): void => {
    if (!key.startsWith(ZONE_RESOURCE_PREFIX)) return;
    const id = key.slice(ZONE_RESOURCE_PREFIX.length);
    if (id === "*") all = true;
    else ids.add(id);
  };
  for (const [key, value] of Object.entries(resources)) {
    take(key);
    if (typeof value === "object" && value !== null) for (const nested of Object.keys(value)) take(nested);
  }
  return { ids, all };
}

/** Whether a policy's resources reach one zone. */
function policyReaches(policy: AccountTokenPolicy, zoneId: string): boolean {
  const named = zonesNamedBy(policy.resources);
  return named.all || named.ids.has(zoneId);
}

/** What can be said about one zone: covered, definitely not, or not knowable from this response. */
type ZoneVerdict = "covered" | "uncovered" | "indeterminate";

/**
 * Read a live token's route coverage against what this environment needs.
 *
 * **Both halves of a policy, never one, and the effect as well.** A
 * `com.cloudflare.api.account.zone.<id>` resource says which zone a policy is *about* and nothing about
 * what it may do there — a zone-scoped `Zone Read` somebody added by hand matches the resource exactly
 * and still cannot attach a route. And Cloudflare evaluates explicit denies first, so a `deny` policy
 * naming the route group on the zone is the opposite of coverage rather than coverage.
 *
 * **A zone nobody named is decisively uncovered, whatever the groups say.** That distinction is the
 * whole of round three's regression: requiring `permission_groups` before judging anything turned the
 * original stale token — one account policy, no zone resource at all — into `unknown`, and the remedy
 * stopped printing for exactly the shape it was written for. Only a zone that *is* named needs its
 * groups read, and only then can the answer be "cannot tell".
 */
function routeScopeOf(token: AccountTokenSummary, requirement: RouteRequirement | null, needed: boolean): RouteScope {
  if (!needed) return "not-required";
  // Before any policy is read: a token Cloudflare will refuse cannot attach a route however it is
  // scoped. A response that did not say is judged on its policies, since absent is not `disabled`.
  if (token.status !== undefined && token.status !== "active") return "inactive";
  if (requirement === null || token.policies === undefined) return "unknown";
  const verdicts = requirement.zoneIds.map((zoneId) => zoneVerdict(token.policies ?? [], requirement, zoneId));
  if (verdicts.includes("uncovered")) return "stale";
  if (verdicts.includes("indeterminate")) return "unknown";
  return "scoped";
}

/** The verdict for one required zone against a token's whole policy set. */
function zoneVerdict(
  policies: readonly AccountTokenPolicy[],
  requirement: RouteRequirement,
  zoneId: string,
): ZoneVerdict {
  const reaching = policies.filter((policy) => policyReaches(policy, zoneId));
  // Nothing names this zone at all. No reading of any group changes that.
  if (reaching.length === 0) return "uncovered";
  const names = (policy: AccountTokenPolicy): boolean =>
    (policy.permission_groups ?? []).some((group) => group.id === requirement.routeGroupId);
  // Explicit deny first, exactly as Cloudflare evaluates it.
  if (reaching.some((policy) => policy.effect === "deny" && names(policy))) return "uncovered";
  if (reaching.some((policy) => policy.effect !== "deny" && names(policy))) return "covered";
  // Something reaches the zone and did not say what it grants — that, and only that, is unknowable.
  if (reaching.some((policy) => policy.permission_groups === undefined)) return "indeterminate";
  return "uncovered";
}

/**
 * What a `ci-system` token must carry here — the declared zones, and the id of the route group — or
 * `null` when either could not be read.
 *
 * **Never throws, and that is the point.** This is the reporting path: `pithy token list` is what an
 * operator runs to find out which credentials exist and whether the CI one is scoped, and both lookups
 * behind the second question can fail while the first is perfectly answerable. A typo'd zone, a zone
 * the account no longer holds, a caller without Zone Read — letting any of them out would take down
 * every row in the listing, including the ones that have nothing to do with zones, at exactly the
 * moment somebody is trying to find out what is wrong. Minting is where the same failure is loud.
 */
async function routeRequirement(engine: TokenEngine): Promise<RouteRequirement | null> {
  try {
    const zoneIds = routeZoneIds((await engine.routeZones?.()) ?? []);
    if (zoneIds.length === 0) return { zoneIds, routeGroupId: "" };
    const [group] = await engine.tokens.resolvePermissionGroups([...PERMISSION_GROUPS["routes:write"]]);
    if (!group) return null;
    return { zoneIds, routeGroupId: group.id };
  } catch {
    return null;
  }
}

/** The resource-key prefix a zone-scoped policy is written under. */
const ZONE_RESOURCE_PREFIX = "com.cloudflare.api.account.zone.";

/**
 * List **this project's** minted tokens for an environment — identities only, never values.
 *
 * Two gates, and both matter. The `<project>-<env>-` prefix is the ownership filter: the account token
 * list is every token in the account, including other Pithy projects' and the operator's own, and
 * anything the CLI lists is something it offers to rotate and revoke.
 *
 * The profile is then recovered by **reverse lookup** from the known profile names, not by slicing the
 * prefix off the name. A token name is composed through the naming facade, which truncates and hashes a
 * trailing segment past its namespace's budget — so the profile segment on the wire is not always
 * the profile name, and a slice would hand back a mangled string that `rotate`/`revoke` cannot resolve.
 * Composing each known profile's name and matching exactly is the only recovery that survives that. A
 * prefixed token no profile claims is therefore not listed: it is not a profile token this CLI can act on.
 */
export async function listProfileTokens(engine: TokenEngine, env: string): Promise<TokenListItem[]> {
  const prefix = tokenPrefix(engine.project, env);
  const byName = new Map<string, string>();
  for (const profile of Object.keys(engine.profiles)) {
    byName.set(tokenName(engine.project, env, profile), profile);
  }
  const all = await engine.tokens.listTokens();
  // Resolved once for the whole listing, and only if something in it is a `ci-system` token — a project
  // with no CI token minted yet has no reason to read the account's zones.
  const requirement = all.some((token) => byName.get(token.name) === CI_SYSTEM_PROFILE)
    ? await routeRequirement(engine)
    : null;
  // Read once for the listing: a standing `tokens.overrides["ci-system"].permissions` is why a grant is
  // absent, and is the thing to change rather than the mint command.
  const overridden = engine.override?.(CI_SYSTEM_PROFILE)?.permissions !== undefined;
  return all.flatMap((token) => {
    if (!token.name.startsWith(prefix)) return [];
    const profile = byName.get(token.name);
    if (!profile) return [];
    // Only the CI credential deploys, so only it needs a route scope. Everything else is `not-required`.
    const needed = profile === CI_SYSTEM_PROFILE && requirement?.zoneIds.length !== 0;
    const scope = profile === CI_SYSTEM_PROFILE ? routeScopeOf(token, requirement, needed) : "not-required";
    // A standing override strips the route policy from every mint, so a missing grant is that override's
    // doing and re-minting would reproduce it exactly. Said as its own word, because the remedy differs.
    const routeScope: RouteScope = scope === "stale" && overridden ? "overridden" : scope;
    return [{ profile, env, name: token.name, tokenId: token.id, status: token.status, routeScope }];
  });
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
  const { override } = mergeOverride(engine, profileName, options);
  const profile = resolveProfile(engine.profiles, profileName, override);
  const store = resolveDestination(engine, profile);
  const name = tokenName(engine.project, env, profileName);
  try {
    // Snapshot the prior token id(s) before creating the replacement, so we delete exactly what predates it.
    const priorIds = (await engine.tokens.listTokens()).filter((token) => token.name === name).map((token) => token.id);
    const minted = await engine.tokens.mintToken(name, await tokenPolicies(engine, profileName, profile, override));
    const sink = await writeTokenToSink(store, minted.value, {
      project: engine.project,
      env,
      secretName: profile.secret,
      storeEntryName: tokenStoreEntryName(engine.project, env, profile),
      putSecret: engine.putSecret,
      ...(engine.paths !== undefined ? { paths: engine.paths } : {}),
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
    return {
      profile: profileName,
      env,
      tokenId: minted.id,
      name,
      value: minted.value,
      sink,
      ...(minted.status !== undefined ? { status: minted.status } : {}),
    };
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

/**
 * Revoke the profile's token(s) for an environment — deletes **every** account token of that name.
 * Audited. The name is project-scoped, which is what keeps that sweep inside this project: an unscoped
 * name would make one project's revoke delete every other project's token of the same profile.
 */
export async function revokeProfileToken(engine: TokenEngine, profileName: string, env: string): Promise<RevokeResult> {
  const name = tokenName(engine.project, env, profileName);
  try {
    const revoked = await engine.tokens.deleteTokensByName(name);
    await emit(engine, { action: TokenAuditActions.revoked, outcome: "success", profile: profileName, env });
    return { profile: profileName, env, name, revoked };
  } catch (error) {
    await emit(engine, { action: TokenAuditActions.revoked, outcome: "failure", profile: profileName, env });
    throw error;
  }
}
