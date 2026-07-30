// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../data/db";
import { ControlPlaneConnection } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { controlplane_0001_connections } from "./0001_connections";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_controlplane_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
});

const connection: ControlPlaneConnection = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  environment: "production",
  issuer: "https://app.pithy.sh",
  workerUrl: "https://api.example.com",
  scopes: ["manifest:read", "keys:rotate"],
  keys: [
    {
      keyId: "cpk_01HQ",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validUntil: null,
      revokedAt: null,
    },
  ],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T09:30:00.000Z"),
};

describe("controlplane_0001_connections", () => {
  test("up creates the connections table and the environment index", async () => {
    await controlplane_0001_connections.up(db());
    expect(await catalog()).toEqual([
      "pithy_controlplane_connections",
      "pithy_controlplane_connections_environment_idx",
    ]);
  });

  test("the DDL and the codec agree — an encoded connection writes and reads back through real D1", async () => {
    await controlplane_0001_connections.up(db());
    const kysely = controlPlaneDatabase(env.DB);

    await kysely
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode(connection))
      .execute();
    const row = await kysely
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();

    expect(ControlPlaneConnection.parse(row)).toEqual(connection);
  });

  test("the id is the primary key, so one connection cannot be registered twice", async () => {
    await controlplane_0001_connections.up(db());
    const kysely = controlPlaneDatabase(env.DB);
    const values = ControlPlaneConnection.encode(connection);

    await kysely.insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(values).execute();
    await expect(kysely.insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(values).execute()).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test("every column the seam reads is NOT NULL — a half-written registration is not a valid row", async () => {
    await controlplane_0001_connections.up(db());
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_controlplane_connections (id, environment, issuer, worker_url, scopes, keys, created_at, updated_at) VALUES ('c1', NULL, 'https://app.pithy.sh', 'https://api.example.com', '[]', '[]', 0, 0)",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_controlplane_connections (id, environment, issuer, worker_url, scopes, keys, created_at, updated_at) VALUES ('c2', 'production', 'https://app.pithy.sh', 'https://api.example.com', '[]', NULL, 0, 0)",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
  });

  test("down is the exact inverse and up is re-runnable after it", async () => {
    await controlplane_0001_connections.up(db());
    await controlplane_0001_connections.down?.(db());
    expect(await catalog()).toEqual([]);
    await controlplane_0001_connections.up(db());
    expect(await catalog()).toContain("pithy_controlplane_connections");
  });
});
