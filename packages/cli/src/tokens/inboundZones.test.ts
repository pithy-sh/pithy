// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { activeZoneForHostname } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test, vi } from "vitest";
import { declaredInboundAddresses, resolveInboundZoneIds, routesInboundMail } from "./inboundZones";

const capability = (inboundRouting?: { addresses: string[] }) =>
  ({ name: "support", requiredBindings: [], ...(inboundRouting ? { inboundRouting } : {}) }) as unknown as Capability;

const ZONES = [
  { id: "z-apex", name: "example.com", status: "active" },
  { id: "z-eu", name: "eu.example.com", status: "active" },
  { id: "z-pending", name: "help.example.com", status: "pending" },
];

describe("inbound zones", () => {
  test("a capability routing mail with no address still routes inbound mail; one routing nothing does not", () => {
    expect(routesInboundMail([{ capabilities: [capability({ addresses: [] })] }])).toBe(true);
    expect(routesInboundMail([{ capabilities: [capability()] }])).toBe(false);
  });

  test("the addresses are every composed capability's, lowercased, once", () => {
    const workers = [
      { capabilities: [capability({ addresses: ["Support@help.example.com"] })] },
      { capabilities: [capability({ addresses: ["support@help.example.com", "ops@eu.example.com"] })] },
    ];
    expect(declaredInboundAddresses(workers)).toEqual(["support@help.example.com", "ops@eu.example.com"]);
  });

  test("each address resolves to the longest active zone holding its domain, sorted and de-duped", async () => {
    const zones = { findActiveZoneForHostname: vi.fn(async (host: string) => activeZoneForHostname(ZONES, host)) };
    expect(
      await resolveInboundZoneIds(
        ["support@help.example.com", "ops@mail.eu.example.com", "a@example.com", "x@nowhere.test"],
        zones,
      ),
    ).toEqual(["z-apex", "z-eu"]);
  });

  test("no address makes no zone call", async () => {
    const zones = { findActiveZoneForHostname: vi.fn(async (host: string) => activeZoneForHostname(ZONES, host)) };
    expect(await resolveInboundZoneIds([], zones)).toEqual([]);
    expect(zones.findActiveZoneForHostname).not.toHaveBeenCalled();
  });
});
