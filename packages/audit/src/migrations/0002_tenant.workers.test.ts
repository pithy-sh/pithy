// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { queryAuditEvents } from "../query";
import { audit_0001_init } from "./0001_init";
import { audit_0002_tenant } from "./0002_tenant";

/** The audit migration set, as `pithy migrate` composes it for the shared `app` database. */
const SET = {
  database: "app",
  namespace: "audit",
  order: 250,
  migrations: { "0001_init": audit_0001_init, "0002_tenant": audit_0002_tenant },
} as const;

/** A provider over some prefix of the audit set — the whole set by default, 0001 alone for "before". */
function provider(migrations: Record<string, Migration> = SET.migrations): MigrationProvider {
  const registry = createMigrationRegistry([{ ...SET, migrations }]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function columnNames(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_audit_events')").all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

async function auditIndexes(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'index' and name like 'pithy_audit_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

/** Write one row with the columns 0001 created — an event recorded before the tenant column existed. */
async function insertPreTenantRow(eventId: string): Promise<void> {
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

describe("audit_0002_tenant", () => {
  test("up adds the tenant column and its (tenant, occurredAt) index", async () => {
    const results = await runMigrations(env.DB, provider());

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0001_init", "Up", "Success"],
      ["0250_audit_0002_tenant", "Up", "Success"],
    ]);
    expect(await columnNames()).toContain("tenant");
    expect(await auditIndexes()).toContain("pithy_audit_events_tenant_idx");

    // The read this column exists to serve is (tenant, time), so the index leads with `tenant` and
    // carries `occurred_at` — a tenant filter with a time range must not degrade to a scan of the
    // largest table in the project.
    const index = await env.DB.prepare(
      "select sql from sqlite_master where type = 'index' and name = 'pithy_audit_events_tenant_idx'",
    ).first<{ sql: string }>();
    expect(index?.sql).toContain("tenant");
    expect(index?.sql).toContain("occurred_at");
  });

  test("a row written before the column existed reads as null, not as a codec failure", async () => {
    // The guarantee `project`/`environment`/`worker` already document, and the one an audit trail
    // cannot break: reading the historical trail must never throw. Nothing back-fills a tenant onto a
    // row recorded before anyone could state one.
    await runMigrations(env.DB, provider({ "0001_init": audit_0001_init }));
    await insertPreTenantRow("evt-pre-tenant");

    await runMigrations(env.DB, provider());

    const events = await queryAuditEvents(auditDatabase(env.DB));
    expect(events).toHaveLength(1);
    expect(events[0]?.tenant).toBeNull();
  });

  test("down drops the index and the column, and keeps every recorded event", async () => {
    // The index first, then the column: SQLite refuses to drop a column an index refers to, so the
    // reverse order fails on the real database rather than in review.
    const p = provider();
    await runMigrations(env.DB, p);
    await insertPreTenantRow("evt-survives");

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0002_tenant", "Down", "Success"],
    ]);
    expect(await columnNames()).not.toContain("tenant");
    expect(await auditIndexes()).not.toContain("pithy_audit_events_tenant_idx");
    const row = await env.DB.prepare("select event_id from pithy_audit_events").first<{ event_id: string }>();
    expect(row?.event_id).toBe("evt-survives");
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider();
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);

    const results = await runMigrations(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0002_tenant", "Up", "Success"],
    ]);
    expect(await columnNames()).toContain("tenant");
  });
});
