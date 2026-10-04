// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { readMigrationGroups } from "@pithy-sh/core/src/migrations/groups";
import type { MigrationResult } from "kysely/migration";
import { describe, expect, test } from "vitest";
import {
  appCapability,
  createTable,
  ledgerOf,
  migrateHarness,
  multiplayerCapability,
  withLocalD1,
} from "../test-utils/migrateHarness";
import { migrateProject, resetProject, type WorkerMigrationRun } from "./run";

/**
 * **A run is a group, and a rollback names one (#694).**
 *
 * The acceptance criteria of the issue, against the real local D1 `pithy migrate --env dev` writes: what a
 * forward run records, what the bare rollback now refuses, and what `--rollback --group` reverses. The
 * per-database bookkeeping has its own suite in `@pithy-sh/core` (`migrations/groups.workers.test.ts`) and
 * the refusal wordings have theirs in `./groups.test.ts`; this is the fan-out, where one run spans two
 * databases and a group has to mean the same thing in both.
 *
 * Its own file, for the reason `test-utils/migrateHarness` states: every `migrateProject` call spawns a
 * Miniflare, vitest parallelizes across files and serializes within one, so a heavy group goes in a file.
 */

/** What migrations moved, flattened across the run's workers and databases — direction included. */
function moved(runs: WorkerMigrationRun[]): [string, MigrationResult["direction"]][] {
  return runs.flatMap((run) =>
    run.databases.flatMap((database) => database.results.map((result) => [result.migrationName, result.direction])),
  ) as [string, MigrationResult["direction"]][];
}

/** The groups one of the project's local databases records, as `[group, migrations]`. */
async function groupsIn(projectDir: string, binding: string): Promise<[string, string[]][]> {
  return withLocalD1(projectDir, binding, async (db: D1Database) =>
    (await readMigrationGroups(db)).map((entry) => [entry.group, entry.migrations] as [string, string[]]),
  );
}

/** What a rejected promise threw, as a `PithyError` — or a failed assertion when it resolved. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(PithyError);
  return outcome as PithyError;
}

/** The app capability, with however many migrations the case needs on `DB`. */
function appWith(names: string[]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: {
        binding: "DB",
        tables: {},
        migrations: Object.fromEntries(names.map((name) => [name, createTable(name.slice(5))])),
        migrationOrder: 1000,
      },
    },
  });
}

describe("a forward run records its group", () => {
  const h = migrateHarness();
  const base = () => ({ account: null, projectDir: h.projectDir, env: "dev", project: "acme" });

  test("records the caller's value against every migration, in every database it touches", async () => {
    const workers = [h.api([appCapability(), multiplayerCapability()])];

    await migrateProject({ ...base(), workers, group: "release-7" });

    expect(await groupsIn(h.projectDir, "DB")).toEqual([["release-7", ["1000_app_0001_things"]]]);
    expect(await groupsIn(h.projectDir, "COLLAB_DB")).toEqual([["release-7", ["0500_multiplayer_0001_rooms"]]]);
  });

  test("a run with no group generates one ISO-8601 timestamp, and uses the same value in every database", async () => {
    const workers = [h.api([appCapability(), multiplayerCapability()])];

    await migrateProject({ ...base(), workers });

    const [app] = await groupsIn(h.projectDir, "DB");
    const [collab] = await groupsIn(h.projectDir, "COLLAB_DB");
    expect(app?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // One run is one group, however many databases it spans — the invariant the whole design rests on.
    expect(collab?.[0]).toBe(app?.[0]);
  });

  test("the same value twice extends the group — the retry case, not a conflict", async () => {
    const workers = (names: string[]) => [h.api([appWith(names)])];
    await migrateProject({ ...base(), workers: workers(["0001_things"]), group: "release-7" });

    await migrateProject({ ...base(), workers: workers(["0001_things", "0002_more"]), group: "release-7" });

    expect(await groupsIn(h.projectDir, "DB")).toEqual([["release-7", ["1000_app_0001_things", "1000_app_0002_more"]]]);
  });

  test("two runs with no group are two groups, because nothing connects them", async () => {
    const workers = (names: string[]) => [h.api([appWith(names)])];
    await migrateProject({ ...base(), workers: workers(["0001_things"]) });

    await migrateProject({ ...base(), workers: workers(["0001_things", "0002_more"]) });

    const groups = await groupsIn(h.projectDir, "DB");
    expect(groups).toHaveLength(2);
    expect(groups.map(([, migrations]) => migrations)).toEqual([["1000_app_0001_things"], ["1000_app_0002_more"]]);
  });
});

describe("the bare rollback is refused", () => {
  const h = migrateHarness();
  const base = () => ({ account: null, projectDir: h.projectDir, env: "dev", project: "acme" });

  test("names the newest group, what it holds per database, and the command that reverses it", async () => {
    const workers = [h.api([appCapability(), multiplayerCapability()])];
    await migrateProject({ ...base(), workers, group: "release-7" });

    const refused = await refusal(migrateProject({ ...base(), workers, rollback: true }));

    expect(refused.payload.message).toContain("Refusing to roll back without a group.");
    expect(refused.payload.message).toContain("The newest group is release-7");
    expect(refused.payload.message).toContain("DB holds 1000_app_0001_things");
    expect(refused.payload.message).toContain("COLLAB_DB holds 0500_multiplayer_0001_rooms");
    expect(refused.payload.action).toBe("Reverse it with pithy migrate --rollback --group release-7.");

    // It reverses nothing: both ledgers stand exactly as the migrate left them.
    await withLocalD1(h.projectDir, "DB", async (db) => expect(await ledgerOf(db)).toEqual(["1000_app_0001_things"]));
    await withLocalD1(h.projectDir, "COLLAB_DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["0500_multiplayer_0001_rooms"]),
    );
  });

  test("names each database's own newest group when they disagree, rather than choosing one", async () => {
    const workers = [h.api([appCapability(), multiplayerCapability()])];
    // A `--binding`-scoped run is how two databases come to hold different newest groups.
    await migrateProject({ ...base(), workers, binding: "DB", group: "release-6" });
    await migrateProject({ ...base(), workers, binding: "COLLAB_DB", group: "release-7" });

    const refused = await refusal(migrateProject({ ...base(), workers, rollback: true }));

    expect(refused.payload.message).toContain("These databases hold different newest groups");
    expect(refused.payload.message).toContain("DB's is release-6");
    expect(refused.payload.message).toContain("COLLAB_DB's is release-7");
    expect(refused.payload.action).toContain("--group release-6 --binding DB");
  });

  test("never prints a command the next invocation refuses, when a group was extended over another", async () => {
    // The retry case this issue is built around, and the one state where no group can be reversed at all:
    // `release-7` applied 0001, `hotfix` applied 0002, and the retry of `release-7` applied 0003. Each
    // group is inside the other. The bare refusal used to print `--rollback --group release-7`, whose own
    // refusal named `hotfix`, whose refusal named `release-7` back — a circle with no command in it.
    const workers = (names: string[]) => [h.api([appWith(names)])];
    await migrateProject({ ...base(), workers: workers(["0001_things"]), group: "release-7" });
    await migrateProject({ ...base(), workers: workers(["0001_things", "0002_fix"]), group: "hotfix" });
    const whole = workers(["0001_things", "0002_fix", "0003_more"]);
    await migrateProject({ ...base(), workers: whole, group: "release-7" });

    const refused = await refusal(migrateProject({ ...base(), workers: whole, rollback: true }));

    expect(refused.payload.message).toContain("No group holds the newest migrations");
    expect(refused.payload.message).toContain("DB's newest is release-7");
    expect(refused.payload.message).toContain("with hotfix applied over it");
    expect(refused.payload.action).toBe(
      "Only a group holding the newest migrations can be reversed, and none here does. Run pithy doctor to see where each database stands.",
    );

    // And the group it named is refused by name too, with nothing moved by either command.
    const named = await refusal(migrateProject({ ...base(), workers: whole, rollback: true, group: "release-7" }));
    expect(named.payload.message).toBe("Only the group on top can be reversed. DB applied hotfix over release-7.");
    expect(named.payload.action).not.toContain("--group");
    await withLocalD1(h.projectDir, "DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["1000_app_0001_things", "1000_app_0002_fix", "1000_app_0003_more"]),
    );
  });

  test("says so when nothing in scope records a group at all", async () => {
    // A database migrated by a kit that did not record groups: the ledger has rows, the group table has
    // none. There is nothing to name, and the refusal says that rather than inventing a group.
    const workers = [h.api([appCapability()])];
    await migrateProject({ ...base(), workers, group: "release-7" });
    await withLocalD1(h.projectDir, "DB", async (db) => {
      await db.prepare("drop table pithy_migrations_groups").run();
    });

    const refused = await refusal(migrateProject({ ...base(), workers, rollback: true }));

    expect(refused.payload.message).toContain("No database in scope records one: DB.");
  });
});

describe("a group rollback", () => {
  const h = migrateHarness();
  const base = () => ({ account: null, projectDir: h.projectDir, env: "dev", project: "acme" });

  test("reverses the group's portion of each database, in reverse chain order, and nothing outside it", async () => {
    const first = [h.api([appWith(["0001_things"])])];
    const whole = [h.api([appWith(["0001_things", "0002_more", "0003_extra"]), multiplayerCapability()])];
    await migrateProject({ ...base(), workers: first, group: "release-6" });
    await migrateProject({ ...base(), workers: whole, group: "release-7" });

    const runs = await migrateProject({ ...base(), workers: whole, rollback: true, group: "release-7" });

    expect(moved(runs)).toEqual([
      // Kysely steps down from the tip, so the newest of the group comes down first.
      ["1000_app_0003_extra", "Down"],
      ["1000_app_0002_more", "Down"],
      ["0500_multiplayer_0001_rooms", "Down"],
    ]);
    // `release-6`'s migration is untouched, and so is its bookkeeping.
    await withLocalD1(h.projectDir, "DB", async (db) => expect(await ledgerOf(db)).toEqual(["1000_app_0001_things"]));
    expect(await groupsIn(h.projectDir, "DB")).toEqual([["release-6", ["1000_app_0001_things"]]]);
    expect(await groupsIn(h.projectDir, "COLLAB_DB")).toEqual([]);
  });

  test("a generated group is reversed by passing its value back", async () => {
    const workers = [h.api([appCapability()])];
    await migrateProject({ ...base(), workers });
    const [recorded] = await groupsIn(h.projectDir, "DB");
    const generated = recorded?.[0] ?? "";

    const runs = await migrateProject({ ...base(), workers, rollback: true, group: generated });

    expect(moved(runs)).toEqual([["1000_app_0001_things", "Down"]]);
  });

  test("a group that is not the newest is refused, stating the rule and naming the group on top", async () => {
    const first = [h.api([appWith(["0001_things"])])];
    const whole = [h.api([appWith(["0001_things", "0002_more"])])];
    await migrateProject({ ...base(), workers: first, group: "release-6" });
    await migrateProject({ ...base(), workers: whole, group: "release-7" });

    const refused = await refusal(migrateProject({ ...base(), workers: whole, rollback: true, group: "release-6" }));

    expect(refused.payload.message).toBe("Only the group on top can be reversed. DB applied release-7 over release-6.");
    expect(refused.payload.action).toBe("Reverse release-7 first: pithy migrate --rollback --group release-7.");
    // Nothing moved: both migrations are still applied.
    await withLocalD1(h.projectDir, "DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["1000_app_0001_things", "1000_app_0002_more"]),
    );
  });

  test("a group no database in scope records is refused by name", async () => {
    const workers = [h.api([appCapability()])];
    await migrateProject({ ...base(), workers, group: "release-7" });

    const refused = await refusal(migrateProject({ ...base(), workers, rollback: true, group: "release-9" }));

    expect(refused.payload.message).toBe('No database in scope records group "release-9".');
    expect(refused.payload.action).toBe("Pass a group these databases record. DB's newest is release-7.");
  });

  test("narrowed by --binding, it reverses that database's portion and leaves the rest of the group applied", async () => {
    const workers = [h.api([appCapability(), multiplayerCapability()])];
    await migrateProject({ ...base(), workers, group: "release-7" });

    const runs = await migrateProject({
      ...base(),
      workers,
      rollback: true,
      group: "release-7",
      binding: "DB",
    });

    expect(moved(runs)).toEqual([["1000_app_0001_things", "Down"]]);
    await withLocalD1(h.projectDir, "COLLAB_DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["0500_multiplayer_0001_rooms"]),
    );
    // The group is still there, holding what is still applied.
    expect(await groupsIn(h.projectDir, "COLLAB_DB")).toEqual([["release-7", ["0500_multiplayer_0001_rooms"]]]);
    expect(await groupsIn(h.projectDir, "DB")).toEqual([]);
  });

  test("a database holding none of the group is left alone, and is not a group half-reversed", async () => {
    const workers = [h.api([appCapability(), multiplayerCapability()])];
    await migrateProject({ ...base(), workers, binding: "DB", group: "release-6" });
    await migrateProject({ ...base(), workers, group: "release-7" });

    // `release-7` applied only COLLAB_DB's migration: DB was already migrated under `release-6`.
    const runs = await migrateProject({ ...base(), workers, rollback: true, group: "release-7" });

    expect(moved(runs)).toEqual([["0500_multiplayer_0001_rooms", "Down"]]);
    await withLocalD1(h.projectDir, "DB", async (db) => expect(await ledgerOf(db)).toEqual(["1000_app_0001_things"]));
  });

  test("narrowed by --worker, it reverses only that Worker's own databases", async () => {
    const workers = [h.api([appCapability()]), await h.worker("board", [multiplayerCapability()])];
    await migrateProject({ ...base(), workers, group: "release-7" });

    const runs = await migrateProject({ ...base(), workers, worker: "api", rollback: true, group: "release-7" });

    expect(moved(runs)).toEqual([["1000_app_0001_things", "Down"]]);
    await withLocalD1(h.projectDir, "COLLAB_DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["0500_multiplayer_0001_rooms"]),
    );
    expect(await groupsIn(h.projectDir, "COLLAB_DB")).toEqual([["release-7", ["0500_multiplayer_0001_rooms"]]]);
  });

  test("refuses, reversing nothing, when a reset reapplied a migration under no group", async () => {
    // The dev loop: migrate under a group, add a migration, `pithy seed --redo`. The reset reapplies the
    // new migration too, under no group — so the group's own rows are still the tail of the *group table*
    // while the ledger has something else on top. Read from the group table alone, the pre-flight called
    // the group reversible, `migrateDown()` reversed the ungrouped migration, and the refusal arrived
    // after its table had been dropped.
    const first = [h.api([appWith(["0001_things"])])];
    const whole = [h.api([appWith(["0001_things", "0002_more"])])];
    await migrateProject({ ...base(), workers: first, group: "release-7" });
    await resetProject({ ...base(), workers: whole });

    const refused = await refusal(migrateProject({ ...base(), workers: whole, rollback: true, group: "release-7" }));

    expect(refused.payload.message).toBe(
      "Only the group on top can be reversed. DB applied 1000_app_0002_more (ungrouped) over release-7. Nothing records which run applied 1000_app_0002_more.",
    );
    expect(refused.payload.action).toContain("Run pithy doctor");
    // Nothing came down, least of all the migration nobody asked about.
    await withLocalD1(h.projectDir, "DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["1000_app_0001_things", "1000_app_0002_more"]),
    );
  });

  test("refuses, reversing nothing, when the group holds a migration with no down", async () => {
    // Kysely reverses a migration only `if (migration.down)`; one without it comes back `NotExecuted` and
    // stays applied. Counted as reversed, this exited 0 and printed both names as rolled back while
    // `0002_more` was still applied and still carried its `release-7` row — a group half undone, reported
    // as a complete success. The pre-flight refuses it with the newest migration still in place.
    const downless = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        app: {
          binding: "DB",
          tables: {},
          migrations: {
            "0001_things": createTable("things"),
            "0002_more": { up: createTable("more").up },
            "0003_extra": createTable("extra"),
          },
          migrationOrder: 1000,
        },
      },
    });
    const first = [h.api([appWith(["0001_things"])])];
    const whole = [h.api([downless])];
    await migrateProject({ ...base(), workers: first, group: "release-6" });
    await migrateProject({ ...base(), workers: whole, group: "release-7" });

    const refused = await refusal(migrateProject({ ...base(), workers: whole, rollback: true, group: "release-7" }));

    expect(refused.payload.message).toBe("Group release-7 cannot be reversed: DB's 1000_app_0002_more has no down.");
    expect(refused.payload.action).toBe("Give 1000_app_0002_more a down, then reverse release-7 again.");
    // Nothing came down, least of all the migration above the one that cannot.
    await withLocalD1(h.projectDir, "DB", async (db) =>
      expect(await ledgerOf(db)).toEqual(["1000_app_0001_things", "1000_app_0002_more", "1000_app_0003_extra"]),
    );
    expect(await groupsIn(h.projectDir, "DB")).toEqual([
      ["release-6", ["1000_app_0001_things"]],
      ["release-7", ["1000_app_0002_more", "1000_app_0003_extra"]],
    ]);
  });

  test("the group table survives a rollback and a full reset, as the owner stamp does", async () => {
    const workers = [h.api([appCapability()])];
    await migrateProject({ ...base(), workers, group: "release-7" });

    await migrateProject({ ...base(), workers, rollback: true, group: "release-7" });
    const tables = async (): Promise<string[]> =>
      withLocalD1(h.projectDir, "DB", async (db) => {
        const { results } = await db
          .prepare("select name from sqlite_master where type = 'table' and name like 'pithy_migrations%'")
          .all<{ name: string }>();
        return results.map((row) => row.name).sort();
      });
    // The reversed group's rows are gone; the table is not a migration, so it stays.
    expect(await tables()).toContain("pithy_migrations_groups");
    expect(await groupsIn(h.projectDir, "DB")).toEqual([]);

    await migrateProject({ ...base(), workers, group: "release-8" });
    await resetProject({ ...base(), workers });

    // A reset ends with the same migrations applied in the same order, so the group stands untouched.
    expect(await tables()).toContain("pithy_migrations_groups");
    expect(await groupsIn(h.projectDir, "DB")).toEqual([["release-8", ["1000_app_0001_things"]]]);
  });
});
