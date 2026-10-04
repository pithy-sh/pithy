// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "../data/boundParameters";
import { MIGRATION_GROUP_TABLE, MIGRATION_TABLE } from "./bookkeeping";
import { forgetMigrationGroups, readGroupPosition, readMigrationGroups, recordMigrationGroup } from "./groups";

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("select name from sqlite_master where type = 'table' and name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

/** Where a group sits is a question about the ledger, so these cases write one: a row per migration, in application order, timestamped the way Kysely timestamps its own. */
const LEDGER_FROM = new Date("2026-10-03T19:00:00.000Z").getTime();
let steps = 0;

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
async function ran(group: string, migrations: readonly string[]): Promise<void> {
  await ledgerRows(migrations);
  await recordMigrationGroup(env.DB, { group, migrations });
}

/** A run that recorded nothing — an older kit's, a reset's re-apply, or one whose group write failed. */
async function ranUngrouped(migrations: readonly string[]): Promise<void> {
  await ledgerRows(migrations);
}

beforeEach(async () => {
  steps = 0;
  await env.DB.prepare(`drop table if exists ${MIGRATION_GROUP_TABLE}`).run();
  await env.DB.prepare(`drop table if exists ${MIGRATION_TABLE}`).run();
});

describe("readMigrationGroups", () => {
  test("a database nothing has grouped records none — and reading creates nothing", async () => {
    expect(await readMigrationGroups(env.DB)).toEqual([]);
    expect(await tableExists(MIGRATION_GROUP_TABLE)).toBe(false);
  });

  test("groups come back oldest first, each carrying its migrations in applied order", async () => {
    await recordMigrationGroup(env.DB, { group: "r1", migrations: ["0100_a_0001", "1000_b_0001"] });
    await recordMigrationGroup(env.DB, { group: "r2", migrations: ["1000_b_0002"] });

    expect(await readMigrationGroups(env.DB)).toEqual([
      { group: "r1", appliedAt: expect.any(Date), migrations: ["0100_a_0001", "1000_b_0001"] },
      { group: "r2", appliedAt: expect.any(Date), migrations: ["1000_b_0002"] },
    ]);
  });

  test("the recorded time is when the group applied, to the millisecond", async () => {
    const at = new Date("2026-10-03T19:52:47.611Z");
    await recordMigrationGroup(env.DB, { group: "r1", migrations: ["1000_b_0001"], at });
    expect((await readMigrationGroups(env.DB))[0]?.appliedAt).toEqual(at);
  });

  test("the same value twice extends the group rather than starting a second one", async () => {
    await recordMigrationGroup(env.DB, { group: "release-7", migrations: ["1000_b_0001"] });
    await recordMigrationGroup(env.DB, { group: "release-7", migrations: ["1000_b_0002"] });

    const groups = await readMigrationGroups(env.DB);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.migrations).toEqual(["1000_b_0001", "1000_b_0002"]);
  });

  test("recording nothing records nothing — a no-op run creates no table", async () => {
    await recordMigrationGroup(env.DB, { group: "r1", migrations: [] });
    expect(await tableExists(MIGRATION_GROUP_TABLE)).toBe(false);
  });
});

describe("readGroupPosition", () => {
  test("the group that applied last is on top, newest migration first", async () => {
    await ran("r1", ["1000_b_0001"]);
    await ran("r2", ["1000_b_0002", "1000_b_0003"]);

    expect(await readGroupPosition(env.DB, "r2")).toEqual({
      state: "top",
      migrations: ["1000_b_0003", "1000_b_0002"],
    });
  });

  test("a group under another is buried, naming what sits over it and that it is the one on top", async () => {
    await ran("r1", ["1000_b_0001"]);
    await ran("r2", ["1000_b_0002"]);

    expect(await readGroupPosition(env.DB, "r1")).toEqual({
      state: "buried",
      above: ["r2"],
      ungrouped: [],
      // `r2`'s migrations are the contiguous tip, so a refusal may send the operator to it.
      top: "r2",
    });
  });

  test("a group extended after another ran is buried too, and neither of them is on top", async () => {
    await ran("r1", ["1000_b_0001"]);
    await ran("r2", ["1000_b_0002"]);
    await ran("r1", ["1000_b_0003"]);

    // Each is inside the other, so there is no group to name as reversible: naming one would print a
    // command that refuses and names the other back.
    expect(await readGroupPosition(env.DB, "r1")).toEqual({ state: "buried", above: ["r2"], ungrouped: [] });
    expect(await readGroupPosition(env.DB, "r2")).toEqual({ state: "buried", above: ["r1"], ungrouped: [] });
  });

  test("an applied migration no group claims buries the group under it, by name", async () => {
    // What `pithy seed --redo` leaves when a migration was pending: the reset reapplies it under no group.
    await ran("r1", ["1000_b_0001"]);
    await ranUngrouped(["1000_b_0002"]);

    expect(await readGroupPosition(env.DB, "r1")).toEqual({
      state: "buried",
      above: [],
      ungrouped: ["1000_b_0002"],
    });
  });

  test("the ledger decides, not the order the group table was written in", async () => {
    // The group table says `r1` is its last row; the ledger says an ungrouped migration is the tip. The
    // ledger is what `migrateDown()` steps, so it is the ledger that answers.
    await ranUngrouped(["1000_b_0001"]);
    await ran("r1", ["1000_b_0002"]);
    await ranUngrouped(["1000_b_0003"]);

    const position = await readGroupPosition(env.DB, "r1");
    expect(position.state).toBe("buried");
    // The ungrouped migration *below* the group is not over it: only the tip is.
    expect(position).toEqual({ state: "buried", above: [], ungrouped: ["1000_b_0003"] });
  });

  test("a group whose migrations the ledger no longer holds is absent, not reversible", async () => {
    await ran("r1", ["1000_b_0001"]);
    await env.DB.prepare(`delete from ${MIGRATION_TABLE}`).run();

    expect(await readGroupPosition(env.DB, "r1")).toEqual({ state: "absent" });
  });

  test("a group this database never applied is absent, not buried", async () => {
    await ran("r1", ["1000_b_0001"]);
    expect(await readGroupPosition(env.DB, "r9")).toEqual({ state: "absent" });
  });

  test("an ungrouped database reports every group absent", async () => {
    expect(await readGroupPosition(env.DB, "r1")).toEqual({ state: "absent" });
  });
});

describe("forgetMigrationGroups", () => {
  test("forgets only the migrations named, leaving the rest of the group recorded", async () => {
    await recordMigrationGroup(env.DB, { group: "r1", migrations: ["1000_b_0001", "1000_b_0002"] });
    await forgetMigrationGroups(env.DB, ["1000_b_0002"]);

    expect(await readMigrationGroups(env.DB)).toEqual([
      { group: "r1", appliedAt: expect.any(Date), migrations: ["1000_b_0001"] },
    ]);
  });

  test("forgetting a group's last migration forgets the group, and keeps the table", async () => {
    await recordMigrationGroup(env.DB, { group: "r1", migrations: ["1000_b_0001"] });
    await forgetMigrationGroups(env.DB, ["1000_b_0001"]);

    expect(await readMigrationGroups(env.DB)).toEqual([]);
    expect(await tableExists(MIGRATION_GROUP_TABLE)).toBe(true);
  });

  test("forgetting against a database with no group table is a no-op", async () => {
    await forgetMigrationGroups(env.DB, ["1000_b_0001"]);
    expect(await tableExists(MIGRATION_GROUP_TABLE)).toBe(false);
  });
});

/**
 * D1 rejects a statement binding more than 100 parameters, and an insert binds one per column per row — so
 * one multi-row insert of this table's three columns broke at 34 migrations. That is a chain one `pithy
 * provision` of a fresh environment applies, and it broke *after* the schema was promoted: every migration
 * applied, the release ungrouped, and the one thing this table exists for impossible (#250, #694).
 */
describe("D1's bound-parameter ceiling", () => {
  const names = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `1000_b_${String(index).padStart(4, "0")}`);

  test("a run long enough to break one insert records every migration, under the cap", async () => {
    const migrations = names(120);

    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      await recordMigrationGroup(d1, { group: "release-7", migrations });
    });
    if (error) throw error;

    const worst = Math.max(...counts, 0);
    expect(worst, "nothing was bound").toBeGreaterThan(0);
    expect(
      worst,
      `one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
    ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    // Chunking lost nothing: the whole run is one group, in application order.
    expect((await readMigrationGroups(env.DB))[0]?.migrations).toEqual(migrations);
  });

  test("forgetting a long list stays under the cap too, and forgets exactly those migrations", async () => {
    const migrations = names(150);
    await recordMigrationGroup(env.DB, { group: "release-7", migrations });

    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      await forgetMigrationGroups(d1, migrations.slice(0, 120));
    });
    if (error) throw error;

    const worst = Math.max(...counts, 0);
    expect(
      worst,
      `one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
    ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    expect((await readMigrationGroups(env.DB))[0]?.migrations).toEqual(migrations.slice(120));
  });
});
