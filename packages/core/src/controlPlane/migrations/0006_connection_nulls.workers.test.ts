// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../data/db";
import { parseConnectionRow } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { controlplane_0001_init } from "./0001_init";
import { controlplane_0002_management_origin } from "./0002_management_origin";
import { controlplane_0003_connection_principal } from "./0003_connection_principal";
import { controlplane_0004_connection_trusts } from "./0004_connection_trusts";
import { controlplane_0006_connection_nulls } from "./0006_connection_nulls";

const BLANK = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const KEPT = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const MIXED = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

const INSERT =
  "INSERT INTO pithy_controlplane_connections (id, environment, issuer, worker_url, scopes, keys, created_at, updated_at, management_origin, authorized_by, actor_kind, purpose) VALUES (?, 'prod', 'https://app.pithy.sh', 'https://api.example.com', '[]', '[]', 0, 0, ?, ?, ?, ?)";

async function principals(id: string): Promise<unknown> {
  return env.DB.prepare(
    "SELECT quote(management_origin) o, quote(authorized_by) a, quote(actor_kind) k, quote(purpose) p FROM pithy_controlplane_connections WHERE id = ?",
  )
    .bind(id)
    .first();
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  await controlplane_0001_init.up(db());
  await controlplane_0002_management_origin.up(db());
  await controlplane_0003_connection_principal.up(db());
  await controlplane_0004_connection_trusts.up(db());
});

describe("controlplane_0006_connection_nulls", () => {
  test("up turns an empty nullable column back into NULL, and the row reads again", async () => {
    await env.DB.prepare(INSERT).bind(BLANK, "", "", "", "").run();

    await controlplane_0006_connection_nulls.up(db());

    expect(await principals(BLANK)).toEqual({ o: "NULL", a: "NULL", k: "NULL", p: "NULL" });
    const row = await controlPlaneDatabase(env.DB)
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("id", "=", BLANK)
      .executeTakeFirstOrThrow();
    expect(parseConnectionRow(row)).toMatchObject({
      managementOrigin: null,
      authorizedBy: null,
      actorKind: null,
      purpose: null,
    });
  });

  test("up leaves a recorded value, and a column already NULL, as they were", async () => {
    await env.DB.prepare(INSERT)
      .bind(KEPT, "https://app.pithy.sh", "ada@example.com", "dashboard", "Support triage.")
      .run();
    await env.DB.prepare(INSERT).bind(MIXED, null, null, "", "Release checks.").run();

    await controlplane_0006_connection_nulls.up(db());

    expect(await principals(KEPT)).toEqual({
      o: "'https://app.pithy.sh'",
      a: "'ada@example.com'",
      k: "'dashboard'",
      p: "'Support triage.'",
    });
    expect(await principals(MIXED)).toEqual({ o: "NULL", a: "NULL", k: "NULL", p: "'Release checks.'" });
  });

  test("down writes nothing, so a repaired row stays readable", async () => {
    await env.DB.prepare(INSERT).bind(BLANK, "", "", "", "").run();
    await controlplane_0006_connection_nulls.up(db());

    const { down } = controlplane_0006_connection_nulls;
    expect(down).toBeDefined();
    await down?.(db());

    expect(await principals(BLANK)).toEqual({ o: "NULL", a: "NULL", k: "NULL", p: "NULL" });
  });
});
