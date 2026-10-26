// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { audit_0001_init } from "./0001_init";
import { audit_0002_actor_kind } from "./0002_actor_kind";
import { audit_0003_call_index } from "./0003_call_index";
import { audit_0004_request_index } from "./0004_request_index";

/**
 * The events one request wrote — `#828`. A credential's reach reads the tenant a call touched off the events its
 * handler recorded in the same request, found by `request_id`, and this is the index that finds them.
 */

function provider(migrations: Record<string, typeof audit_0001_init>): MigrationProvider {
  const registry = createMigrationRegistry([{ database: "app", namespace: "audit", order: 250, migrations }]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const FULL = {
  "0001_init": audit_0001_init,
  "0002_actor_kind": audit_0002_actor_kind,
  "0003_call_index": audit_0003_call_index,
  "0004_request_index": audit_0004_request_index,
};

/** The columns of one index, in order, or an empty list when it does not exist. */
async function indexColumns(name: string): Promise<string[]> {
  const rows = await env.DB.prepare(`select name from pragma_index_info('${name}') order by seqno`).all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of ["pithy_audit_events", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("audit_0004_request_index", () => {
  test("indexes the request id", async () => {
    await runMigrations(env.DB, provider(FULL));
    expect(await indexColumns("pithy_audit_events_request_idx")).toEqual(["request_id"]);
  });

  test("down drops the index and keeps every recorded event", async () => {
    const p = provider(FULL);
    await runMigrations(env.DB, p);
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, request_id) values (?, ?, ?, ?, ?, ?)",
    )
      .bind("evt-1", 1, "controlplane/call_allowed", "success", "control-plane", "ray-1")
      .run();

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0004_request_index", "Down", "Success"],
    ]);
    expect(await indexColumns("pithy_audit_events_request_idx")).toEqual([]);
    expect(await env.DB.prepare("select count(*) as n from pithy_audit_events").first<{ n: number }>()).toEqual({
      n: 1,
    });
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider(FULL);
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    await runMigrations(env.DB, p);
    expect(await indexColumns("pithy_audit_events_request_idx")).toEqual(["request_id"]);
  });
});
