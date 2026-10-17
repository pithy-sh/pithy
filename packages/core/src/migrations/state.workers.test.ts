// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MIGRATION_GROUP_TABLE, MIGRATION_TABLE } from "./bookkeeping";
import { recordMigrationGroup } from "./groups";
import { createMigrationRegistry } from "./registry";
import { readMigrationState } from "./state";

const noop: Migration = { up: async () => {}, down: async () => {} };

/** What this build declares for the database: two of audit's, one of the adopter's own. */
function declared(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "audit", order: 250, migrations: { "0001_init": noop, "0002_index": noop } },
    { database: "app", namespace: "app", order: 1000, migrations: { "0001_init": noop } },
  ]);
  const provider = registry.app;
  if (!provider) throw new Error("expected a provider for app");
  return provider;
}

const AUDIT_1 = "0250_audit_0001_init";
const AUDIT_2 = "0250_audit_0002_index";
const APP_1 = "1000_app_0001_init";

const LEDGER_FROM = new Date("2026-10-03T19:00:00.000Z").getTime();
let steps = 0;

/** Ledger rows, in application order, timestamped the way Kysely timestamps its own. */
async function ledgerRows(migrations: readonly string[]): Promise<void> {
  await env.DB.prepare(
    `create table if not exists ${MIGRATION_TABLE} (name varchar(255) primary key, timestamp varchar(255) not null)`,
  ).run();
  for (const name of migrations) {
    await env.DB.prepare(`insert into ${MIGRATION_TABLE} (name, timestamp) values (?, ?)`)
      .bind(name, new Date(LEDGER_FROM + steps++).toISOString())
      .run();
  }
}

/** One run: its migrations applied in the ledger, and recorded under `group`. */
async function ran(group: string, migrations: readonly string[], at?: Date): Promise<void> {
  await ledgerRows(migrations);
  await recordMigrationGroup(env.DB, { group, migrations, ...(at ? { at } : {}) });
}

beforeEach(async () => {
  steps = 0;
  await env.DB.prepare(`drop table if exists ${MIGRATION_GROUP_TABLE}`).run();
  await env.DB.prepare(`drop table if exists ${MIGRATION_TABLE}`).run();
});

describe("readMigrationState", () => {
  test("a database nothing has migrated: everything pending, nothing applied, no group", async () => {
    expect(await readMigrationState(env.DB, declared())).toEqual({
      applied: [],
      pending: [AUDIT_1, AUDIT_2, APP_1],
      undeclared: [],
      lastGroup: null,
    });
  });

  test("applied in ledger order, pending in the order they would run", async () => {
    const at = new Date("2026-10-04T08:00:00.000Z");
    await ran("release-7", [AUDIT_1, APP_1], at);

    const state = await readMigrationState(env.DB, declared());
    expect(state.applied).toEqual([AUDIT_1, APP_1]);
    expect(state.pending).toEqual([AUDIT_2]);
    expect(state.undeclared).toEqual([]);
    expect(state.lastGroup).toEqual({
      group: "release-7",
      appliedAt: at,
      migrations: [AUDIT_1, APP_1],
      position: { state: "top" },
    });
  });

  test("a migration the database holds and this build does not declare is undeclared, and still applied", async () => {
    await ran("release-7", [AUDIT_1, "0400_vault_0001_init"]);

    const state = await readMigrationState(env.DB, declared());
    expect(state.undeclared).toEqual(["0400_vault_0001_init"]);
    expect(state.applied).toEqual([AUDIT_1, "0400_vault_0001_init"]);
  });

  test("the last group is the newest, and the older one under it is not reported", async () => {
    await ran("release-6", [AUDIT_1]);
    await ran("release-7", [AUDIT_2]);

    const state = await readMigrationState(env.DB, declared());
    expect(state.lastGroup?.group).toBe("release-7");
    expect(state.lastGroup?.migrations).toEqual([AUDIT_2]);
    expect(state.lastGroup?.position).toEqual({ state: "top" });
  });

  test("a group buried under an ungrouped migration says so, and names it", async () => {
    // The state `seed --redo` reaches in the ordinary dev loop: a reset reapplies a pending migration
    // under no group, and the group below it can no longer be reversed by name.
    await ran("release-7", [AUDIT_1]);
    await ledgerRows([AUDIT_2]);

    const state = await readMigrationState(env.DB, declared());
    expect(state.lastGroup?.group).toBe("release-7");
    expect(state.lastGroup?.position).toEqual({ state: "buried", above: [], ungrouped: [AUDIT_2] });
  });

  test("a group extended over another names the group inside it", async () => {
    await ran("release-7", [AUDIT_1]);
    await ran("hotfix", [AUDIT_2]);
    await ran("release-7", [APP_1]);

    const state = await readMigrationState(env.DB, declared());
    expect(state.lastGroup?.group).toBe("release-7");
    expect(state.lastGroup?.position).toEqual({ state: "buried", above: ["hotfix"], ungrouped: [] });
  });

  test("a group whose migrations the ledger no longer holds is passed over for the one that is applied", async () => {
    // Group rows outliving their ledger rows — a migration reversed by a path that kept its row. Nothing
    // of that group is applied here, so naming it as where the environment stands would be wrong.
    await ran("release-6", [AUDIT_1]);
    await recordMigrationGroup(env.DB, { group: "release-7", migrations: [AUDIT_2] });

    const state = await readMigrationState(env.DB, declared());
    expect(state.lastGroup?.group).toBe("release-6");
    expect(state.lastGroup?.migrations).toEqual([AUDIT_1]);
  });
});
