import { z } from "zod";
import {
  CloudflareNotConfiguredError,
  CloudflareRequestError,
  cloudflareRequest,
  decodeResponse,
  isAuthorizationError,
  messageOf,
} from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * One access policy to attach to a minted token: a set of permission groups (named, resolved to ids
 * at mint time) and the resources they apply to. This is the reusable unit — every use case that
 * needs a scoped CF token (the secrets manager is the first) describes itself as a list of these,
 * and the manager turns names into the CF policy shape. `effect` defaults to `allow`.
 */
export interface TokenPermission {
  /** Permission-group names to grant, resolved to ids against the live account list (e.g. "Secrets Store Read"). */
  permissionGroupNames: string[];
  /** The resource scope the groups apply to (e.g. `{ "com.cloudflare.api.account.<id>": "*" }`). */
  resources: Record<string, string>;
  /** Allow or deny the groups against the resources. Defaults to `allow`. */
  effect?: "allow" | "deny";
}

/**
 * The whole-account resource scope for a token policy: `{ "com.cloudflare.api.account.<id>": "*" }`.
 * Account-level permission groups (Secrets Store, D1, Workers, …) scope to this. One helper so the
 * exact resource key format lives in a single place instead of being hand-spelled per use case.
 */
export function accountResource(accountId: string): Record<string, string> {
  return { [`com.cloudflare.api.account.${accountId}`]: "*" };
}

/**
 * A permission group available to account-owned tokens, as returned by the permission-groups list.
 * Only the id and name matter for resolution — the manager maps a requested name to its id.
 */
export const CfPermissionGroup = z
  .object({
    id: z.string().describe("The CF-assigned permission-group id, referenced in a token policy."),
    name: z.string().describe("The human-readable permission-group name (e.g. 'Secrets Store Read')."),
  })
  .describe("A Cloudflare account-token permission group: the id a policy references and its display name.");
export type CfPermissionGroup = z.output<typeof CfPermissionGroup>;

/**
 * A freshly minted account-owned token. The `value` is the secret bearer credential — present **only**
 * in the create response, never re-readable — so it is captured here and must be stored at once
 * (e.g. into the Secrets Store). Never log it.
 */
export const MintedAccountToken = z
  .object({
    id: z.string().describe("The CF-assigned token id, used to address the token for get/delete."),
    value: z.string().describe("The secret token value — returned once on create, never again. Store immediately."),
    name: z.string().optional().describe("The token name as registered with Cloudflare."),
    status: z.enum(["active", "disabled", "expired"]).optional().describe("The token's lifecycle status."),
  })
  .describe("A newly created account-owned API token, including its one-time secret value.");
export type MintedAccountToken = z.output<typeof MintedAccountToken>;

/**
 * An existing account-owned token's metadata, as returned by list/get. No `value` — Cloudflare never
 * returns a token's secret after creation — so this is only enough to find a token by name and
 * address it for deletion.
 */
export const AccountTokenSummary = z
  .object({
    id: z.string().describe("The CF-assigned token id, used to address the token for deletion."),
    name: z.string().describe("The token name, the key callers match on for idempotent re-mint."),
    status: z.enum(["active", "disabled", "expired"]).optional().describe("The token's lifecycle status."),
  })
  .describe("An existing account-owned API token's metadata (never its secret value).");
export type AccountTokenSummary = z.output<typeof AccountTokenSummary>;

/**
 * Out-of-Worker control plane for **account-owned** Cloudflare API tokens: mint scoped, least-privilege
 * tokens, find them by name, and delete them. Account-owned (not user-bound) by design — CLAUDE.md
 * prefers org-level tokens that outlive any one person.
 *
 * This is the reusable seam behind every "pithy mints its own scoped token" case. A caller hands it a
 * token name and a set of {@link TokenPermission}s (permission-group names + resource scope); the
 * manager resolves the names to ids against the live account list and creates the token. The secrets
 * manager's runtime credential is the first concrete use; more follow without touching this class.
 */
export class CloudflareAccountTokensManager extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare Account API Tokens";
  }

  /** Prove access by listing permission groups — a read, never a token create/delete. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.listPermissionGroups();
      return true;
    } catch {
      return false;
    }
  }

  /** Every permission group available to account-owned tokens in this account (SDK auto-paginates). */
  async listPermissionGroups(): Promise<CfPermissionGroup[]> {
    return cloudflareRequest("list account token permission groups", async () => {
      const out: CfPermissionGroup[] = [];
      for await (const group of this.getClient().accounts.tokens.permissionGroups.list({
        account_id: this.accountId,
      })) {
        const parsed = CfPermissionGroup.safeParse(group);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    });
  }

  /**
   * Resolve permission-group names to their `{ id }` references against the account's live group list.
   * Throws a clear, actionable error naming any name that does not exist, or any name that is
   * **ambiguous** — Cloudflare reuses display names across resource scopes (e.g. account vs zone), so a
   * name that maps to more than one id can't be resolved without picking the wrong scope. Either way a
   * typo'd or ambiguous group fails loudly at mint time, never silently widening or narrowing scope.
   */
  async resolvePermissionGroups(names: string[]): Promise<Array<{ id: string }>> {
    return this.resolveAgainstIndex(indexByName(await this.listPermissionGroups()), names);
  }

  /**
   * Mint a new account-owned token named `name` carrying `permissions`. Resolves every permission
   * group name to its id (one group-list fetch for all policies), builds the CF policy set, and
   * creates the token. Returns the token's one-time secret `value` — store it immediately. A 403 (the
   * calling token cannot create tokens) is reraised as an actionable "grant 'Account API Tokens
   * Write'" error so the cause is obvious; this doubles as the fail-fast preflight when provisioning
   * runs the mint first.
   */
  async mintToken(name: string, permissions: TokenPermission[]): Promise<MintedAccountToken> {
    const index = indexByName(await this.listPermissionGroups());
    const policies = permissions.map((permission) => ({
      effect: permission.effect ?? ("allow" as const),
      permission_groups: this.resolveAgainstIndex(index, permission.permissionGroupNames),
      resources: permission.resources,
    }));
    let raw: unknown;
    try {
      raw = await this.getClient().accounts.tokens.create({ account_id: this.accountId, name, policies });
    } catch (error) {
      if (isAuthorizationError(error)) {
        throw new CloudflareNotConfiguredError(
          {
            message: "The Cloudflare API token is not allowed to create account tokens.",
            action: "Grant it 'Account API Tokens Write' (Account → API Tokens → Edit), then re-run.",
            detail: `mint account token '${name}': ${messageOf(error)}`,
          },
          { cause: error },
        );
      }
      throw new CloudflareRequestError(
        { message: `Failed to mint account token '${name}'.`, detail: messageOf(error) },
        { cause: error },
      );
    }
    return decodeResponse(MintedAccountToken, raw, "account token create");
  }

  /**
   * Resolve names against a prefetched name→ids index, throwing on any unknown or ambiguous name.
   * The shared core of {@link resolvePermissionGroups} and {@link mintToken}: take the group list once,
   * resolve every name against it. Ambiguity (a name with more than one id) is a hard error, not a
   * silent pick — see {@link resolvePermissionGroups}.
   */
  private resolveAgainstIndex(index: Map<string, string[]>, names: string[]): Array<{ id: string }> {
    const unknown = names.filter((name) => !index.has(name));
    if (unknown.length > 0) {
      throw new CloudflareNotConfiguredError({
        message: `Unknown Cloudflare permission group(s): ${unknown.join(", ")}.`,
        action: "Check the exact permission-group names against the account's available groups.",
        detail: `resolve permission groups: not found in account ${this.accountId} — ${unknown.join(", ")}`,
      });
    }
    const ambiguous = names.filter((name) => (index.get(name)?.length ?? 0) > 1);
    if (ambiguous.length > 0) {
      throw new CloudflareNotConfiguredError({
        message: `Ambiguous Cloudflare permission group(s): ${ambiguous.join(", ")}.`,
        action: "These names map to more than one permission group; scope the token by a unique group name.",
        detail: `resolve permission groups: name maps to multiple ids in account ${this.accountId} — ${ambiguous.join(", ")}`,
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: each name is present and unambiguous — the guards above proved it.
    return names.map((name) => ({ id: index.get(name)![0]! }));
  }

  /** Find an account token by exact name, or `null` — for idempotent re-mint (SDK auto-paginates). */
  async findTokenByName(name: string): Promise<AccountTokenSummary | null> {
    return cloudflareRequest(`find account token ${name}`, async () => {
      for await (const token of this.getClient().accounts.tokens.list({ account_id: this.accountId })) {
        const parsed = AccountTokenSummary.safeParse(token);
        if (parsed.success && parsed.data.name === name) return parsed.data;
      }
      return null;
    });
  }

  /** Delete an account token by id. */
  async deleteToken(tokenId: string): Promise<void> {
    await cloudflareRequest(`delete account token ${tokenId}`, () =>
      this.getClient().accounts.tokens.delete(tokenId, { account_id: this.accountId }),
    );
  }

  /**
   * Delete every account token with the given name; returns how many were removed. Names are not
   * unique in Cloudflare, so any duplicates (e.g. a prior interrupted run) are swept here. A no-op
   * when none match. Used by teardown.
   */
  async deleteTokensByName(name: string): Promise<number> {
    return cloudflareRequest(`delete account tokens named ${name}`, async () => {
      const ids: string[] = [];
      for await (const token of this.getClient().accounts.tokens.list({ account_id: this.accountId })) {
        const parsed = AccountTokenSummary.safeParse(token);
        if (parsed.success && parsed.data.name === name) ids.push(parsed.data.id);
      }
      for (const id of ids) {
        await this.getClient().accounts.tokens.delete(id, { account_id: this.accountId });
      }
      return ids.length;
    });
  }

  /**
   * Roll an existing token's secret: regenerate its value **in place**, keeping the same token id,
   * name, and policies (the dashboard's "Roll" action). Returns the new secret value — the only time
   * Cloudflare hands it back — so it must be stored at once. The seam the deferred value-rotation
   * builds on: a credential self-rolls without ever changing identity.
   */
  async rollTokenValue(tokenId: string): Promise<string> {
    const raw = await cloudflareRequest(`roll account token value ${tokenId}`, () =>
      this.getClient().accounts.tokens.value.update(tokenId, { account_id: this.accountId, body: {} }),
    );
    return decodeResponse(RolledTokenValue, raw, "account token value roll");
  }

  /**
   * Ensure a named token exists and return a **fresh** secret for it. If a token of this name already
   * exists, roll its value in place (same id and policies, new secret); otherwise mint a new one.
   * Either way the caller gets a usable secret to store — the idempotent path for a credential that
   * lives in the Secrets Store, since Cloudflare never returns a token's existing secret. Mirrors the
   * dashboard's roll-or-create.
   */
  async rollToken(name: string, permissions: TokenPermission[]): Promise<MintedAccountToken> {
    const existing = await this.findTokenByName(name);
    if (!existing) return this.mintToken(name, permissions);
    const value = await this.rollTokenValue(existing.id);
    return { id: existing.id, value, name: existing.name, status: existing.status };
  }
}

/** The rolled secret value Cloudflare returns from a value-roll — a non-empty bearer string. */
const RolledTokenValue = z.string().min(1);

/**
 * Index permission groups by display name, collecting **every** id that bears a name. A list rather
 * than one id per name on purpose: Cloudflare reuses display names across scopes, and a name with
 * more than one id is ambiguous — the resolver rejects it rather than silently pick one.
 */
function indexByName(groups: CfPermissionGroup[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const group of groups) {
    const ids = index.get(group.name) ?? [];
    ids.push(group.id);
    index.set(group.name, ids);
  }
  return index;
}
