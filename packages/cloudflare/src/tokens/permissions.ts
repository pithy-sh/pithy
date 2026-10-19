// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "../client/errors";

/**
 * The permission catalog: short, stable permission **keys** (`d1:read`) mapped to the Cloudflare
 * account **permission-group display names** they grant (`"D1 Read"`). Token profiles are declared in
 * these keys, so the profiles read cleanly and the CF-specific names live in one place. The names are
 * resolved to permission-group **ids** against the live account at mint time
 * (`CloudflareAccountTokensManager.resolvePermissionGroups`), which fails loudly on an unknown or
 * ambiguous name — so a name that drifts from Cloudflare's catalog is caught at mint, never silently
 * mis-scoped. Verify the exact names against the account when adding a key; an adopter can override a
 * profile's keys if their account differs.
 */
export const PERMISSION_GROUPS = {
  "d1:read": ["D1 Read"],
  // "D1 Write", not "D1 Edit" — Cloudflare names the D1 group Write while several other services use
  // Edit, and the account catalog has no group called "D1 Edit" at all. `accountTokensManager.integration.test.ts`
  // now checks every name here against the live account, which is the only place that can tell.
  "d1:write": ["D1 Write"],
  "workers:write": ["Workers Scripts Write"],
  "secrets:read": ["Secrets Store Read"],
  "secrets:write": ["Secrets Store Write"],
  "email:routing": ["Email Routing Rules Write"],
  "kv:write": ["Workers KV Storage Write"],
  "r2:read": ["Workers R2 Storage Read"],
  "r2:write": ["Workers R2 Storage Write"],
  "vectorize:read": ["Vectorize Read"],
  "vectorize:write": ["Vectorize Write"],
  "ai:read": ["Workers AI Read"],
  // Read-only, and read-only is the whole point: Pithy attaches routes to zones and never creates,
  // transfers, or deletes one — a zone is the adopter's relationship with their registrar. This exists
  // so `pithy init` and `pithy worker add` can offer the account's real zones instead of asking someone
  // to paste an id off a dashboard page.
  "zone:read": ["Zone Read"],
  // *Attaching* the route, which is the other half of the sentence above and the half nothing could do
  // (#651). `pithy deploy` of an environment with a declared domain calls
  // `POST /zones/<zone>/workers/routes`, and no group in this catalog reached it — a `ci-system` token
  // met "No access to the specified resource" on the first CI deploy that served a custom domain.
  //
  // **Zone-scoped**, and therefore listed in {@link ZONE_SCOPED_PERMISSIONS}: Cloudflare publishes this
  // group under `com.cloudflare.api.account.zone`, so a token carrying it needs a *zone* resource, and
  // the account resource every other key here uses grants it nothing. Which zones is not a choice —
  // it is the project's declared `domains`, resolved at mint time.
  //
  // Still not a group that can alter a zone. "Workers Routes Write" writes routes on a zone; changing
  // the zone itself would be "Zone Write", which this catalog does not have and will not get.
  //
  // Only this group is zone-limited. "Workers Scripts Write" is account-scoped and attaches a custom
  // domain — a proxied DNS record and a certificate — on any zone the account holds (measured, #709;
  // docs/TOKENS.md). So a token carrying the base can reach every zone's hostnames whatever this scopes.
  "routes:write": ["Workers Routes Write"],
  // **Reading the account's analytics, and nothing else (#728).** The GraphQL Analytics API's account-level
  // datasets — Stream minutes viewed, Images delivered — answer to this group. Cloudflare also has
  // "Analytics Read", which is the **zone** group and reaches none of them.
  //
  // A second credential class for the kit: every other key here acts on resources the project owns,
  // and this one reads the Cloudflare account. Its grain is the whole account, never one environment, so
  // a capability reading it narrows the answer itself — media joins it to this environment's own assets.
  "analytics:read": ["Account Analytics Read"],
  // **Media's Cloudflare products, so the catalog can mint what an operator used to make by hand (#728).**
  // A direct upload, a signing change and a delete on Cloudflare Images and on Stream. Both groups are
  // account-scoped and edit only the account's Images and Stream libraries; they are carried by the one
  // `runtime` token a deployed application holds, never by `ci-system`.
  "images:write": ["Images Write"],
  "stream:write": ["Stream Write"],
  // **Creating and deleting the queue behind a `queue` binding (#662).** `pithy provision` creates one per
  // binding and `pithy feature destroy` deletes a feature's, so `ci-system` carries it wherever a composition
  // binds a queue. A Worker sends through its producer binding and needs no API token for it.
  "queues:write": ["Queues Write"],
  // **Listing and deleting the repos in a feature's Artifacts namespace (#673).** `pithy feature destroy` reaps them,
  // because a repo costs storage and nothing else deletes one, so `ci-system` carries it wherever a composition binds
  // `artifacts`. A Worker creates, reads and mints through its binding and needs no API token for any of it.
  "artifacts:write": ["Artifacts Write"],
} as const;

/** A known permission key — one of {@link PERMISSION_GROUPS}'s keys. */
export type PermissionKey = keyof typeof PERMISSION_GROUPS;

/**
 * **The third column: the OAuth scope each key needs a signed-in session to hold (#759).**
 *
 * A session mints only what it could do itself. Cloudflare refuses a mint whose permission groups the
 * session's scopes do not cover — *"The OAuth session does not include the scopes required for the
 * requested permission groups"*, measured 2026-10-15 — so the scopes `pithy cloudflare connect` asks for
 * are derived from the permissions the project's tokens carry, through this table, and never listed by
 * hand. `satisfies` over {@link PermissionKey} makes a key added above without a scope here a type error.
 *
 * **The ids pair with the group names one to one.** `GET /oauth/scopes` names each scope exactly as the
 * permission group it grants — `d1.write` is "D1 Write", `workers-routes.write` is "Workers Routes Write" —
 * which is what lets the integration test check this column against Cloudflare's own catalog the way
 * the group names are checked against the account. A write scope also covers its read: a session holding
 * `d1.write` minted a "D1 Read" token, so a key never needs both.
 *
 * Dot-delimited, always. The colon form (`account:read`) is what a first-party client like wrangler asks
 * for, and a third-party client can neither register one nor request it.
 */
export const OAUTH_SCOPES = {
  "d1:read": ["d1.read"],
  "d1:write": ["d1.write"],
  "workers:write": ["workers-scripts.write"],
  "secrets:read": ["secrets-store.read"],
  "secrets:write": ["secrets-store.write"],
  "email:routing": ["email-routing-rule.write"],
  "kv:write": ["workers-kv-storage.write"],
  "r2:read": ["workers-r2.read"],
  "r2:write": ["workers-r2.write"],
  "vectorize:read": ["vectorize.read"],
  "vectorize:write": ["vectorize.write"],
  "ai:read": ["ai.read"],
  "zone:read": ["zone.read"],
  "routes:write": ["workers-routes.write"],
  "analytics:read": ["account-analytics.read"],
  "images:write": ["images.write"],
  "stream:write": ["stream.write"],
  "queues:write": ["queues.write"],
  "artifacts:write": ["artifacts.write"],
} as const satisfies Record<PermissionKey, readonly string[]>;

/**
 * Resolve permission keys to the OAuth scopes a session needs to act — or mint — with them, de-duped in
 * first-seen order. An unknown key is refused exactly as {@link resolvePermissionKeys} refuses it.
 */
export function oauthScopesFor(keys: readonly string[]): string[] {
  resolvePermissionKeys([...keys]);
  const scopes: string[] = [];
  for (const key of keys) {
    for (const scope of OAUTH_SCOPES[key as PermissionKey]) {
      if (!scopes.includes(scope)) scopes.push(scope);
    }
  }
  return scopes;
}

/**
 * The keys whose Cloudflare permission group is **zone-scoped**: a policy carrying one must name zone
 * resources (`com.cloudflare.api.account.zone.<id>`), never the account resource.
 *
 * A minted token's resources are account-scoped by default, which is why this distinction has to be
 * stated rather than inferred: hand a zone-level group the account resource and Cloudflare accepts the
 * token and refuses the call, which is exactly the failure #651 opened with. The zones themselves are
 * never picked by hand — they are the zones the project's declared domains sit in.
 */
export const ZONE_SCOPED_PERMISSIONS: readonly PermissionKey[] = ["routes:write"];

/** Narrow an arbitrary string to a {@link PermissionKey}. */
export function isPermissionKey(key: string): key is PermissionKey {
  return key in PERMISSION_GROUPS;
}

/** Whether a key's permission group is zone-scoped — see {@link ZONE_SCOPED_PERMISSIONS}. */
export function isZoneScopedPermission(key: string): boolean {
  return (ZONE_SCOPED_PERMISSIONS as readonly string[]).includes(key);
}

/**
 * Resolve permission keys to the CF permission-group display names they grant, de-duped in first-seen
 * order. An unknown key fails with an actionable error naming the valid keys — caught at the CLI/config
 * boundary before any CF call.
 */
export function resolvePermissionKeys(keys: string[]): string[] {
  const names: string[] = [];
  for (const key of keys) {
    if (!isPermissionKey(key)) {
      throw new CloudflareNotConfiguredError({
        message: `Unknown token permission key: ${key}.`,
        action: `Use one of: ${Object.keys(PERMISSION_GROUPS).join(", ")}.`,
        detail: `resolve permission keys: ${key} is not in the permission catalog`,
      });
    }
    for (const name of PERMISSION_GROUPS[key]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}
