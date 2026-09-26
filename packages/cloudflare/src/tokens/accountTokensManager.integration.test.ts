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
 * LIVE — **the two calls a deploy of a declared domain makes, under a token this kit minted** (#651).
 *
 * `pithy deploy --env staging` of a Worker whose `pithy.config.ts` declares `domains` runs wrangler over
 * a `routes` entry carrying `custom_domain: true`, and that is **two** endpoints, not one:
 *
 * - `GET /zones/<zone>/workers/routes` — wrangler reconciles the zone's route list. **Zone-scoped**, and
 *   the call that actually failed: `No access to the specified resource`, because the minted token
 *   carried one account-scoped policy and Cloudflare publishes the Workers Routes groups at zone scope.
 * - `PUT /accounts/<id>/workers/domains` — the custom domain itself. **Account-scoped**, and its
 *   accepted permission is `Workers Scripts Write`, which `ci-system` has carried all along.
 *
 * So the zone grant is what unblocks the reported failure, and the custom-domain write was never the
 * thing that was missing. Both are exercised here because a suite that covered only the zone route would
 * pass green through a regression on the endpoint the deploy actually attaches the domain with — and one
 * that covered only the domain would not have caught #651 at all.
 *
 * Three facts decide whether the fix is a fix, and **not one of them is knowable locally**: whether the
 * group is named "Workers Routes Write" in this account's catalog, whether Cloudflare accepts an account
 * policy and a zone policy on one token, and whether the resulting credential can make the calls. So
 * both token shapes are minted — the token as it was, and the token as it is — and each is pointed at the
 * zone read. **The old shape must be refused**: a suite that only proved the new one works would pass
 * just as happily against a token scoped to every zone on the account.
 *
 * **Teardown runs unconditionally and finds what it deletes.** Every step is independently caught, the
 * route is looked up by its pattern rather than by an id captured after the assertions, and the custom
 * domain is looked up by hostname — so the paths where an assertion fails part-way, including the
 * regression this suite exists to catch, still leave the account clean. A leaked route or custom domain
 * is a live change on somebody's zone; a leaked token is a live credential.
 */
describe.skipIf(!creds.hasCreds || !fixtureReady("workers-route-zone"))(
  "ci-system route scope — LIVE mint + deploy of a declared domain",
  () => {
    const config = { accountId: creds.accountId, apiToken: creds.apiToken };
    const tokens = new CloudflareAccountTokensManager(config);
    const zones = new CloudflareZonesManager(config);
    const bootstrapWorkers = new CloudflareWorkersManager(config);
    const zoneName = fixtureValue("workers-route-zone", "WORKERS_ROUTE_ZONE");

    /** The account-scoped custom-domain endpoint, by hand, so the test names the call it is about. */
    const domainsUrl = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/workers/domains`;
    async function attachCustomDomain(apiToken: string, hostname: string, service: string, zoneId: string) {
      return fetch(domainsUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hostname, service, zone_id: zoneId }),
      });
    }
    async function customDomainId(hostname: string): Promise<string | null> {
      const response = await fetch(`${domainsUrl}?hostname=${encodeURIComponent(hostname)}`, {
        headers: { Authorization: `Bearer ${creds.apiToken}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { result?: Array<{ id?: string }> };
      return body.result?.[0]?.id ?? null;
    }

    /**
     * The route on the zone, polled until the zone's route list shows it.
     *
     * **Because the alternative leaks.** A single read that answers `null` on a list Cloudflare has not
     * finished propagating fails the assertion *and* tells the teardown there is nothing to delete — so
     * the one run where the API is slow leaves a real route on a real zone. Polling makes both the
     * check and the cleanup read the same settled answer. Errors are swallowed between attempts: a
     * transient 500 on the way to finding a route is not evidence the route is absent.
     */
    async function settledRoute(workers: CloudflareWorkersManager, zoneId: string, pattern: string) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const found = await workers.getRoute(zoneId, pattern).catch(() => null);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return null;
    }

    test("the zone-scoped token reads the zone's routes and attaches the domain; the token it replaces cannot", async () => {
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
      const hostname = `${script}.${zoneName}`;
      const pattern = `${hostname}/*`;

      try {
        const before = await tokens.mintToken(beforeName, accountPolicy);
        const after = await tokens.mintToken(afterName, [...accountPolicy, ...routePermissions([zone.id])]);
        const beforeWorkers = new CloudflareWorkersManager({ accountId: creds.accountId, apiToken: before.value });
        const afterWorkers = new CloudflareWorkersManager({ accountId: creds.accountId, apiToken: after.value });

        // The deploy, under the minted credential: upload the script first, as wrangler does.
        await afterWorkers.createWorker(script, INTEGRATION_COMPATIBILITY_DATE);

        // 1. The zone route read. This is the refusal #651 reported, asserted rather than assumed.
        await expect(beforeWorkers.getRoute(zone.id, pattern)).rejects.toThrow();
        expect(await afterWorkers.getRoute(zone.id, pattern)).toBeNull();

        // 2. The zone route write.
        await expect(beforeWorkers.addRoute(zone.id, pattern, script)).rejects.toThrow();
        await afterWorkers.addRoute(zone.id, pattern, script);
        expect((await settledRoute(bootstrapWorkers, zone.id, pattern))?.script).toBe(script);

        // 3. The custom domain — account-scoped, on `Workers Scripts Write`, which BOTH tokens hold.
        //    Asserted as working under the minted token, and deliberately not asserted as refused under
        //    the old one: it was never the missing grant, and claiming otherwise here would be a test
        //    that lies about what #651 was.
        const attached = await attachCustomDomain(after.value, hostname, script, zone.id);
        expect(attached.ok, `PUT /accounts/<id>/workers/domains answered ${attached.status}`).toBe(true);
        expect(await customDomainId(hostname)).not.toBeNull();
      } finally {
        // Unconditional, independently caught, and it *finds* what it deletes — nothing here depends on
        // a variable an earlier assertion may never have reached. Each step is its own `attempt`, so a
        // rate limit on one cannot skip the ones after it, and whatever could not be removed is named on
        // stderr rather than swallowed: a leaked route or custom domain is a live change on somebody's
        // zone, and a leaked token is a live credential.
        const leaks: string[] = [];
        const attempt = async (what: string, run: () => Promise<unknown>): Promise<void> => {
          try {
            await run();
          } catch (error) {
            leaks.push(`${what} — ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        await attempt(`custom domain ${hostname}`, async () => {
          const domainId = await customDomainId(hostname);
          if (!domainId) return;
          const deleted = await fetch(`${domainsUrl}/${domainId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${creds.apiToken}` },
          });
          if (!deleted.ok) throw new Error(`DELETE answered ${deleted.status}`);
        });
        await attempt(`worker route ${pattern}`, async () => {
          const route = await settledRoute(bootstrapWorkers, zone.id, pattern);
          if (route?.id) await bootstrapWorkers.removeRoute(zone.id, route.id);
        });
        await attempt(`worker ${script}`, () => bootstrapWorkers.deleteWorker(script));
        await attempt(`account token ${beforeName}`, () => tokens.deleteTokensByName(beforeName));
        await attempt(`account token ${afterName}`, () => tokens.deleteTokensByName(afterName));
        if (leaks.length > 0) {
          console.error(
            `[integration] LEAKED on account ${creds.accountId} — delete by hand:\n  ${leaks.join("\n  ")}`,
          );
        }
      }
    }, 180_000);
  },
);
