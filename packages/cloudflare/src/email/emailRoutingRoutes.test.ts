// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeEmailRoutingApi, startFakeEmailRoutingApi } from "../test-utils/fakeEmailRoutingApi";
import { CloudflareZonesManager } from "../zones/zonesManager";
import { CloudflareEmailRoutingManager } from "./emailRoutingManager";

/**
 * Routing one exact address to a Worker, over the real SDK transport against a fake of the API's zones and Email
 * Routing endpoints. The fake answers in the live shapes, the catch-all rule included.
 */

const ACCOUNT = "acct-1";

let api: FakeEmailRoutingApi;

async function start(options: Parameters<typeof startFakeEmailRoutingApi>[0]["rules"] = {}): Promise<void> {
  api = await startFakeEmailRoutingApi({
    accountId: ACCOUNT,
    zones: [
      { id: "zone-apex", name: "example.com", routingEnabled: ["help.example.com"] },
      { id: "zone-other", name: "other.test", routingEnabled: [] },
    ],
    rules: options,
  });
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
  it("answers for a subdomain from the zone's DNS check for that subdomain", async () => {
    await start();
    expect(
      await routing().routingEnabledFor({ zoneId: "zone-apex", zoneName: "example.com", domain: "help.example.com" }),
    ).toBe(true);
    expect(api.requests).toContain("GET /client/v4/zones/zone-apex/email/routing/dns?subdomain=help.example.com");
  });

  it("is false for a subdomain the zone is missing records for", async () => {
    await start();
    expect(
      await routing().routingEnabledFor({ zoneId: "zone-apex", zoneName: "example.com", domain: "mail.example.com" }),
    ).toBe(false);
  });

  it("answers for the apex from the zone's Email Routing settings", async () => {
    await start();
    expect(
      await routing().routingEnabledFor({ zoneId: "zone-apex", zoneName: "example.com", domain: "example.com" }),
    ).toBe(false);
    expect(api.requests).toContain("GET /client/v4/zones/zone-apex/email/routing");
  });

  it("only reads: nothing it asks enables routing or touches DNS", async () => {
    await start();
    await routing().routingEnabledFor({ zoneId: "zone-other", zoneName: "other.test", domain: "help.other.test" });
    expect(api.requests.every((request) => request.startsWith("GET "))).toBe(true);
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

  it("updates a rule for the address that sends it somewhere else", async () => {
    await start({
      "zone-apex": [
        {
          id: "stale",
          name: "replay-global-support-inbound",
          enabled: false,
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
  it("is the parent zone for a subdomain, found over the real zones list", async () => {
    await start();
    const zones = new CloudflareZonesManager({ accountId: ACCOUNT, apiToken: "tok" });
    expect(await zones.findZoneForHostname("help.example.com")).toMatchObject({ id: "zone-apex", name: "example.com" });
    expect(await zones.findZoneForHostname("help.nowhere.test")).toBeNull();
  });
});
