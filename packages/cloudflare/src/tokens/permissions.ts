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
} as const;

/** A known permission key — one of {@link PERMISSION_GROUPS}'s keys. */
export type PermissionKey = keyof typeof PERMISSION_GROUPS;

/** Narrow an arbitrary string to a {@link PermissionKey}. */
export function isPermissionKey(key: string): key is PermissionKey {
  return key in PERMISSION_GROUPS;
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
