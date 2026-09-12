// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

/**
 * The auth set as `pithy migrate` composes it — **both** migrations, in order.
 *
 * The whole point of a `0002` is that it runs against a database `0001` already shaped, so a test that
 * exercised it alone would be testing something no adopter will ever run.
 */
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

/** The columns on `pithy_auth_sessions`, as SQLite reports them. */
async function sessionColumns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_auth_sessions')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name).sort();
}

describe("auth_0002_session_authenticated_at", () => {
  beforeEach(async () => {
    // Every auth table plus the ledger and its lock — the same reset `0001_init.workers.test.ts` does.
    // Leaving the ledger behind would make `runMigrations` believe 0001 had already applied and skip it,
    // so this migration would run against a table that does not exist.
    for (const table of [
      "pithy_auth_accounts",
      "pithy_auth_devices",
      "pithy_auth_jwks",
      "pithy_auth_rate_limit",
      "pithy_auth_rotated_tokens",
      "pithy_auth_sessions",
      "pithy_auth_users",
      "pithy_auth_verifications",
      "pithy_migrations",
      "pithy_migrations_lock",
    ]) {
      await env.DB.prepare(`drop table if exists ${table}`).run();
    }
  });

  test("up adds the column to a table 0001 already created", async () => {
    await runMigrations(env.DB, provider());
    expect(await sessionColumns()).toContain("authenticated_at");
  });

  test("down removes it again, leaving 0001's own columns untouched", async () => {
    // Every migration's `down` is tested, and this one has a specific trap: a careless inverse that
    // rebuilt the table would drop `family_id` and `device_id` with it.
    await runMigrations(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    const columns = await sessionColumns();
    expect(columns).not.toContain("authenticated_at");
    expect(columns).toContain("family_id");
    expect(columns).toContain("device_id");
    expect(columns).toContain("created_at");
  });

  test("the column is nullable, because a row written before it cannot be dated", async () => {
    // SQLite would refuse `ADD COLUMN … NOT NULL` without a constant default, and there is no constant
    // that would be true. A session predating the column reads null, which the gate treats as not-fresh.
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1','Jo','jo@example.test',1,'2026-01-01','2026-01-01')",
    ).run();
    await env.DB.prepare(
      "insert into pithy_auth_sessions (id, token, user_id, expires_at, created_at, updated_at) values ('s1','t1','u1','2027-01-01','2026-01-01','2026-01-01')",
    ).run();
    const row = await env.DB.prepare("select authenticated_at from pithy_auth_sessions where id = 's1'").first<{
      authenticated_at: string | null;
    }>();
    expect(row?.authenticated_at ?? null).toBeNull();
  });

  test("it stores ISO-8601 text, the convention every timestamp on this table follows", async () => {
    // `text`, not the ms-epoch integers Pithy's own device columns use: Better Auth writes its `date`
    // fields as ISO strings on SQLite, and a column typed against the other convention reads back wrong
    // rather than failing.
    await runMigrations(env.DB, provider());
    const types = await env.DB.prepare("select name, type from pragma_table_info('pithy_auth_sessions')").all<{
      name: string;
      type: string;
    }>();
    const column = types.results.find((row) => row.name === "authenticated_at");
    expect(column?.type.toLowerCase()).toBe("text");
    expect(types.results.find((row) => row.name === "created_at")?.type.toLowerCase()).toBe("text");
  });
});
