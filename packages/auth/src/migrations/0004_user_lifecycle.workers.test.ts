// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { User } from "../data/betterAuth";
import { authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

/** The auth set as `pithy migrate` composes it — every migration, in order, so `0004` runs where it will. */
const SET = {
  database: "app",
  namespace: "auth",
  order: AUTH_MIGRATION_ORDER,
  migrations: AUTH_MIGRATIONS,
} as const;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([SET]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** A table's columns, as SQLite reports them. */
async function columns(table: string): Promise<{ name: string; type: string; notnull: number }[]> {
  const rows = await env.DB.prepare(`select name, type, "notnull" from pragma_table_info('${table}')`).all<{
    name: string;
    type: string;
    notnull: number;
  }>();
  return rows.results;
}

async function tableExists(table: string): Promise<boolean> {
  const row = await env.DB.prepare("select name from sqlite_master where type = 'table' and name = ?")
    .bind(table)
    .first<{ name: string }>();
  return row !== null;
}

const LIFECYCLE_COLUMNS = ["suspended_at", "suspended_until", "deleted_at", "purge_after"];

describe("auth_0004_user_lifecycle", () => {
  beforeEach(async () => {
    for (const table of [
      "pithy_auth_accounts",
      "pithy_auth_devices",
      "pithy_auth_jwks",
      "pithy_auth_rate_limit",
      "pithy_auth_rotated_tokens",
      "pithy_auth_sessions",
      "pithy_auth_user_lifecycle",
      "pithy_auth_verification_outcomes",
      "pithy_auth_users",
      "pithy_auth_verifications",
      "pithy_migrations",
      "pithy_migrations_lock",
    ]) {
      await env.DB.prepare(`drop table if exists ${table}`).run();
    }
  });

  test("up adds the four state columns to pithy_auth_users, nullable and integer", async () => {
    await runMigrations(env.DB, provider());
    const found = await columns("pithy_auth_users");
    for (const name of LIFECYCLE_COLUMNS) {
      const column = found.find((row) => row.name === name);
      expect(column, name).toBeDefined();
      // Integer: the kit writes these, in the house ms-epoch convention, unlike the ISO-text dates Better
      // Auth writes beside them. And nullable, because every account that exists today is in neither state.
      expect(column?.type.toLowerCase(), name).toBe("integer");
      expect(column?.notnull, name).toBe(0);
    }
  });

  test("up creates pithy_auth_user_lifecycle, and a row round-trips through its schema", async () => {
    await runMigrations(env.DB, provider());
    expect(await tableExists("pithy_auth_user_lifecycle")).toBe(true);
    const db = authDatabase(env.DB);
    const at = new Date("2026-10-20T12:00:00.000Z");
    const until = new Date("2026-11-01T00:00:00.000Z");
    await db
      .insertInto("pithyAuthUserLifecycle")
      .values({
        userId: "u1",
        action: "suspended",
        actorType: "control-plane",
        actorId: "connection-1",
        reason: "Chargeback under review.",
        suspendedUntil: SQLiteDate.encode(until),
        step: null,
        createdAt: SQLiteDate.encode(at),
      })
      .execute();
    const row = await db.selectFrom("pithyAuthUserLifecycle").selectAll().executeTakeFirstOrThrow();
    const event = UserLifecycleEvent.parse(row);
    expect(event).toMatchObject({ userId: "u1", action: "suspended", reason: "Chargeback under review." });
    expect(event.suspendedUntil?.getTime()).toBe(until.getTime());
    expect(event.createdAt.getTime()).toBe(at.getTime());
    expect(typeof event.id).toBe("number");
  });

  test("an account that existed before the migration reads back in neither state", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1','Jo','jo@example.test',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    ).run();
    const row = await authDatabase(env.DB).selectFrom("pithyAuthUsers").selectAll().executeTakeFirstOrThrow();
    const user = User.parse(row);
    expect(user.suspendedAt ?? null).toBeNull();
    expect(user.suspendedUntil ?? null).toBeNull();
    expect(user.deletedAt ?? null).toBeNull();
    expect(user.purgeAfter ?? null).toBeNull();
  });

  test("the lifecycle rows survive the user row they name — there is no cascade to take them", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1','Jo','jo@example.test',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    ).run();
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, created_at) values ('u1','purged','system',1)",
    ).run();
    await env.DB.prepare("delete from pithy_auth_users where id = 'u1'").run();
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_user_lifecycle").first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  test("down drops the table and the four columns, leaving everything before it intact", async () => {
    await runMigrations(env.DB, provider());
    // `0008`, `0007`, `0006` and `0005` sit above it in the chain, so they come down first.
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    expect(await tableExists("pithy_auth_user_lifecycle")).toBe(false);
    const names = (await columns("pithy_auth_users")).map((row) => row.name);
    for (const name of LIFECYCLE_COLUMNS) expect(names, name).not.toContain(name);
    // A careless inverse that rebuilt the table would take these with it.
    for (const name of ["id", "email", "locale", "created_at"]) expect(names).toContain(name);
  });

  test("down, then up again, is clean — the inverse is exact", async () => {
    await runMigrations(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await runMigrations(env.DB, provider());
    expect(await tableExists("pithy_auth_user_lifecycle")).toBe(true);
    const names = (await columns("pithy_auth_users")).map((row) => row.name);
    for (const name of LIFECYCLE_COLUMNS) expect(names).toContain(name);
  });
});
