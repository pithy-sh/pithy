// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeEmailRoutingApi, type FakeZone, startFakeEmailRoutingApi } from "../test-utils/fakeEmailRoutingApi";
import { CloudflareZonesManager } from "../zones/zonesManager";
import { CloudflareEmailRoutingManager } from "./emailRoutingManager";

/**
 * Routing one exact address to a Worker, over the real SDK transport against a fake of the API's zones and Email
 * Routing endpoints. The fake answers in the live shapes, the catch-all rule included.
 */

const ACCOUNT = "acct-1";

let api: FakeEmailRoutingApi;

const ZONES: FakeZone[] = [
  { id: "zone-apex", name: "example.com", zoneRouting: true, routedSubdomains: ["help.example.com"] },
  { id: "zone-other", name: "other.test", zoneRouting: false, routedSubdomains: ["help.other.test"] },
  { id: "zone-array", name: "array.test", zoneRouting: true, routedSubdomains: ["help.array.test"], dnsShape: "array" },
  { id: "zone-null", name: "null.test", zoneRouting: true, routedSubdomains: ["help.null.test"], dnsShape: "null" },
];

async function start(
  options: Parameters<typeof startFakeEmailRoutingApi>[0]["rules"] = {},
  zones: FakeZone[] = ZONES,
): Promise<void> {
  api = await startFakeEmailRoutingApi({ accountId: ACCOUNT, zones, rules: options });
  vi.stubEnv("CLOUDFLARE_BASE_URL", api.baseUrl);
}

function routing(): CloudflareEmailRoutingManager {
  return new CloudflareEmailRoutingManager({ accountId: ACCOUNT, apiToken: "tok" });
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await api?.close();
});

describe("routingEnabledFor", () => {
  const check = (zoneId: string, zoneName: string, domain: string) =>
    routing().routingEnabledFor({ zoneId, zoneName, domain });

  it("passes a subdomain only when the zone's routing is on and its DNS check lists nothing missing", async () => {
    await start();
    expect(await check("zone-apex", "example.com", "help.example.com")).toEqual({ enabled: true });
    expect(api.requests).toContain("GET /client/v4/zones/zone-apex/email/routing");
    expect(api.requests).toContain("GET /client/v4/zones/zone-apex/email/routing/dns?subdomain=help.example.com");
  });

  it("refuses a subdomain the zone is missing records for", async () => {
    await start();
    expect(await check("zone-apex", "example.com", "mail.example.com")).toEqual({
      enabled: false,
      reason: "Email Routing is not enabled for mail.example.com: Cloudflare lists 1 missing record for it.",
    });
  });

  it("refuses a set-up subdomain on a zone whose own routing is off", async () => {
    await start();
    expect(await check("zone-other", "other.test", "help.other.test")).toEqual({
      enabled: false,
      reason: "Email Routing is not enabled on the other.test zone.",
    });
  });

  it("refuses a DNS check that answers with a bare record list, rather than reading it as a pass", async () => {
    await start();
    expect(await check("zone-array", "array.test", "help.array.test")).toMatchObject({ enabled: false });
  });

  it("refuses a DNS check whose result is null", async () => {
    await start();
    expect(await check("zone-null", "null.test", "help.null.test")).toEqual({
      enabled: false,
      reason: "Cloudflare's Email Routing DNS check for help.null.test did not say whether routing is set up for it.",
    });
  });

  it("answers for the apex from the zone's settings alone", async () => {
    await start();
    expect(await check("zone-apex", "example.com", "example.com")).toEqual({ enabled: true });
    expect(api.requests.some((request) => request.includes("/dns"))).toBe(false);
  });

  it("only reads: nothing it asks enables routing or touches DNS", async () => {
    await start();
    for (const zone of ZONES) await check(zone.id, zone.name, `help.${zone.name}`);
    expect(api.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("throws on a 403, which the caller turns into a refusal naming the permission", async () => {
    await start({}, [{ ...ZONES[0], forbidSettings: true } as FakeZone]);
    await expect(check("zone-apex", "example.com", "help.example.com")).rejects.toThrow();
  });
});

describe("routeAddressToWorker", () => {
  const route = {
    zoneId: "zone-apex",
    address: "support@help.example.com",
    workerName: "replay-prod-board",
    ruleName: "replay-prod-support-inbound",
  };

  it("creates an exact-address rule to the Worker when none matches the address", async () => {
    await start();
    expect(await routing().routeAddressToWorker(route)).toEqual({ outcome: "created" });
    const created = api.rules.get("zone-apex")?.find((rule) => rule.name === route.ruleName);
    expect(created).toMatchObject({
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@help.example.com" }],
      actions: [{ type: "worker", value: ["replay-prod-board"] }],
    });
  });

  it("leaves a rule that already sends the address to the Worker alone, whatever it is named", async () => {
    await start({
      "zone-apex": [
        {
          id: "by-hand",
          name: "made in the dashboard",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "Support@help.example.com" }],
          actions: [{ type: "worker", value: ["replay-prod-board"] }],
        },
      ],
    });
    expect(await routing().routeAddressToWorker(route)).toEqual({ outcome: "unchanged" });
    expect(api.requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });

  it("takes over the sole enabled rule for the address that sends it somewhere else", async () => {
    await start({
      "zone-apex": [
        {
          id: "stale",
          name: "replay-global-support-inbound",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "support@help.example.com" }],
          actions: [{ type: "worker", value: ["replay-board-prod"] }],
        },
      ],
    });
    expect(await routing().routeAddressToWorker(route)).toEqual({ outcome: "updated" });
    expect(api.rules.get("zone-apex")?.find((rule) => rule.id === "stale")).toMatchObject({
      name: "replay-global-support-inbound",
      enabled: true,
      actions: [{ type: "worker", value: ["replay-prod-board"] }],
    });
    expect(api.rules.get("zone-apex")).toHaveLength(2);
  });

  const claim = (id: string, worker: string, enabled = true) => ({
    id,
    name: id,
    enabled,
    matchers: [{ type: "literal", field: "to", value: "support@help.example.com" }],
    actions: [{ type: "worker", value: [worker] }],
  });

  it("is settled when every enabled rule claiming the address sends it to the Worker", async () => {
    await start({ "zone-apex": [claim("a", "replay-prod-board"), claim("b", "replay-prod-board")] });
    expect(await routing().routeAddressToWorker(route)).toEqual({ outcome: "unchanged" });
  });

  it("refuses, naming them, when several enabled rules claim the address and one sends it elsewhere", async () => {
    await start({ "zone-apex": [claim("a", "replay-prod-board"), claim("b", "someone-else")] });
    expect(await routing().routeAddressToWorker(route)).toEqual({ outcome: "conflict", rules: ["a", "b"] });
    expect(api.requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });

  it("leaves a disabled rule disabled and creates the enabled one beside it", async () => {
    await start({ "zone-apex": [claim("off", "someone-else", false)] });
    expect(await routing().routeAddressToWorker(route)).toEqual({ outcome: "created" });
    expect(api.rules.get("zone-apex")?.find((rule) => rule.id === "off")).toMatchObject({ enabled: false });
  });

  it("never treats the zone's catch-all as a rule for the address", async () => {
    await start();
    await routing().routeAddressToWorker(route);
    expect(api.rules.get("zone-apex")?.find((rule) => rule.name === "")).toMatchObject({ actions: [{ type: "drop" }] });
  });
});

describe("unrouteAddressFromWorker", () => {
  it("removes the rules sending the address to that Worker, and no other", async () => {
    await start({
      "zone-apex": [
        {
          id: "prod",
          name: "replay-prod-support-inbound",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "support@help.example.com" }],
          actions: [{ type: "worker", value: ["replay-prod-board"] }],
        },
        {
          id: "staging",
          name: "replay-staging-support-inbound",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "staging@help.example.com" }],
          actions: [{ type: "worker", value: ["replay-staging-board"] }],
        },
      ],
    });
    expect(
      await routing().unrouteAddressFromWorker({
        zoneId: "zone-apex",
        address: "staging@help.example.com",
        workerName: "replay-staging-board",
      }),
    ).toEqual({ removed: 1 });
    expect(api.rules.get("zone-apex")?.map((rule) => rule.id)).toEqual(["prod", "zone-apex-catch-all"]);
  });

  it("is a no-op when nothing routes the address to the Worker", async () => {
    await start();
    expect(
      await routing().unrouteAddressFromWorker({
        zoneId: "zone-apex",
        address: "support@help.example.com",
        workerName: "replay-prod-board",
      }),
    ).toEqual({ removed: 0 });
  });
});

describe("the zone an address lives in", () => {
  it("is found past the first page of a long zone list", async () => {
    const many: FakeZone[] = Array.from({ length: 60 }, (_, index) => ({
      id: `zone-${index}`,
      name: `filler-${String(index).padStart(2, "0")}.test`,
      zoneRouting: false,
      routedSubdomains: [],
    }));
    many.push({ id: "zone-late", name: "zz-late.test", zoneRouting: true, routedSubdomains: [] });
    await start({}, many);
    const zones = new CloudflareZonesManager({ accountId: ACCOUNT, apiToken: "tok" });
    expect(await zones.findActiveZoneForHostname("help.zz-late.test")).toMatchObject({ id: "zone-late" });
    expect(api.requests.filter((request) => request.startsWith("GET /client/v4/zones?")).length).toBeGreaterThan(2);
  });

  it("passes over a zone Cloudflare is not serving yet", async () => {
    await start({}, [
      { id: "zone-pending", name: "help.example.com", status: "pending", zoneRouting: true, routedSubdomains: [] },
      ...ZONES,
    ]);
    const zones = new CloudflareZonesManager({ accountId: ACCOUNT, apiToken: "tok" });
    expect(await zones.findActiveZoneForHostname("support.help.example.com")).toMatchObject({ id: "zone-apex" });
  });

  it("is the parent zone for a subdomain, found over the real zones list", async () => {
    await start();
    const zones = new CloudflareZonesManager({ accountId: ACCOUNT, apiToken: "tok" });
    expect(await zones.findZoneForHostname("help.example.com")).toMatchObject({ id: "zone-apex", name: "example.com" });
    expect(await zones.findZoneForHostname("help.nowhere.test")).toBeNull();
  });
});
