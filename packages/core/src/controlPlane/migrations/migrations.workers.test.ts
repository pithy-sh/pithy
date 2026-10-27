// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../data/db";
import { ControlPlaneConnection } from "../data/connection";
import { ControlPlaneReplay } from "../data/replay";
import { CONTROL_PLANE_CONNECTIONS_TABLE, CONTROL_PLANE_REPLAYS_TABLE, controlPlaneDatabase } from "../data/tables";
import { controlplane_0001_init } from "./0001_init";
import { controlplane_0002_management_origin } from "./0002_management_origin";
import { controlplane_0003_connection_principal } from "./0003_connection_principal";
import { controlplane_0004_connection_trusts } from "./0004_connection_trusts";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_controlplane_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
});

const connection: ControlPlaneConnection = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  environment: "prod",
  issuer: "https://app.pithy.sh",
  workerUrl: "https://api.example.com",
  basePath: "/control-plane",
  managementOrigin: null,
  authorizedBy: "ada@example.com",
  actorKind: "dashboard",
  purpose: "Support triage.",
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

describe("controlplane_0001_init", () => {
  test("up creates both seam tables and their indexes", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    expect(await catalog()).toEqual([
      "pithy_controlplane_connections",
      "pithy_controlplane_connections_environment_idx",
      "pithy_controlplane_replays",
      "pithy_controlplane_replays_expires_at_idx",
    ]);
  });

  test("the DDL and the codec agree — an encoded connection writes and reads back through real D1", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
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

  test("a moved mount point round-trips, which is the whole reason basePath is stored", async () => {
    // `workerUrl` alone does not address the manifest. An adopter who mounted the seam at `/admin` must
    // have that recorded, or a client assumes `/control-plane`, passes the ping at that same assumed
    // path, and then 404s on every call — with the operator diagnosing the wrong problem.
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    const kysely = controlPlaneDatabase(env.DB);

    await kysely
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, basePath: "/admin" }))
      .execute();
    const row = await kysely
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();

    expect(ControlPlaneConnection.parse(row).basePath).toBe("/admin");
  });

  test("basePath defaults rather than being required, so a row written without one is still callable", async () => {
    // Unlike an origin column, null is not the truthful answer here: a connection with no recorded base
    // path was necessarily using the default. The default states what was already true.
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    await env.DB.prepare(
      "INSERT INTO pithy_controlplane_connections (id, environment, issuer, worker_url, scopes, keys, created_at, updated_at) VALUES ('bare', 'prod', 'https://app.pithy.sh', 'https://api.example.com', '[]', '[]', 0, 0)",
    ).run();

    expect(await env.DB.prepare("select base_path from pithy_controlplane_connections").first()).toEqual({
      base_path: "/control-plane",
    });
  });

  test("the connection id is the primary key, so one connection cannot be registered twice", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    const kysely = controlPlaneDatabase(env.DB);
    const values = ControlPlaneConnection.encode(connection);

    await kysely.insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(values).execute();
    await expect(kysely.insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(values).execute()).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test("every connection column the seam reads is NOT NULL — a half-written registration is not a valid row", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_controlplane_connections (id, environment, issuer, worker_url, scopes, keys, created_at, updated_at) VALUES ('c1', NULL, 'https://app.pithy.sh', 'https://api.example.com', '[]', '[]', 0, 0)",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_controlplane_connections (id, environment, issuer, worker_url, scopes, keys, created_at, updated_at) VALUES ('c2', 'prod', 'https://app.pithy.sh', 'https://api.example.com', '[]', NULL, 0, 0)",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
  });

  test("a replay record round-trips through real D1", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    const kysely = controlPlaneDatabase(env.DB);
    const record: ControlPlaneReplay = {
      jti: "cpt_01HQZZ",
      connectionId: connection.id,
      expiresAt: new Date("2026-02-01T09:33:00.000Z"),
    };

    await kysely.insertInto(CONTROL_PLANE_REPLAYS_TABLE).values(ControlPlaneReplay.encode(record)).execute();
    const row = await kysely
      .selectFrom(CONTROL_PLANE_REPLAYS_TABLE)
      .selectAll()
      .where("jti", "=", record.jti)
      .executeTakeFirstOrThrow();

    expect(ControlPlaneReplay.parse(row)).toEqual(record);
  });

  test("the jti is the primary key — and it is the jti alone, so a second connection cannot re-spend it", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    const kysely = controlPlaneDatabase(env.DB);
    const encode = (connectionId: string) =>
      ControlPlaneReplay.encode({ jti: "cpt_shared", connectionId, expiresAt: new Date(1) });

    await kysely.insertInto(CONTROL_PLANE_REPLAYS_TABLE).values(encode("connection-a")).execute();
    // A composite key on (jti, connectionId) would admit this, and that is the whole point of not having
    // one: a token captured from one connection must not be spendable against another.
    await expect(
      kysely.insertInto(CONTROL_PLANE_REPLAYS_TABLE).values(encode("connection-b")).execute(),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("every replay column is NOT NULL — a half-written claim is not a claim", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_controlplane_replays (jti, connection_id, expires_at) VALUES ('j1', NULL, 0)",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_controlplane_replays (jti, connection_id, expires_at) VALUES ('j2', 'c1', NULL)",
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
  });

  test("down is the exact inverse and up is re-runnable after it", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    await controlplane_0001_init.down?.(db());
    expect(await catalog()).toEqual([]);
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    // The codec describes the table as it stands: `0001`, `0002` (#614) and `0003` (#721).
    expect(await catalog()).toContain("pithy_controlplane_connections");
    expect(await catalog()).toContain("pithy_controlplane_replays");
  });
});

/**
 * Where the management client answers — `#614`.
 *
 * `status --verify` asked `app.pithy.sh` about a connection registered against a self-hosted dashboard,
 * because the origin lived only in a flag with a default. It lives on the row now.
 */
describe("controlplane_0002_management_origin", () => {
  /** Read one connection back the way every reader does — through the codec, over Kysely's mapping. */
  async function stored(): Promise<ControlPlaneConnection> {
    const row = await controlPlaneDatabase(env.DB)
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    return ControlPlaneConnection.parse(row);
  }

  test("a row written before the column reads as null, not as the hosted dashboard", async () => {
    // `0001` alone, deliberately: this test is about the table as every released adopter holds it.
    await controlplane_0001_init.up(db());
    // Written the way the released CLI wrote it: the encoder now emits a column that did not exist, so
    // the legacy row has to be inserted as one, in SQL. This is the shape in every adopter's database.
    await env.DB.prepare(
      `insert into pithy_controlplane_connections
         (id, environment, issuer, worker_url, base_path, scopes, keys, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        connection.id,
        connection.environment,
        connection.issuer,
        connection.workerUrl,
        connection.basePath,
        JSON.stringify(connection.scopes),
        ControlPlaneConnection.shape.keys.encode([...connection.keys]),
        connection.createdAt.getTime(),
        connection.updatedAt.getTime(),
      )
      .run();

    await controlplane_0002_management_origin.up(db());

    // Null, never `https://app.pithy.sh`. Defaulting would assert that every self-hosted connection
    // already registered belongs to the dashboard Pithy hosts — the assertion that caused #614.
    expect((await stored()).managementOrigin).toBeNull();
  });

  test("an origin round-trips, which is the whole reason the column exists", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());

    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, managementOrigin: "https://staging.app.pithy.sh" }))
      .execute();

    expect((await stored()).managementOrigin).toBe("https://staging.app.pithy.sh");
  });

  test("down drops the column and leaves every credential on the row intact", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, managementOrigin: "https://staging.app.pithy.sh" }))
      .execute();

    await controlplane_0002_management_origin.down?.(db());

    const row = await env.DB.prepare("select * from pithy_controlplane_connections").first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(Object.keys(row ?? {})).not.toContain("management_origin");
    // A rollback of this migration must not cost anybody a key: the column nothing reads goes, and the
    // credentials stay.
    expect(row?.keys).toBe(ControlPlaneConnection.shape.keys.encode([...connection.keys]));
  });

  test("up after down leaves the column there again", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    await controlplane_0002_management_origin.down?.(db());
    await controlplane_0002_management_origin.up(db());

    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, managementOrigin: "https://moved.example" }))
      .execute();

    expect((await stored()).managementOrigin).toBe("https://moved.example");
  });
});

/**
 * Who sanctioned a connection, what kind of client it is, and what it is for — `#721`.
 *
 * The table has shipped, so the three arrive as nullable columns, and a row registered before them reads
 * as registered before principals were recorded rather than as anything invented.
 */
describe("controlplane_0003_connection_principal", () => {
  async function stored(): Promise<ControlPlaneConnection> {
    const row = await controlPlaneDatabase(env.DB)
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    return ControlPlaneConnection.parse(row);
  }

  /** The row as every released adopter holds it: `0001` and `0002`, written before this column existed. */
  async function legacyRow(): Promise<void> {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await env.DB.prepare(
      `insert into pithy_controlplane_connections
         (id, environment, issuer, worker_url, base_path, management_origin, scopes, keys, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        connection.id,
        connection.environment,
        connection.issuer,
        connection.workerUrl,
        connection.basePath,
        null,
        JSON.stringify(connection.scopes),
        ControlPlaneConnection.shape.keys.encode([...connection.keys]),
        connection.createdAt.getTime(),
        connection.updatedAt.getTime(),
      )
      .run();
  }

  test("a connection registered before it still parses, with all three null and its keys intact", async () => {
    await legacyRow();
    await controlplane_0003_connection_principal.up(db());

    const read = await stored();
    expect(read.authorizedBy).toBeNull();
    expect(read.actorKind).toBeNull();
    expect(read.purpose).toBeNull();
    // Nothing that works today breaks on upgrade: the credential is the credential it was.
    expect(read.keys).toEqual(connection.keys);
  });

  test("no row is backfilled — most of the trail names a token, not a person", async () => {
    await legacyRow();
    await controlplane_0003_connection_principal.up(db());

    expect(
      await env.DB.prepare("select authorized_by, actor_kind, purpose from pithy_controlplane_connections").first(),
    ).toEqual({ authorized_by: null, actor_kind: null, purpose: null });
  });

  test("all three round-trip through real D1", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, actorKind: "agent", purpose: "Nightly refund sweep." }))
      .execute();

    const read = await stored();
    expect(read.authorizedBy).toBe("ada@example.com");
    expect(read.actorKind).toBe("agent");
    expect(read.purpose).toBe("Nightly refund sweep.");
  });

  test("a legacy row may have its purpose set without a principal", async () => {
    await legacyRow();
    await controlplane_0003_connection_principal.up(db());
    await controlPlaneDatabase(env.DB)
      .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
      .set({ purpose: "The hosted dashboard." })
      .where("id", "=", connection.id)
      .execute();

    const read = await stored();
    expect(read.purpose).toBe("The hosted dashboard.");
    expect(read.authorizedBy).toBeNull();
  });

  test("down drops the three columns and leaves every credential on the row intact", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode(connection))
      .execute();

    await controlplane_0003_connection_principal.down?.(db());

    const row = await env.DB.prepare("select * from pithy_controlplane_connections").first<Record<string, unknown>>();
    expect(Object.keys(row ?? {})).not.toContain("authorized_by");
    expect(Object.keys(row ?? {})).not.toContain("actor_kind");
    expect(Object.keys(row ?? {})).not.toContain("purpose");
    expect(row?.keys).toBe(ControlPlaneConnection.shape.keys.encode([...connection.keys]));
    expect(row?.management_origin).toBeNull();
  });

  test("up after down leaves the columns there again", async () => {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
    await controlplane_0003_connection_principal.down?.(db());
    await controlplane_0003_connection_principal.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode(connection))
      .execute();

    expect((await stored()).purpose).toBe("Support triage.");
  });
});

describe("controlplane_0004_connection_trusts", () => {
  const trust = {
    trustId: "4b8f0c1e-2a7d-4e0b-9c55-0f3a6d2e7b19",
    issuer: "https://token.actions.githubusercontent.com",
    jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
    audience: "https://api.example.com",
    claims: { repository_id: "1262274726" },
    authorizedBy: "ada@example.com",
    validFrom: new Date("2026-10-01T00:00:00.000Z"),
    revokedAt: null,
    firstCallAt: null,
  };

  async function stored(): Promise<ControlPlaneConnection> {
    const row = await controlPlaneDatabase(env.DB)
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    return ControlPlaneConnection.parse(row);
  }

  async function throughPrincipal(): Promise<void> {
    await controlplane_0001_init.up(db());
    await controlplane_0002_management_origin.up(db());
    await controlplane_0003_connection_principal.up(db());
  }

  test("a connection registered before it reads as holding no trust, its keys intact", async () => {
    await throughPrincipal();
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode(connection))
      .execute();
    await controlplane_0004_connection_trusts.up(db());

    const read = await stored();
    expect(read.trusts).toEqual([]);
    expect(read.keys).toEqual(connection.keys);
  });

  test("a trust round-trips through real D1 beside a key", async () => {
    await throughPrincipal();
    await controlplane_0004_connection_trusts.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, trusts: [trust] }))
      .execute();

    const read = await stored();
    expect(read.trusts).toEqual([trust]);
    expect(read.keys).toEqual(connection.keys);
  });

  test("a connection may hold a trust and no key", async () => {
    await throughPrincipal();
    await controlplane_0004_connection_trusts.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, keys: [], trusts: [trust] }))
      .execute();

    const read = await stored();
    expect(read.keys).toEqual([]);
    expect(read.trusts).toEqual([trust]);
  });

  test("down drops the column and leaves every key on the row intact", async () => {
    await throughPrincipal();
    await controlplane_0004_connection_trusts.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, trusts: [trust] }))
      .execute();

    await controlplane_0004_connection_trusts.down?.(db());

    const row = await env.DB.prepare("select * from pithy_controlplane_connections").first<Record<string, unknown>>();
    expect(Object.keys(row ?? {})).not.toContain("trusts");
    expect(row?.keys).toBe(ControlPlaneConnection.shape.keys.encode([...connection.keys]));
  });

  test("up after down leaves the column there again", async () => {
    await throughPrincipal();
    await controlplane_0004_connection_trusts.up(db());
    await controlplane_0004_connection_trusts.down?.(db());
    await controlplane_0004_connection_trusts.up(db());
    await controlPlaneDatabase(env.DB)
      .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
      .values(ControlPlaneConnection.encode({ ...connection, trusts: [trust] }))
      .execute();

    expect((await stored()).trusts).toEqual([trust]);
  });
});
