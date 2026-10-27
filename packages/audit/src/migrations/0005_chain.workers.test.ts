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

/** The hash chain — `#822`. Four nullable columns, never back-filled, and a unique position per chain. */

function provider(migrations: Record<string, typeof audit_0001_init>): MigrationProvider {
  const registry = createMigrationRegistry([{ database: "app", namespace: "audit", order: 250, migrations }]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const BEFORE = {
  "0001_init": audit_0001_init,
  "0002_actor_kind": audit_0002_actor_kind,
  "0003_call_index": audit_0003_call_index,
  "0004_request_index": audit_0004_request_index,
};
const FULL = { ...BEFORE, "0005_chain": audit_0005_chain };

async function columns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_audit_events')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

async function insert(eventId: string, tenant: string | null, seq: number | null): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant, chain_seq) values (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(eventId, 1, "auth/login", "success", "user", tenant, seq)
    .run();
}

beforeEach(async () => {
  for (const table of ["pithy_audit_events", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("audit_0005_chain", () => {
  test("adds the four chain columns and back-fills nothing", async () => {
    await runMigrations(env.DB, provider(BEFORE));
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant) values (?, ?, ?, ?, ?, ?)",
    )
      .bind("evt-old", 1, "auth/login", "success", "user", "acme")
      .run();
    await runMigrations(env.DB, provider(FULL));
    expect(await columns()).toEqual(expect.arrayContaining(["chain_seq", "chain_prev", "chain_hash", "chain_salt"]));
    expect(
      await env.DB.prepare("select chain_seq, chain_prev, chain_hash, chain_salt from pithy_audit_events").first(),
    ).toEqual({ chain_seq: null, chain_prev: null, chain_hash: null, chain_salt: null });
  });

  test("refuses two events at one position in a tenant's chain, and in the untenanted chain", async () => {
    await runMigrations(env.DB, provider(FULL));
    await insert("evt-1", "acme", 1);
    await insert("evt-2", "globex", 1);
    await insert("evt-3", null, 1);
    await expect(insert("evt-4", "acme", 1)).rejects.toThrow(/UNIQUE/);
    await expect(insert("evt-5", null, 1)).rejects.toThrow(/UNIQUE/);
    // Rows from before the chain share no position, so any number of them coexist.
    await insert("evt-6", null, null);
    await insert("evt-7", null, null);
  });

  test("down drops the chain and keeps every recorded event", async () => {
    const p = provider(FULL);
    await runMigrations(env.DB, p);
    await insert("evt-1", "acme", 1);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0005_chain", "Down", "Success"],
    ]);
    expect(await columns()).not.toContain("chain_seq");
    expect(await env.DB.prepare("select count(*) as n from pithy_audit_events").first<{ n: number }>()).toEqual({
      n: 1,
    });
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider(FULL);
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    await runMigrations(env.DB, p);
    expect(await columns()).toContain("chain_hash");
  });
});
