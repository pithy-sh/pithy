// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { queryAuditEvents } from "../query";
import { createAuditEmit } from "../recorder";
import { audit_0001_init } from "./0001_init";
import { audit_0002_actor_kind } from "./0002_actor_kind";

/**
 * What kind of management client acted — `#721`. `actorType: "control-plane"` names an agent, the
 * dashboard and a script identically, and this column is what tells them apart on the row.
 */

function provider(migrations: Record<string, typeof audit_0001_init>): MigrationProvider {
  const registry = createMigrationRegistry([{ database: "app", namespace: "audit", order: 250, migrations }]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const FULL = { "0001_init": audit_0001_init, "0002_actor_kind": audit_0002_actor_kind };

async function columnNames(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_audit_events')").all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of ["pithy_audit_events", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("audit_0002_actor_kind", () => {
  test("adds a nullable actor_kind column, and a row recorded before it reads as null", async () => {
    await runMigrations(env.DB, provider({ "0001_init": audit_0001_init }));
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, actor_id) values (?, ?, ?, ?, ?, ?)",
    )
      .bind("evt-before", 1, "controlplane/call_allowed", "success", "control-plane", "usr_1")
      .run();

    await runMigrations(env.DB, provider(FULL));

    expect(await columnNames()).toContain("actor_kind");
    const [event] = await queryAuditEvents(auditDatabase(env.DB));
    expect(event?.actorKind).toBeNull();
  });

  test("the recorder writes the kind, so an agent, the dashboard and a script read apart", async () => {
    await runMigrations(env.DB, provider(FULL));
    const emit = createAuditEmit(auditDatabase(env.DB));
    for (const actorKind of ["agent", "dashboard", "script"] as const) {
      await emit({ action: "payments/refund_issued", outcome: "success", actorType: "control-plane", actorKind });
    }
    await emit({ action: "auth/signin", outcome: "success", actorType: "user", actorId: "u1" });

    const events = await queryAuditEvents(auditDatabase(env.DB));
    expect(events.map((event) => [event.actorType, event.actorKind])).toEqual([
      ["user", null],
      ["control-plane", "script"],
      ["control-plane", "dashboard"],
      ["control-plane", "agent"],
    ]);
  });

  test("a trail can be filtered to one kind of client", async () => {
    await runMigrations(env.DB, provider(FULL));
    const emit = createAuditEmit(auditDatabase(env.DB));
    await emit({
      action: "payments/refund_issued",
      outcome: "success",
      actorType: "control-plane",
      actorKind: "agent",
    });
    await emit({
      action: "payments/refund_issued",
      outcome: "success",
      actorType: "control-plane",
      actorKind: "script",
    });

    const agents = await queryAuditEvents(auditDatabase(env.DB), { actorKind: "agent" });
    expect(agents.map((event) => event.actorKind)).toEqual(["agent"]);
  });

  test("an event with no kind still lands in a database this migration has not reached", async () => {
    // A Worker deployed ahead of its migration must keep recording every row it did before. Only an
    // event that carries a kind names the column, so nothing else depends on it existing.
    await runMigrations(env.DB, provider({ "0001_init": audit_0001_init }));
    const errors: unknown[] = [];
    const emit = createAuditEmit(auditDatabase(env.DB), { onError: (error) => errors.push(error) });
    await emit({ action: "auth/signin", outcome: "success", actorType: "user", actorId: "u1" });

    expect(errors).toEqual([]);
    expect(await env.DB.prepare("select count(*) as n from pithy_audit_events").first<{ n: number }>()).toEqual({
      n: 1,
    });
  });

  test("down drops the column and keeps every recorded event", async () => {
    const p = provider(FULL);
    await runMigrations(env.DB, p);
    await createAuditEmit(auditDatabase(env.DB))({
      action: "payments/refund_issued",
      outcome: "success",
      actorType: "control-plane",
      actorKind: "agent",
    });

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0002_actor_kind", "Down", "Success"],
    ]);
    expect(await columnNames()).not.toContain("actor_kind");
    expect(await env.DB.prepare("select action, actor_type from pithy_audit_events").first()).toEqual({
      action: "payments/refund_issued",
      actor_type: "control-plane",
    });
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider(FULL);
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    await runMigrations(env.DB, p);
    expect(await columnNames()).toContain("actor_kind");
  });
});
