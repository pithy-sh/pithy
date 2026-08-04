// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { CloudflareZonesManager, ZoneInfo } from "./zonesManager";

/** A manager whose SDK is a stub returning `zones`, so listing logic is exercised with no network. */
function managerOver(zones: unknown[]): CloudflareZonesManager {
  const manager = new CloudflareZonesManager({ accountId: "acct", apiToken: "token" });
  // biome-ignore lint/suspicious/noExplicitAny: reaching one SDK surface on a stub, in a test.
  vi.spyOn(manager as any, "getClient").mockReturnValue({
    zones: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const zone of zones) yield zone;
        },
      }),
    },
  });
  return manager;
}

const ZONES = [
  { id: "z2", name: "eu.example.com", status: "active" },
  { id: "z1", name: "example.com", status: "active" },
  { id: "z3", name: "acme.test", status: "pending" },
];

describe("ZoneInfo", () => {
  it("decodes the fields a picker and a route both need", () => {
    expect(ZoneInfo.parse({ id: "z1", name: "example.com", status: "active", extra: 1 })).toEqual({
      id: "z1",
      name: "example.com",
      status: "active",
    });
  });
});

describe("listZones", () => {
  it("returns the account's zones, name-sorted so a picker is stable between runs", async () => {
    expect((await managerOver(ZONES).listZones()).map((zone) => zone.name)).toEqual([
      "acme.test",
      "eu.example.com",
      "example.com",
    ]);
  });

  it("keeps a non-active zone rather than hiding it", async () => {
    // A pending zone cannot carry a custom domain yet. Hiding it makes the account look like it does not
    // have the domain at all, which is the more confusing of the two failures — the picker says so instead.
    const zones = await managerOver(ZONES).listZones();
    expect(zones.find((zone) => zone.name === "acme.test")?.status).toBe("pending");
  });

  it("skips an entry that does not decode, rather than failing the whole listing", async () => {
    const zones = await managerOver([...ZONES, { id: "bad" }]).listZones();
    expect(zones).toHaveLength(3);
  });
});

describe("findZoneForHostname", () => {
  it("matches the longest zone, which is the only correct rule for nested zones", async () => {
    // An account can hold both `example.com` and `eu.example.com`. `api.eu.example.com` belongs to the
    // latter; taking the first match would attach the Worker to the wrong zone, and Cloudflare's error
    // names neither of the two values that disagree.
    const manager = managerOver(ZONES);
    expect((await manager.findZoneForHostname("api.eu.example.com"))?.name).toBe("eu.example.com");
    expect((await manager.findZoneForHostname("api.example.com"))?.name).toBe("example.com");
  });

  it("matches a hostname that is the zone apex itself", async () => {
    expect((await managerOver(ZONES).findZoneForHostname("example.com"))?.name).toBe("example.com");
  });

  it("returns null rather than guessing when no zone owns the hostname", async () => {
    // No public-suffix guess: a zone can itself be a subdomain, so the account's own list is the only
    // authority. Null lets the caller fall back to free text instead of proposing a zone that is not there.
    expect(await managerOver(ZONES).findZoneForHostname("api.somewhere-else.com")).toBeNull();
  });

  it("does not match a hostname that merely ends with the zone's characters", async () => {
    // `notexample.com` is not inside `example.com`. The dot in the suffix check is what makes that true.
    expect(await managerOver(ZONES).findZoneForHostname("notexample.com")).toBeNull();
  });
});

describe("validateServiceAccess", () => {
  it("is a read, and never throws", async () => {
    const manager = new CloudflareZonesManager({ accountId: "acct", apiToken: "token" });
    // biome-ignore lint/suspicious/noExplicitAny: reaching one SDK surface on a stub, in a test.
    vi.spyOn(manager as any, "getClient").mockReturnValue({
      zones: {
        list: () => {
          throw new Error("403");
        },
      },
    });
    await expect(manager.validateServiceAccess()).resolves.toBe(false);
  });
});
