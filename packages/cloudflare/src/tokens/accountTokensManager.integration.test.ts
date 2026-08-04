// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { accountResource, CloudflareAccountTokensManager } from "./accountTokensManager";
import { PERMISSION_GROUPS } from "./permissions";

/**
 * LIVE test for the account-token control plane against a real Cloudflare account. It mints a real,
 * least-privilege token (Secrets Store Read + Write), confirms it came back with a value and is
 * findable by name, then deletes it — `withThrowawayResource` guarantees the delete runs even on a
 * failed assertion, so a real token is never orphaned. Gated on CF creds in `.dev.vars`; skips clean
 * without them. The bootstrap token must carry "Account API Tokens Write" for this to pass.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareAccountTokensManager — LIVE mint + delete", () => {
  const manager = new CloudflareAccountTokensManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("resolves the Secrets Store permission groups", async () => {
    const resolved = await manager.resolvePermissionGroups(["Secrets Store Read", "Secrets Store Write"]);
    expect(resolved).toHaveLength(2);
    for (const ref of resolved) expect(ref.id).toMatch(/^[0-9a-f]{32}$/);
  }, 30_000);

  test("every name in the permission catalog exists in the account, exactly once", async () => {
    // The catalog is a hand-written map of our keys to Cloudflare's *display names*, and nothing local
    // can tell that a name has drifted — `resolvePermissionKeys` happily returns a name that does not
    // exist, and the mint fails much later, at `resolvePermissionGroups`. `d1:write` shipped as
    // "D1 Edit" for exactly this reason: no group by that name, so `pithy token mint ci-system` threw
    // on the one profile every CI pipeline runs under. Only the live account can settle it. Ambiguity
    // is a failure too — Cloudflare reuses display names across scopes, and a name mapping to two ids
    // cannot be resolved without silently picking the wrong scope.
    const live = await manager.listPermissionGroups();
    const counts = new Map<string, number>();
    for (const group of live) counts.set(group.name, (counts.get(group.name) ?? 0) + 1);

    const drifted = Object.entries(PERMISSION_GROUPS).flatMap(([key, names]) =>
      names
        .filter((name) => counts.get(name) !== 1)
        .map((name) => `${key} -> "${name}" (${counts.get(name) ?? 0} matches)`),
    );
    expect(drifted).toEqual([]);
  }, 30_000);

  test("mints a scoped token, finds it by name, then deletes it", async () => {
    const name = uniqueName("token");

    await withThrowawayResource(
      () =>
        manager.mintToken(name, [
          {
            permissionGroupNames: ["Secrets Store Read", "Secrets Store Write"],
            resources: accountResource(creds.accountId),
          },
        ]),
      async (minted) => {
        expect(minted.id).toMatch(/^[0-9a-f]{32}$/);
        expect(minted.value.length).toBeGreaterThan(0);
        const found = await manager.findTokenByName(name);
        expect(found?.id).toBe(minted.id);
      },
      (minted) => manager.deleteToken(minted.id),
    );

    // The token is gone after teardown.
    expect(await manager.findTokenByName(name)).toBeNull();
  }, 30_000);

  test("rollToken rolls an existing token's value in place (same id, fresh secret)", async () => {
    const name = uniqueName("roll");
    const permissions = [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource(creds.accountId) }];
    try {
      const first = await manager.mintToken(name, permissions);
      const rolled = await manager.rollToken(name, permissions);
      // Same token, regenerated secret — not a new token.
      expect(rolled.id).toBe(first.id);
      expect(rolled.value).not.toBe(first.value);
      expect((await manager.findTokenByName(name))?.id).toBe(first.id);
    } finally {
      await manager.deleteTokensByName(name);
    }
    expect(await manager.findTokenByName(name)).toBeNull();
  }, 30_000);
});
