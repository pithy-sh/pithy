// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import { describe, expect, test, vi } from "vitest";
import type { WorkerConfig } from "../project/config";
import { declaredRouteZones, resolveRouteZones, routeZoneIds } from "./routeZones";

/** A Worker config carrying just the `domains` block this reader asks for. */
function worker(name: string, domains?: unknown): { name: string; config: WorkerConfig } {
  return { name, config: { capabilities: [], ...(domains === undefined ? {} : { domains }) } as WorkerConfig };
}

const ZONES: ZoneInfo[] = [
  { id: "zone-example", name: "example.com", status: "active" },
  { id: "zone-eu", name: "eu.example.com", status: "active" },
];

/** The zone read, counted — a project declaring no domain must not make the call at all. */
function directory(zones: ZoneInfo[] = ZONES) {
  const listZones = vi.fn(async () => zones);
  return { listZones };
}

describe("declaredRouteZones", () => {
  test("one entry per Worker declaring a domain for this environment", () => {
    const workers = [
      worker("api", { staging: { pattern: "staging.api.example.com", zone: "example.com" } }),
      worker("web", { staging: { pattern: "staging.example.com", zone: "example.com" } }),
    ];
    expect(declaredRouteZones(workers, "staging")).toEqual([
      { worker: "api", domain: "staging.api.example.com", zone: "example.com" },
      { worker: "web", domain: "staging.example.com", zone: "example.com" },
    ]);
  });

  test("a Worker declaring no domains declares no zone", () => {
    expect(declaredRouteZones([worker("api")], "staging")).toEqual([]);
  });

  test("a domain declared for another environment is not this environment's", () => {
    const workers = [worker("api", { prod: { pattern: "api.example.com", zone: "example.com" } })];
    expect(declaredRouteZones(workers, "staging")).toEqual([]);
    expect(declaredRouteZones(workers, "prod")).toEqual([
      { worker: "api", domain: "api.example.com", zone: "example.com" },
    ]);
  });
});

describe("resolveRouteZones", () => {
  test("resolves each declared zone to the id the account holds it under", async () => {
    const zones = directory();
    const resolved = await resolveRouteZones(
      [{ worker: "api", domain: "staging.api.eu.example.com", zone: "eu.example.com" }],
      zones,
    );
    expect(resolved).toEqual([
      { worker: "api", domain: "staging.api.eu.example.com", zone: "eu.example.com", zoneId: "zone-eu" },
    ]);
  });

  test("two Workers on one zone resolve to one zone id", async () => {
    const resolved = await resolveRouteZones(
      [
        { worker: "api", domain: "staging.api.example.com", zone: "example.com" },
        { worker: "web", domain: "staging.example.com", zone: "example.com" },
      ],
      directory(),
    );
    expect(routeZoneIds(resolved)).toEqual(["zone-example"]);
  });

  test("nothing declared reads no zones at all — the mint is byte-for-byte what it was", async () => {
    const zones = directory();
    expect(await resolveRouteZones([], zones)).toEqual([]);
    expect(zones.listZones).not.toHaveBeenCalled();
  });

  test("a zone the account does not hold fails the mint, naming the domain and the zone", async () => {
    // Loudly, and here — a token minted without the zone deploys green and fails at
    // `POST /zones/<zone>/workers/routes` hours later, with nothing in the error naming the domain.
    const failure = await resolveRouteZones(
      [{ worker: "api", domain: "staging.api.other.com", zone: "other.com" }],
      directory(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CloudflareNotConfiguredError);
    const payload = (failure as CloudflareNotConfiguredError).payload;
    expect(payload.message).toContain("staging.api.other.com");
    expect(payload.message).toContain("other.com");
    expect(payload.action).toMatch(/zone/i);
  });

  test("a zone matched by suffix rather than by name is not a match", async () => {
    // `notexample.com` ends with the same letters and is a different registrable domain.
    await expect(
      resolveRouteZones([{ worker: "api", domain: "api.notexample.com", zone: "notexample.com" }], directory()),
    ).rejects.toBeInstanceOf(CloudflareNotConfiguredError);
  });
});

describe("routeZoneIds", () => {
  test("is de-duped and stable, so one declaration order cannot mint a different policy", () => {
    expect(
      routeZoneIds([
        { worker: "web", domain: "b.example.com", zone: "example.com", zoneId: "zone-b" },
        { worker: "api", domain: "a.example.com", zone: "example.com", zoneId: "zone-a" },
        { worker: "job", domain: "c.example.com", zone: "example.com", zoneId: "zone-b" },
      ]),
    ).toEqual(["zone-a", "zone-b"]);
  });
});
