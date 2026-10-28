// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import {
  fixtureConnection,
  fixtureKey,
  fixtureTrust,
  FIXTURE_NOW as NOW,
} from "@pithy-sh/core/src/test-utils/connectionFixtures";
import { describe, expect, test } from "vitest";
import { fakeConnectionRegistry } from "../test-utils/connectionRegistry";
import { expectConforms } from "../test-utils/payloadContract";
import {
  formatPrincipalConnections,
  formatPrincipalReport,
  formatRevocationPlan,
  formatRevoked,
  listPrincipalConnections,
  type OpenRegistry,
  revocable,
  revokePrincipalConnections,
} from "./connections";
import type { ConnectionRegistry } from "./registry";

const ADA = "ada@example.com";

/** One fake registry per environment, opened by name. */
function environments(rows: Record<string, ControlPlaneConnection | null>) {
  const registries = new Map<string, ReturnType<typeof fakeConnectionRegistry>>();
  for (const [environment, row] of Object.entries(rows)) registries.set(environment, fakeConnectionRegistry(row));
  const open: OpenRegistry = (environment, work) => work(registries.get(environment) as ConnectionRegistry);
  return { open, registries };
}

describe("listPrincipalConnections", () => {
  test("lists the principal's connections in every environment named, and the unattributed apart", async () => {
    const { open } = environments({
      staging: fixtureConnection({ environment: "staging" }),
      prod: fixtureConnection({ id: "3f2504e0-4f89-41d3-9a0c-0305e82c3309", authorizedBy: null }),
    });
    const found = await listPrincipalConnections({ principal: ADA, environments: ["staging", "prod"], open, now: NOW });
    expect(found.map((entry) => [entry.environment, entry.connections.length, entry.unattributed.length])).toEqual([
      ["staging", 1, 0],
      ["prod", 0, 1],
    ]);
    expect(found[0]?.connections[0]).toMatchObject({
      authorizedBy: ADA,
      actorKind: "agent",
      purpose: "Nightly audit summarizer.",
      credentialKind: "key",
      scopes: ["manifest:read"],
      live: true,
    });
  });
});

describe("revokePrincipalConnections", () => {
  test("revokes every live match, and never an unattributed connection", async () => {
    const unattributed = fixtureConnection({ id: "3f2504e0-4f89-41d3-9a0c-0305e82c3309", authorizedBy: null });
    const { open, registries } = environments({ staging: fixtureConnection(), prod: unattributed });
    const found = await listPrincipalConnections({ principal: ADA, environments: ["staging", "prod"], open, now: NOW });
    const revoked = await revokePrincipalConnections({ found, reason: "Ada left.", open, now: NOW });
    expect(revoked).toEqual([
      { environment: "staging", connectionId: fixtureConnection().id, revokedKeyIds: ["k1"], revokedTrustIds: [] },
    ]);
    expect(registries.get("staging")?.current()?.keys[0]?.revokedAt).toEqual(NOW);
    expect(registries.get("prod")?.current()).toEqual(unattributed);
  });

  test("revokes a match whose key has not started yet, which verifies once the Worker's clock reaches it", async () => {
    const pending = fixtureKey("k2", { validFrom: new Date(NOW.getTime() + 120_000) });
    const { open, registries } = environments({ prod: fixtureConnection({ keys: [pending] }) });
    const found = await listPrincipalConnections({ principal: ADA, environments: ["prod"], open, now: NOW });
    expect(found[0]?.connections[0]?.live).toBe(false);
    expect(revocable(found)).toHaveLength(1);
    const revoked = await revokePrincipalConnections({ found, reason: "Ada left.", open, now: NOW });
    expect(revoked).toEqual([
      { environment: "prod", connectionId: fixtureConnection().id, revokedKeyIds: ["k2"], revokedTrustIds: [] },
    ]);
    expect(registries.get("prod")?.current()?.keys[0]?.revokedAt).toEqual(NOW);
  });

  test("leaves out a match whose every credential is already revoked", async () => {
    const { open } = environments({ prod: fixtureConnection({ keys: [fixtureKey("k1", { revokedAt: NOW })] }) });
    const found = await listPrincipalConnections({ principal: ADA, environments: ["prod"], open, now: NOW });
    expect(found[0]?.connections).toHaveLength(1);
    expect(revocable(found)).toEqual([]);
    expect(await revokePrincipalConnections({ found, reason: "Ada left.", open, now: NOW })).toEqual([]);
  });
});

describe("the human output", () => {
  test("lists the principal's connections, then the unattributed ones apart", async () => {
    const { open } = environments({
      prod: fixtureConnection(),
      staging: fixtureConnection({ environment: "staging", authorizedBy: null }),
    });
    const found = await listPrincipalConnections({ principal: ADA, environments: ["prod", "staging"], open, now: NOW });
    const text = formatPrincipalConnections(ADA, found);
    expect(text).toContain(`Authorized by ${ADA}:`);
    expect(text).toContain("Registered before principals were recorded.");
    expect(text.indexOf("prod")).toBeLessThan(text.indexOf("staging"));
  });

  test("says what a revoke will end before it asks, and what it ended after", async () => {
    const { open } = environments({ prod: fixtureConnection() });
    const found = await listPrincipalConnections({ principal: ADA, environments: ["prod"], open, now: NOW });
    expect(formatRevocationPlan(ADA, found)).toContain("Revoking 1 connection authorized by ada@example.com:");
    expect(
      formatRevoked([{ environment: "prod", connectionId: "c1", revokedKeyIds: ["k1"], revokedTrustIds: ["t1"] }]),
    ).toContain("Revoked c1 on prod: 1 key, 1 trust.\nA token already minted");
  });

  test("says there is nothing to revoke when nothing is live", () => {
    expect(formatRevocationPlan(ADA, [])).toBe("Nothing authorized by ada@example.com is left to revoke.\n");
  });
});

describe("--json", () => {
  test("conforms, listing and revoking", async () => {
    const { open } = environments({
      prod: fixtureConnection({ trusts: [fixtureTrust("t1")] }),
      staging: fixtureConnection({ environment: "staging", authorizedBy: null }),
    });
    const byEnvironment = await listPrincipalConnections({
      principal: ADA,
      environments: ["prod", "staging"],
      open,
      now: NOW,
    });
    await expectConforms("dashboard connections", () =>
      formatPrincipalReport({ principal: ADA, byEnvironment }, { json: true }),
    );
    const revocations = await revokePrincipalConnections({ found: byEnvironment, reason: "Ada left.", open, now: NOW });
    await expectConforms("dashboard connections", () =>
      formatPrincipalReport({ principal: ADA, byEnvironment, revocations }, { json: true }),
    );
  });
});
