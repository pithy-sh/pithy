// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { describe, expect, test } from "vitest";
import type { DashboardClient } from "../dashboard/contract";
import type { ConnectionRegistry } from "../dashboard/registry";
import { clientFor } from "./dashboard";

/**
 * Which dashboard a command calls, and what happens to the row when a flag says somewhere else — `#614`.
 *
 * The bug Jim hit: `status --verify` with no `--origin` asked the hosted dashboard about a connection
 * registered against a self-hosted one, and reported the connection as needing reconnection.
 */

const NOW = new Date("2026-09-16T12:00:00.000Z");

const CONNECTION = {
  id: "9e4402e5-fe17-4a9f-9358-e90ab82409e0",
  environment: "staging",
  issuer: "https://staging.app.pithy.sh",
  workerUrl: "https://staging.app.pithy.sh",
  basePath: "/control-plane",
  managementOrigin: "https://staging.app.pithy.sh",
  scopes: [],
  keys: [],
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as ControlPlaneConnection;

/** A registry over one row, recording whatever is saved back to it. */
function registryOf(connection: ControlPlaneConnection | null) {
  const saved: ControlPlaneConnection[] = [];
  const registry: ConnectionRegistry = {
    read: async () => connection,
    save: async (next) => void saved.push(next),
    appendKey: async () => connection as ControlPlaneConnection,
    revokeKey: async () => connection,
    remove: async () => true,
    dispose: async () => {},
  };
  return { registry, saved };
}

/** The origins a run would have called, captured instead of built. */
function capturing() {
  const called: string[] = [];
  return {
    called,
    build: (origin: string): DashboardClient => {
      called.push(origin);
      return {} as DashboardClient;
    },
  };
}

describe("the dashboard a command calls", () => {
  test("is the one the connection was registered against, with no flag", async () => {
    const { registry } = registryOf(CONNECTION);
    const seam = capturing();

    const { resolved } = await clientFor(registry, {}, { build: seam.build, now: () => NOW });

    expect(seam.called).toEqual(["https://staging.app.pithy.sh"]);
    expect(resolved.source).toBe("recorded");
  });

  test("is the issuer for a connection registered before the origin was recorded", async () => {
    const older = { ...CONNECTION, managementOrigin: null } as unknown as ControlPlaneConnection;
    const { registry, saved } = registryOf(older);
    const seam = capturing();

    const { resolved } = await clientFor(registry, {}, { build: seam.build, now: () => NOW });

    expect(seam.called).toEqual(["https://staging.app.pithy.sh"]);
    expect(resolved.source).toBe("issuer");
    // Reading is not writing: a `status` that rewrote the row on every run would record a change nobody
    // made. The next `connect` is what records the observed origin.
    expect(saved).toEqual([]);
  });

  test("the flag overrides and re-points the row, because that is how a move is announced", async () => {
    const { registry, saved } = registryOf(CONNECTION);
    const seam = capturing();

    await clientFor(registry, { origin: "https://moved.example" }, { build: seam.build, now: () => NOW });

    expect(seam.called).toEqual(["https://moved.example"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.managementOrigin).toBe("https://moved.example");
    // Nothing else about the connection moved — this is an address, not a rotation.
    expect(saved[0]?.keys).toEqual(CONNECTION.keys);
    expect(saved[0]?.scopes).toEqual(CONNECTION.scopes);
  });

  test("a flag naming the address already recorded writes nothing", async () => {
    const { registry, saved } = registryOf(CONNECTION);
    const seam = capturing();

    await clientFor(registry, { origin: "https://staging.app.pithy.sh/" }, { build: seam.build, now: () => NOW });

    // A trailing slash is not a different dashboard, and a recorded change that did not happen is a lie
    // in the adopter's own audit trail.
    expect(saved).toEqual([]);
  });

  test("nothing registered reaches the hosted dashboard, which is where a first connect goes", async () => {
    const { registry } = registryOf(null);
    const seam = capturing();

    const { resolved } = await clientFor(registry, {}, { build: seam.build, now: () => NOW });

    expect(seam.called).toEqual(["https://app.pithy.sh"]);
    expect(resolved.source).toBe("default");
  });
});
