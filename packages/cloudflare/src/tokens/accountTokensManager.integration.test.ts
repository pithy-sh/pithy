// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { accountResource, CloudflareAccountTokensManager } from "./accountTokensManager";

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

  test("mints a scoped token, finds it by name, then deletes it", async () => {
    const name = uniqueName("pithy-int-token");

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
    const name = uniqueName("pithy-int-roll");
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
