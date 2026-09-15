// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withErrorReporting } from "../terminal/output";
import { appCapability, migrateHarness, multiplayerCapability } from "../test-utils/migrateHarness";
import { storeProbe } from "../test-utils/storeProbe";
import { rollbackConfirmPhrase } from "./confirm";
import { dropCapabilityTables, migrateProject, readProjectLedger, resetProject, type WorkerScope } from "./run";

/**
 * **A migration run names the store it is waiting on before it waits (#583).**
 *
 * `pithy migrate --env staging` is the command the bring-up runbook puts right before a deploy, and it
 * wrote nothing until every database had finished. It spawns nothing: it is slow because every statement
 * is a D1 REST round trip. So `ci/narration.test.ts`, which finds long commands by their captured
 * subprocesses, could not see it, and the operator watching nothing happen could not tell a slow schema
 * change from a hung one.
 *
 * The invariant is stated over the round trips themselves: **every round trip a writing run makes to a
 * remote database is made after a step, and the most recent step names that database's binding.** Not a
 * list of which lines to print — a new preflight, a second pass, a wrapper nobody has written yet all
 * make round trips, and each of those is in this population the day it is written, because the store is
 * handed to the run through its own `remoteD1` seam and records every query that leaves it.
 *
 * **Reach.** Every entry point here that writes a schema — {@link migrateProject} forward and back,
 * {@link resetProject} (`seed --redo`), {@link dropCapabilityTables} (`remove --drop`) — all of them
 * `runGroups`. It does not see a round trip that bypasses the `remoteD1` seam, and it does not see a
 * REST-bound command that is not one of these; `ci/narration.test.ts` says so where the next author reads.
 * {@link readProjectLedger} is quiet on purpose, and a test below holds that too.
 *
 * **Two things the invariant does not see, found by planting.** A store stays named until a step names
 * another, so a new round trip against the database the last step already named passes — a trailing
 * `PRAGMA optimize` on `DB` after `Applying … to DB` is credited to that step. And the invariant is about
 * stores, not migrations: removing the per-migration step leaves every round trip after `DB (app) for …`,
 * which names `DB`. That second one is held by the test that pins the steps in full, and only by it.
 */

const h = migrateHarness();

/** The two remote databases: `DB`, which two Workers share, and `COLLAB_DB`, which one Worker owns. */
const IDS = { DB: "staging-db", COLLAB_DB: "staging-collab" } as const;

let miniflare: Miniflare;
let remotes: Map<string, D1Database>;

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: IDS.DB, COLLAB_DB: IDS.COLLAB_DB },
  });
  remotes = new Map([
    [IDS.DB, (await miniflare.getD1Database("DB")) as unknown as D1Database],
    [IDS.COLLAB_DB, (await miniflare.getD1Database("COLLAB_DB")) as unknown as D1Database],
  ]);
});

afterEach(async () => {
  await miniflare.dispose();
});

/** A Worker's staging stanza, binding `bindings` to their remote ids. */
async function stanza(worker: WorkerScope, bindings: (keyof typeof IDS)[]): Promise<void> {
  const d1 = bindings.map((binding) => ({ binding, database_id: IDS[binding] }));
  await writeFile(join(worker.dir, "wrangler.jsonc"), JSON.stringify({ env: { staging: { d1_databases: d1 } } }));
}

/**
 * Three Workers over two databases: `api` and `collab` share `DB`, `board` owns `COLLAB_DB`. A shared
 * database and a lone one, so a step naming the wrong one of them is visible.
 */
async function project(): Promise<WorkerScope[]> {
  const api = h.api([appCapability()]);
  const collab = await h.worker("collab", [multiplayerCapability("DB")]);
  const board = await h.worker("board", [multiplayerCapability("COLLAB_DB")]);
  await stanza(api, ["DB"]);
  await stanza(collab, ["DB"]);
  await stanza(board, ["COLLAB_DB"]);
  return [api, collab, board];
}

/** Options for a staging run whose every database reports its round trips to `probe`. */
async function staging(probe: ReturnType<typeof storeProbe>) {
  return {
    account: null,
    projectDir: h.projectDir,
    project: "acme",
    env: "staging",
    workers: await project(),
    remoteD1: ({ binding, databaseId }: { binding: string; databaseId: string }) =>
      probe.d1(binding, remotes.get(databaseId) as D1Database),
  };
}

describe("a migration run names the database it is waiting on", () => {
  test("forward: every round trip follows a step naming its database", async () => {
    const probe = storeProbe();
    const options = await staging(probe);

    await probe.run(() => migrateProject(options));

    // Anti-vacuity: both databases were reached, and more than once each.
    expect(new Set(probe.trips.map((trip) => trip.store))).toEqual(new Set(["DB", "COLLAB_DB"]));
    expect(probe.trips.length).toBeGreaterThan(10);
    expect(probe.unnarrated()).toEqual([]);
  });

  test("it says which Workers, which database, and which migration", async () => {
    const probe = storeProbe();
    const options = await staging(probe);

    await probe.run(() => migrateProject(options));

    expect(probe.steps).toEqual([
      "Checking DB, COLLAB_DB",
      "DB (app) for api, collab",
      "Applying 0500_multiplayer_0001_rooms to DB",
      "Applying 1000_app_0001_things to DB",
      "COLLAB_DB (collab) for board",
      "Applying 0500_multiplayer_0001_rooms to COLLAB_DB",
    ]);
  });

  test("back: a rollback names each database and each migration it reverses", async () => {
    const options = await staging(storeProbe());
    await migrateProject(options);

    const probe = storeProbe();
    const rollback = { ...(await staging(probe)), rollback: true, confirmRollback: rollbackConfirmPhrase("staging") };
    await probe.run(() => migrateProject(rollback));

    expect(probe.trips.length).toBeGreaterThan(5);
    expect(probe.unnarrated()).toEqual([]);
    expect(probe.steps).toContain("Rolling back 1000_app_0001_things on DB");
  });

  test("seed --redo's reset narrates both halves", async () => {
    await migrateProject(await staging(storeProbe()));

    const probe = storeProbe();
    const options = await staging(probe);
    await probe.run(() => resetProject(options));

    expect(probe.unnarrated()).toEqual([]);
    expect(probe.steps).toContain("Rolling back 0500_multiplayer_0001_rooms on COLLAB_DB");
    expect(probe.steps).toContain("Applying 0500_multiplayer_0001_rooms to COLLAB_DB");
  });

  test("remove --drop narrates the capability it drops", async () => {
    const workers = await project();
    await migrateProject(await staging(storeProbe()));

    const probe = storeProbe();
    const [, , board] = workers as [WorkerScope, WorkerScope, WorkerScope];
    await probe.run(() =>
      dropCapabilityTables({
        capability: multiplayerCapability("COLLAB_DB"),
        workerDir: board.dir,
        persistRoot: h.projectDir,
        account: null,
        env: "staging",
        project: "acme",
        remoteD1: ({ binding, databaseId }) => probe.d1(binding, remotes.get(databaseId) as D1Database),
      }),
    );

    expect(probe.trips.length).toBeGreaterThan(0);
    expect(probe.unnarrated()).toEqual([]);
    expect(probe.steps).toContain("Rolling back 0500_multiplayer_0001_rooms on COLLAB_DB");
  });

  /**
   * **Reading the ledger says nothing, and that is decided rather than missed.** `pithy doctor` and
   * `pithy deploy`'s pre-upload check both read it, and neither is waiting on a schema change — a `▸` line
   * there would narrate a check, in the middle of output that has its own shape.
   */
  test("reading the ledger is quiet, though it reaches every database", async () => {
    const probe = storeProbe();
    const options = await staging(probe);

    await probe.run(() => readProjectLedger(options));

    expect(probe.trips.length).toBeGreaterThan(0);
    expect(probe.steps).toEqual([]);
  });

  /** #531's rule and #578's: a machine reads exactly one line, so `--json` narrates nothing at all. */
  test("under --json a run writes nothing to stdout", async () => {
    const options = await staging(storeProbe());
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await withErrorReporting(true, async () => {
        await migrateProject(options);
      });
    } finally {
      stdout.mockRestore();
    }

    expect(written).toEqual([]);
  });
});
