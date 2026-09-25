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
  "routes:write": ["Workers Routes Write"],
} as const;

/** A known permission key — one of {@link PERMISSION_GROUPS}'s keys. */
export type PermissionKey = keyof typeof PERMISSION_GROUPS;

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
