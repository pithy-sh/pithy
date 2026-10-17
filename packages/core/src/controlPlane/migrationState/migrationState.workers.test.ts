// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Migration } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { defineCapability } from "../../capability/capability";
import { MIGRATION_GROUP_TABLE, MIGRATION_TABLE } from "../../migrations/bookkeeping";
import { recordMigrationGroup } from "../../migrations/groups";
import { MigrationDatabaseView } from "../http/responses";
import { composeMigrationDatabases, readDatabaseMigrations, readMigrationHealth } from "./migrationState";

/**
 * The seam's read of each bound database, against real D1. `DB` and `ANALYTICS` are two bindings, so a
 * case can hold one database readable and one not and see that the first still answers.
 */

const noop: Migration = { up: async () => {}, down: async () => {} };

const audit = defineCapability({
  name: "audit",
  requiredBindings: [],
  databases: {
    app: {
      binding: "DB",
      tables: {},
      migrations: { "0001_init": noop, "0002_index": noop },
      migrationOrder: 250,
    },
  },
});

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  databases: {
    app: { binding: "DB", tables: {}, migrations: { "0001_init": noop }, migrationOrder: 1000 },
    analytics: { binding: "ANALYTICS", tables: {}, migrations: { "0001_events": noop }, migrationOrder: 0 },
  },
});

const composed = composeMigrationDatabases([audit, app]);

/** The Worker's env as the seam reads it: the real Miniflare bindings, by name. */
const BINDINGS: Record<string, unknown> = { ...env };

function entry(database: string) {
  const found = composed.find((candidate) => candidate.database === database);
  if (!found) throw new Error(`expected ${database} to be composed`);
  return found;
}

/** A binding that answers nothing — a D1 that is there and cannot be read. */
const broken = {
  prepare: () => {
    throw new Error("D1_ERROR: SELECT name FROM pithy_migrations — the database is unavailable");
  },
};

async function ledger(database: D1Database, migrations: readonly string[]): Promise<void> {
  await database
    .prepare(
      `create table if not exists ${MIGRATION_TABLE} (name varchar(255) primary key, timestamp varchar(255) not null)`,
    )
    .run();
  let step = 0;
  for (const name of migrations) {
    await database
      .prepare(`insert into ${MIGRATION_TABLE} (name, timestamp) values (?, ?)`)
      .bind(name, new Date(Date.UTC(2026, 9, 3, 19, 0, step++)).toISOString())
      .run();
  }
}

beforeEach(async () => {
  for (const database of [env.DB, env.ANALYTICS]) {
    await database.prepare(`drop table if exists ${MIGRATION_GROUP_TABLE}`).run();
    await database.prepare(`drop table if exists ${MIGRATION_TABLE}`).run();
  }
});

describe("readDatabaseMigrations", () => {
  test("reports applied, pending and undeclared, each migration naming its namespace", async () => {
    await ledger(env.DB, ["0250_audit_0001_init", "0400_vault_0001_init"]);

    const view = await readDatabaseMigrations(BINDINGS, entry("app"));
    expect(view).toEqual({
      state: "readable",
      database: "app",
      binding: "DB",
      applied: [
        { name: "0250_audit_0001_init", namespace: "audit" },
        { name: "0400_vault_0001_init", namespace: "vault" },
      ],
      pending: [
        { name: "0250_audit_0002_index", namespace: "audit" },
        { name: "1000_app_0001_init", namespace: "app" },
      ],
      undeclared: [{ name: "0400_vault_0001_init", namespace: "vault" }],
      lastGroup: null,
    });
    // What a management client validates with is what this produced.
    expect(MigrationDatabaseView.parse(view)).toEqual(view);
  });

  test("reports the last group, when it applied, what it applied, and that it is the top", async () => {
    await ledger(env.DB, ["0250_audit_0001_init"]);
    const at = new Date("2026-10-04T08:00:00.000Z");
    await recordMigrationGroup(env.DB, { group: "release-7", migrations: ["0250_audit_0001_init"], at });

    const view = await readDatabaseMigrations(BINDINGS, entry("app"));
    expect(view.state === "readable" ? view.lastGroup : undefined).toEqual({
      group: "release-7",
      appliedAt: "2026-10-04T08:00:00.000Z",
      migrations: [{ name: "0250_audit_0001_init", namespace: "audit" }],
      position: { state: "top" },
    });
  });

  test("a buried group names what is in its way", async () => {
    await ledger(env.DB, ["0250_audit_0001_init", "0250_audit_0002_index"]);
    await recordMigrationGroup(env.DB, { group: "release-7", migrations: ["0250_audit_0001_init"] });

    const view = await readDatabaseMigrations(BINDINGS, entry("app"));
    expect(view.state === "readable" ? view.lastGroup?.position : undefined).toEqual({
      state: "buried",
      above: [],
      ungrouped: [{ name: "0250_audit_0002_index", namespace: "audit" }],
    });
  });

  test("a database that cannot be read is unreadable, and carries no count at all", async () => {
    const view = await readDatabaseMigrations({ ...BINDINGS, DB: broken }, entry("app"));
    // Not an empty list: `pending: []` would read as up to date for a database nobody read.
    expect(view).toEqual({ state: "unreadable", database: "app", binding: "DB" });
  });

  test("a binding the Worker was not given is unreadable too", async () => {
    const { DB: _, ...without } = BINDINGS;
    expect(await readDatabaseMigrations(without, entry("app"))).toEqual({
      state: "unreadable",
      database: "app",
      binding: "DB",
    });
  });

  test("tells the caller why, without putting the reason in the view", async () => {
    const seen: string[] = [];
    const view = await readDatabaseMigrations({ ...BINDINGS, DB: broken }, entry("app"), (failed) =>
      seen.push(failed.binding),
    );
    expect(seen).toEqual(["DB"]);
    expect(JSON.stringify(view)).not.toContain("D1_ERROR");
  });
});

describe("readMigrationHealth", () => {
  test("totals pending and undeclared across every bound database", async () => {
    await ledger(env.DB, ["0250_audit_0001_init", "0400_vault_0001_init"]);
    await ledger(env.ANALYTICS, ["0000_app_0001_events"]);

    expect(await readMigrationHealth(BINDINGS, composed)).toEqual({ pendingMigrations: 2, undeclaredMigrations: 1 });
  });

  test("an environment that is up to date reports zero", async () => {
    await ledger(env.DB, ["0250_audit_0001_init", "0250_audit_0002_index", "1000_app_0001_init"]);
    await ledger(env.ANALYTICS, ["0000_app_0001_events"]);

    expect(await readMigrationHealth(BINDINGS, composed)).toEqual({ pendingMigrations: 0, undeclaredMigrations: 0 });
  });

  test("throws rather than total a database it could not read", async () => {
    // A partial total is a zero for the database nobody read. The seam turns the throw into an
    // unavailable summary, which a client reads as unknown rather than as up to date.
    await expect(readMigrationHealth({ ...BINDINGS, ANALYTICS: broken }, composed)).rejects.toThrow();
  });
});
