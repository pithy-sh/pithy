// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { fixtureReady, fixtureValue } from "../test-utils/fixtures";
import {
  INTEGRATION_COMPATIBILITY_DATE,
  loadIntegrationCreds,
  uniqueName,
  withThrowawayResource,
} from "../test-utils/harness";
import { CloudflareWorkersManager } from "../workers/workersManager";
import { CloudflareZonesManager } from "../zones/zonesManager";
import { accountResource, CloudflareAccountTokensManager } from "./accountTokensManager";
import { PERMISSION_GROUPS } from "./permissions";
import {
  CI_SYSTEM_PROFILE,
  profilePermissions,
  resolveProfile,
  resolveTokenProfiles,
  routePermissions,
} from "./profiles";

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

/**
 * LIVE — **the deploy step that writes a route, under a token this kit minted** (#651).
 *
 * `pithy deploy --env staging` of a Worker with a declared domain ends in
 * `POST /zones/<zone>/workers/routes`. Under a `ci-system` token that call answered "No access to the
 * specified resource", because the token carried one account-scoped policy and Cloudflare publishes the
 * Workers Routes group at *zone* scope — so the grant was unreachable from an account resource, and no
 * CI deploy of a custom domain could ever work.
 *
 * Three facts decide whether the fix is a fix, and **not one of them is knowable locally**: whether the
 * group is named "Workers Routes Write" in this account's catalog, whether Cloudflare accepts an
 * account policy and a zone policy on one token, and whether the resulting credential can actually make
 * the call. So both shapes are minted here — the token as it was, and the token as it is — and each is
 * pointed at a real route write. **The old shape must be refused**: a suite that only proved the new one
 * works would pass just as happily against a token scoped to every zone on the account.
 *
 * Every resource is reserved-namespace and torn down in `finally`. A Workers route is not a DNS record,
 * so the throwaway pattern serves nothing while it exists.
 */
describe.skipIf(!creds.hasCreds || !fixtureReady("workers-route-zone"))(
  "ci-system route scope — LIVE mint + route write",
  () => {
    const config = { accountId: creds.accountId, apiToken: creds.apiToken };
    const tokens = new CloudflareAccountTokensManager(config);
    const zones = new CloudflareZonesManager(config);
    const bootstrapWorkers = new CloudflareWorkersManager(config);
    const zoneName = fixtureValue("workers-route-zone", "WORKERS_ROUTE_ZONE");

    test("the zone-scoped token attaches the route; the account-only token it replaces cannot", async () => {
      // Resolved by name against the account's own list — the same lookup `resolveRouteZones` makes from
      // a Worker's declared `domains`, so a fixture naming a zone this account does not hold fails here
      // exactly as a mint would.
      const zone = (await zones.listZones()).find((candidate) => candidate.name === zoneName);
      if (!zone) throw new Error(`WORKERS_ROUTE_ZONE names ${zoneName}, which this account does not hold.`);

      // The real `ci-system` account policy, from the real profile — never a copy of today's keys.
      const accountPolicy = profilePermissions(
        resolveProfile(resolveTokenProfiles([]), CI_SYSTEM_PROFILE),
        creds.accountId,
      );
      const beforeName = uniqueName("ci-before");
      const afterName = uniqueName("ci-after");
      const script = uniqueName("route");
      const pattern = `${script}.${zoneName}/*`;

      let routeId: string | null = null;
      try {
        const before = await tokens.mintToken(beforeName, accountPolicy);
        const after = await tokens.mintToken(afterName, [...accountPolicy, ...routePermissions([zone.id])]);

        // The deploy, under the minted credential: upload the script, then attach its route.
        const afterWorkers = new CloudflareWorkersManager({ accountId: creds.accountId, apiToken: after.value });
        await afterWorkers.createWorker(script, INTEGRATION_COMPATIBILITY_DATE);

        // The token as it was. This is the refusal #651 reported, asserted rather than assumed.
        const beforeWorkers = new CloudflareWorkersManager({ accountId: creds.accountId, apiToken: before.value });
        await expect(beforeWorkers.addRoute(zone.id, pattern, script)).rejects.toThrow();

        // The token as it is.
        await afterWorkers.addRoute(zone.id, pattern, script);
        const written = await bootstrapWorkers.getRoute(zone.id, pattern);
        expect(written?.script).toBe(script);
        routeId = written?.id ?? null;
      } finally {
        // Bootstrap credentials for every teardown: the minted tokens may already be gone, and a leaked
        // route or script is a live change on somebody's zone.
        if (routeId) await bootstrapWorkers.removeRoute(zone.id, routeId).catch(() => {});
        await bootstrapWorkers.deleteWorker(script).catch(() => {});
        await tokens.deleteTokensByName(beforeName);
        await tokens.deleteTokensByName(afterName);
      }
    }, 120_000);
  },
);
