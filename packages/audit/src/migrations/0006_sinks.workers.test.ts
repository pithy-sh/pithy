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
import { audit_0005_chain } from "./0005_chain";
import { audit_0006_sinks } from "./0006_sinks";

/** Shipping's delivery state — `#824`. One row per sink; the trail is untouched. */

const FULL = {
  "0001_init": audit_0001_init,
  "0002_actor_kind": audit_0002_actor_kind,
  "0003_call_index": audit_0003_call_index,
  "0004_request_index": audit_0004_request_index,
  "0005_chain": audit_0005_chain,
  "0006_sinks": audit_0006_sinks,
};

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([{ database: "app", namespace: "audit", order: 250, migrations: FULL }]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tables(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from sqlite_master where type = 'table'").all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of ["pithy_audit_sinks", "pithy_audit_events", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("audit_0006_sinks", () => {
  test("creates one row per sink, counters starting at zero", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare("insert into pithy_audit_sinks (sink) values (?)").bind("siem").run();
    expect(await env.DB.prepare("select * from pithy_audit_sinks").first()).toEqual({
      sink: "siem",
      last_delivered_at: null,
      last_failed_at: null,
      retrying: 0,
      dead_lettered: 0,
    });
    await expect(env.DB.prepare("insert into pithy_audit_sinks (sink) values (?)").bind("siem").run()).rejects.toThrow(
      /UNIQUE|PRIMARY/,
    );
  });

  test("down drops the table and leaves the trail", async () => {
    const p = provider();
    await runMigrations(env.DB, p);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0006_sinks", "Down", "Success"],
    ]);
    expect(await tables()).not.toContain("pithy_audit_sinks");
    expect(await tables()).toContain("pithy_audit_events");
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider();
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    await runMigrations(env.DB, p);
    expect(await tables()).toContain("pithy_audit_sinks");
  });
});
