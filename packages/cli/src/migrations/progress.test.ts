// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { appCapability, createTable, migrateHarness } from "../test-utils/migrateHarness";
import { migratedBeforeFailure, migrateProject } from "./run";

/**
 * **What a fan-out that died partway says it did (#380).**
 *
 * `runGroups` visits one database at a time and each visit is a write. Until #380 a throw from the
 * second database's pass propagated out of the loop and took the whole per-Worker report with it — so
 * `pithy migrate` said a migration failed and said nothing about the database that had already moved.
 * That is the record an operator needs first when a run dies mid-fan-out.
 *
 * These tests exist to fail when that guard is removed. Each one asserts a fact that the bare loop
 * cannot produce: the report of a database that migrated *before* the failure, the name of the one that
 * threw, and the names of the ones never opened.
 */

/** A migration whose `up` throws — the plant. Its `down` is never reached. */
const explodes: Migration = {
  up: async () => {
    throw new Error("planted: this migration will not apply");
  },
  down: async () => {},
};

/** A capability on its own binding whose one migration refuses to apply. */
function brokenCapability(): Capability {
  return defineCapability({
    name: "broken",
    requiredBindings: [],
    databases: {
      broken: { binding: "BROKEN_DB", tables: {}, migrations: { "0001_boom": explodes }, migrationOrder: 2000 },
    },
  });
}

/** A third, healthy capability — the database the run never reaches. */
function extraCapability(): Capability {
  return defineCapability({
    name: "extra",
    requiredBindings: [],
    databases: {
      extra: {
        binding: "EXTRA_DB",
        tables: {},
        migrations: { "0001_extra": createTable("extra") },
        migrationOrder: 3000,
      },
    },
  });
}

describe("a fan-out that fails partway", () => {
  const h = migrateHarness();

  async function run(): Promise<unknown> {
    const workers = [
      h.api([appCapability()]),
      await h.worker("broken", [brokenCapability()]),
      await h.worker("extra", [extraCapability()]),
    ];
    return await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    }).then(
      () => {
        throw new Error("expected the planted migration to fail the run");
      },
      (error: unknown) => error,
    );
  }

  test("still throws, and the failure is the one that happened", async () => {
    const error = await run();
    expect(error).toBeInstanceOf(PithyError);
  });

  test("names the database that migrated before the failure", async () => {
    const progress = migratedBeforeFailure(await run());
    expect(progress?.migrated).toEqual([
      { worker: "api", databases: [{ database: "app", binding: "DB", results: expect.anything() }] },
      { worker: "broken", databases: [] },
      { worker: "extra", databases: [] },
    ]);
    expect(progress?.migrated[0]?.databases[0]?.results.map((result) => result.migrationName)).toEqual([
      "1000_app_0001_things",
    ]);
  });

  test("names the database it died on", async () => {
    const progress = migratedBeforeFailure(await run());
    expect(progress?.failed).toEqual({ binding: "BROKEN_DB", database: "broken" });
  });

  test("names the databases it never opened, which is not the same as the ones with nothing to do", async () => {
    const progress = migratedBeforeFailure(await run());
    expect(progress?.unreached).toEqual([{ binding: "EXTRA_DB", database: "extra" }]);
  });

  test("carries nothing derived from the throw — two names per database, and no reason", async () => {
    const progress = migratedBeforeFailure(await run());
    expect(Object.keys(progress?.failed ?? {}).sort()).toEqual(["binding", "database"]);
    expect(JSON.stringify(progress)).not.toContain("planted");
  });

  test("a run that succeeds carries no report at all", async () => {
    const workers = [h.api([appCapability()])];
    await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });
    // And a throw from anywhere else reads back `undefined` rather than an empty record that would look
    // like a run which changed nothing.
    expect(migratedBeforeFailure(new Error("unrelated"))).toBeUndefined();
  });
});
