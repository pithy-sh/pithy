import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { audit_0001_init } from "./0001_init";

/** The audit migration set, as `pithy migrate` composes it for the shared `app` database. */
const SET = {
  database: "app",
  namespace: "audit",
  order: 250,
  migrations: { "0001_init": audit_0001_init },
} as const;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([SET]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function auditTables(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name like 'pithy_audit_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function auditIndexes(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'index' and name like 'pithy_audit_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  for (const table of ["pithy_audit_events", "kysely_migration", "kysely_migration_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("audit_0001_init", () => {
  test("up creates the prefixed table and its indexes, and a full row round-trips", async () => {
    const results = await runMigrations(env.DB, provider());

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0001_init", "Up", "Success"],
    ]);
    expect(await auditTables()).toEqual(["pithy_audit_events"]);
    expect(await auditIndexes()).toEqual([
      "pithy_audit_events_action_idx",
      "pithy_audit_events_actor_idx",
      "pithy_audit_events_event_id_idx",
      "pithy_audit_events_occurred_at_idx",
      "pithy_audit_events_resource_idx",
    ]);

    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, severity, actor_type, actor_id, metadata) values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("evt-1", 1_700_000_000_000, "auth/login", "success", "info", "user", "user-1", '{"provider":"google"}')
      .run();
    const row = await env.DB.prepare("select action, outcome, actor_type from pithy_audit_events where actor_id = ?")
      .bind("user-1")
      .first<{ action: string; outcome: string; actor_type: string }>();
    expect(row).toEqual({ action: "auth/login", outcome: "success", actor_type: "user" });
  });

  test("the unique index on event_id rejects a duplicate — the idempotency substrate", async () => {
    await runMigrations(env.DB, provider());
    const insert = (): Promise<unknown> =>
      env.DB.prepare(
        "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type) values ('dup', 1, 'auth/login', 'success', 'system')",
      ).run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test("severity defaults to info at the column level", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type) values (?, ?, ?, ?, ?)",
    )
      .bind("evt-sev", 1, "admin/config_changed", "denied", "system")
      .run();
    const row = await env.DB.prepare("select severity from pithy_audit_events").first<{ severity: string }>();
    expect(row?.severity).toBe("info");
  });

  test("down drops the table and its indexes", async () => {
    const p = provider();
    await runMigrations(env.DB, p);

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0001_init", "Down", "Success"],
    ]);
    expect(await auditTables()).toEqual([]);
    expect(await auditIndexes()).toEqual([]);
  });
});
