// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { queryAuditEvents } from "../query";
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

async function columnNames(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_audit_events')").all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

/** Record one event stating no tenant — the shape a single-tenant app and every CLI action produce. */
async function insertTenantlessRow(eventId: string): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_audit_events (event_id, occurred_at, action, outcome, severity, actor_type, actor_id) values (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(eventId, 1_700_000_000_000, "auth/login", "success", "info", "user", "user-1")
    .run();
}

beforeEach(async () => {
  for (const table of ["pithy_audit_events", "pithy_migrations", "pithy_migrations_lock"]) {
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
      "pithy_audit_events_origin_idx",
      "pithy_audit_events_resource_idx",
      "pithy_audit_events_tenant_idx",
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

  test("the origin columns exist and default to null when nothing records one", async () => {
    // Nullable with no default, on purpose: an unstamped Worker and every CLI-originated action have
    // no origin to record, and inventing one would be indistinguishable from a real one forever.
    await runMigrations(env.DB, provider());
    const columns = await env.DB.prepare("select name from pragma_table_info('pithy_audit_events')").all<{
      name: string;
    }>();
    const names = columns.results.map((column) => column.name);
    for (const column of ["project", "environment", "worker"]) expect(names).toContain(column);

    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type) values (?, ?, ?, ?, ?)",
    )
      .bind("evt-origin", 1, "auth/login", "success", "system")
      .run();
    const row = await env.DB.prepare("select project, environment, worker from pithy_audit_events").first();
    expect(row).toEqual({ project: null, environment: null, worker: null });
  });

  test("the tenant index leads with tenant and carries occurred_at", async () => {
    // The read this column exists to serve is (tenant, time), so the index leads with `tenant` and
    // carries `occurred_at` — a tenant filter with a time range must not degrade to a scan of the
    // largest table in the project.
    await runMigrations(env.DB, provider());
    expect(await columnNames()).toContain("tenant");
    const index = await env.DB.prepare(
      "select sql from sqlite_master where type = 'index' and name = 'pithy_audit_events_tenant_idx'",
    ).first<{ sql: string }>();
    expect(index?.sql).toContain("tenant");
    expect(index?.sql).toContain("occurred_at");
  });

  test("an event recorded without a tenant reads back as null, not as a codec failure", async () => {
    // Carried over from the folded-in tenant migration, which proved it of a row written before the
    // column existed. There is no such row any more — the column is in the schema from the first
    // migration — but the guarantee it was pinning was never really about the chain: `tenant` is
    // nullable with no default, so every event nobody states a tenant for reads as `null`, and reading
    // the trail must never throw. That is the assertion, and it survives the file it was written in.
    await runMigrations(env.DB, provider());
    await insertTenantlessRow("evt-no-tenant");

    const events = await queryAuditEvents(auditDatabase(env.DB));
    expect(events).toHaveLength(1);
    expect(events[0]?.tenant).toBeNull();
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

  test("down drops the table and its indexes, with events recorded", async () => {
    // Rolled back against a populated table, not an empty one: `down` drops every index before the
    // table it belongs to, and a rollback that only ever ran on a fresh database is a rollback nobody
    // has tested.
    const p = provider();
    await runMigrations(env.DB, p);
    await insertTenantlessRow("evt-rolled-back");

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0001_init", "Down", "Success"],
    ]);
    expect(await auditTables()).toEqual([]);
    expect(await auditIndexes()).toEqual([]);
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider();
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);

    const results = await runMigrations(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0001_init", "Up", "Success"],
    ]);
    expect(await columnNames()).toContain("tenant");
    expect(await auditIndexes()).toContain("pithy_audit_events_tenant_idx");
  });
});
