// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds } from "../test-utils/harness";
import { OAUTH_SCOPES, PERMISSION_GROUPS, type PermissionKey } from "../tokens/permissions";
import { listOAuthScopes } from "./catalog";
import { SENSITIVE_SCOPES, SESSION_BASE_SCOPES } from "./scopes";

/**
 * LIVE: the third column of the permission table, checked against Cloudflare's own catalog (#759) — the
 * way `accountTokensManager.integration.test.ts` checks the group names against the account. A scope id
 * that drifts is a sign-in refused with `invalid_scope` at an adopter's consent screen, so it is caught
 * here instead. Read-only; gated on the integration credentials, and skips clean without them.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("OAuth scopes — LIVE against GET /oauth/scopes", () => {
  test("every scope a session can request is in the catalog", async () => {
    const catalog = new Map((await listOAuthScopes({ apiToken: creds.apiToken })).map((scope) => [scope.id, scope]));
    // `offline_access` is a protocol scope, not a catalog entry: Cloudflare adds it for a client with the
    // refresh grant, and the catalog lists only permission scopes.
    const requestable = [...SESSION_BASE_SCOPES, ...Object.values(OAUTH_SCOPES).flat()].filter(
      (id) => id !== "offline_access",
    );
    expect(requestable.filter((id) => !catalog.has(id))).toEqual([]);
  });

  test("each key's scope is named exactly as its permission group, so the two columns pair one to one", async () => {
    const catalog = new Map(
      (await listOAuthScopes({ apiToken: creds.apiToken })).map((scope) => [scope.id, scope.name]),
    );
    const mismatched = (Object.keys(OAUTH_SCOPES) as PermissionKey[]).flatMap((key) =>
      OAUTH_SCOPES[key]
        .map((id) => ({ key, id, scope: catalog.get(id), groups: [...PERMISSION_GROUPS[key]] as string[] }))
        .filter(({ scope, groups }) => scope === undefined || !groups.includes(scope)),
    );
    expect(mismatched).toEqual([]);
  });

  test("every sensitive scope is named as the consent screen names it", async () => {
    const catalog = new Map(
      (await listOAuthScopes({ apiToken: creds.apiToken })).map((scope) => [scope.id, scope.name]),
    );
    for (const [id, name] of Object.entries(SENSITIVE_SCOPES)) expect(catalog.get(id), id).toBe(name);
  });
});
