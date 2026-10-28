// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../data/db";
import { ConflictError } from "../../error/pithyError";
import { fixtureConnection, fixtureKey, fixtureTrust, FIXTURE_NOW as NOW } from "../../test-utils/connectionFixtures";
import { writeAfterRead } from "../../test-utils/interleave";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { controlplane_0004_connection_trusts } from "../migrations/0004_connection_trusts";
import { ControlPlaneConnection } from "./connection";
import { listConnections, readConnection, readConnectionForWrite, revokeConnection, writeKeys } from "./connections";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "./tables";

const db = () => controlPlaneDatabase(env.DB);
const ADA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const GRACE = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const OLD = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const STAGING = "3f2504e0-4f89-41d3-9a0c-0305e82c3304";

async function seed(...connections: ReturnType<typeof fixtureConnection>[]): Promise<void> {
  for (const connection of connections) {
    await db().insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(ControlPlaneConnection.encode(connection)).execute();
  }
}

beforeEach(async () => {
  const raw = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  await controlplane_0001_init.up(raw);
  await controlplane_0002_management_origin.up(raw);
  await controlplane_0003_connection_principal.up(raw);
  await controlplane_0004_connection_trusts.up(raw);
  await seed(
    fixtureConnection({ id: ADA, createdAt: new Date("2026-10-01T00:00:00.000Z") }),
    fixtureConnection({
      id: GRACE,
      authorizedBy: "grace@example.com",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    }),
    fixtureConnection({
      id: OLD,
      authorizedBy: null,
      actorKind: null,
      purpose: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    }),
    fixtureConnection({ id: STAGING, environment: "staging", createdAt: new Date("2026-10-03T00:00:00.000Z") }),
  );
});

describe("listConnections", () => {
  test("lists every attributed connection, oldest first, and the unattributed ones apart", async () => {
    const listing = await listConnections(db());
    expect(listing.connections.map((connection) => connection.id)).toEqual([ADA, GRACE, STAGING]);
    expect(listing.unattributed.map((connection) => connection.id)).toEqual([OLD]);
  });

  test("filters by principal, and never matches an unattributed connection", async () => {
    const listing = await listConnections(db(), { principal: "ADA@example.com" });
    expect(listing.connections.map((connection) => connection.id)).toEqual([ADA, STAGING]);
    expect(listing.unattributed.map((connection) => connection.id)).toEqual([OLD]);
  });

  test("filters by environment", async () => {
    const listing = await listConnections(db(), { principal: "ada@example.com", environment: "staging" });
    expect(listing.connections.map((connection) => connection.id)).toEqual([STAGING]);
    expect(listing.unattributed).toEqual([]);
  });
});

describe("revokeConnection", () => {
  test("revokes the connection's live credentials and touches no other connection", async () => {
    await db()
      .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
      .set({ trusts: ControlPlaneConnection.shape.trusts.encode([fixtureTrust("t")]) })
      .where("id", "=", ADA)
      .execute();
    const result = await revokeConnection(db(), ADA, NOW);
    expect(result?.revokedKeyIds).toEqual(["k1"]);
    expect(result?.revokedTrustIds).toEqual(["t"]);
    const stored = await readConnection(db(), ADA);
    expect(stored?.keys).toEqual([fixtureKey("k1", { revokedAt: NOW })]);
    expect(stored?.trusts).toEqual([fixtureTrust("t", { revokedAt: NOW })]);
    expect((await readConnection(db(), GRACE))?.keys).toEqual([fixtureKey("k1")]);
  });

  test("answers null for an id no connection has", async () => {
    expect(await revokeConnection(db(), "3f2504e0-4f89-41d3-9a0c-0305e82c3399", NOW)).toBeNull();
  });

  test("answers null for a connection bound to another environment, and leaves it as it was", async () => {
    expect(await revokeConnection(db(), STAGING, NOW, { environment: "prod" })).toBeNull();
    expect((await readConnection(db(), STAGING))?.keys).toEqual([fixtureKey("k1")]);
    expect((await revokeConnection(db(), STAGING, NOW, { environment: "staging" }))?.revokedKeyIds).toEqual(["k1"]);
  });
});

/** Append a key to ADA through a handle of its own, as a rotation landing between a revocation's read and its write. */
async function rotateAda(keyId: string): Promise<void> {
  const stored = await readConnection(db(), ADA);
  if (stored === null) throw new Error("seeded connection missing");
  await db()
    .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
    .set({ keys: ControlPlaneConnection.shape.keys.encode([...stored.keys, fixtureKey(keyId, { validFrom: NOW })]) })
    .where("id", "=", ADA)
    .execute();
}

describe("revokeConnection against a write landing between its read and its own", () => {
  test("a rotation that lands first is read again and revoked with the rest", async () => {
    const raced = writeAfterRead(db(), () => rotateAda("k2"), 1);
    const result = await revokeConnection(raced, ADA, NOW);
    expect(result?.revokedKeyIds).toEqual(["k1", "k2"]);
    expect((await readConnection(db(), ADA))?.keys).toEqual([
      fixtureKey("k1", { revokedAt: NOW }),
      fixtureKey("k2", { validFrom: NOW, revokedAt: NOW }),
    ]);
  });

  test("a trust added in between is revoked too, never dropped", async () => {
    const raced = writeAfterRead(
      db(),
      async () => {
        await db()
          .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
          .set({ trusts: ControlPlaneConnection.shape.trusts.encode([fixtureTrust("t")]) })
          .where("id", "=", ADA)
          .execute();
      },
      1,
    );
    expect((await revokeConnection(raced, ADA, NOW))?.revokedTrustIds).toEqual(["t"]);
    expect((await readConnection(db(), ADA))?.trusts).toEqual([fixtureTrust("t", { revokedAt: NOW })]);
  });

  test("losing every race is a conflict, and the row stays as the last writer left it", async () => {
    const raced = writeAfterRead(db(), (count) => rotateAda(`k${count + 2}`));
    await expect(revokeConnection(raced, ADA, NOW)).rejects.toBeInstanceOf(ConflictError);
    const keys = (await readConnection(db(), ADA))?.keys ?? [];
    expect(keys.map((key) => key.keyId)).toEqual(["k1", "k2", "k3", "k4", "k5", "k6"]);
    expect(keys.every((key) => key.revokedAt === null)).toBe(true);
  });
});

describe("writeKeys", () => {
  test("a rotation read before a revocation and written after it is refused, and the revocation holds", async () => {
    const rotation = await readConnectionForWrite(db(), ADA);
    expect(rotation).not.toBeNull();
    if (rotation === null) return;
    expect((await revokeConnection(db(), ADA, NOW))?.revokedKeyIds).toEqual(["k1"]);
    const successor = fixtureKey("k2", { validFrom: NOW });
    const written = await writeKeys(db(), rotation, [...rotation.connection.keys, successor], NOW);
    expect(written).toBe(false);
    expect((await readConnection(db(), ADA))?.keys).toEqual([fixtureKey("k1", { revokedAt: NOW })]);
  });

  test("a rotation with nothing landing in between is written", async () => {
    const rotation = await readConnectionForWrite(db(), ADA);
    if (rotation === null) throw new Error("seeded connection missing");
    const successor = fixtureKey("k2", { validFrom: NOW });
    expect(await writeKeys(db(), rotation, [...rotation.connection.keys, successor], NOW)).toBe(true);
    expect((await readConnection(db(), ADA))?.keys).toEqual([fixtureKey("k1"), successor]);
  });
});
