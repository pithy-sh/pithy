// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
import { defaultRemoveSteps } from "../capabilities/remove";
import { seedProject } from "../seed/run";
import { appCapability, migrateHarness, multiplayerCapability } from "../test-utils/migrateHarness";
import {
  type DropCapabilityOptions,
  dropCapabilityTables,
  type MigrateProjectOptions,
  migrateProject,
  resetProject,
} from "./run";

/**
 * The cross-project guard: a run carrying a project stamps the databases it migrates, and refuses one
 * another project already owns. Its own file because every case boots Miniflare, and Vitest only
 * parallelizes across files (see `test-utils/migrateHarness.ts`).
 */
describe("project ownership", () => {
  const h = migrateHarness();

  /** Read the local D1's owner stamp straight out of the shared Miniflare store. */
  async function ownerOf(binding = "DB"): Promise<{ project: string } | null> {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { [binding]: binding },
      d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
    });
    try {
      const db = await miniflare.getD1Database(binding);
      return await db.prepare("select project from pithy_migrations_owner").first<{ project: string }>();
    } finally {
      await miniflare.dispose();
    }
  }

  /** Whether a table exists in the local D1 — the proof that a refused run applied nothing. */
  async function hasTable(name: string): Promise<boolean> {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { DB: "DB" },
      d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
    });
    try {
      const db = await miniflare.getD1Database("DB");
      const row = await db
        .prepare("select name from sqlite_master where type = 'table' and name = ?")
        .bind(name)
        .first<{ name: string }>();
      return row !== null;
    } finally {
      await miniflare.dispose();
    }
  }

  test("stamps the project on the first run, and re-runs clean", async () => {
    const workers = [h.api([appCapability()])];

    const first = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    });
    expect(first[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
    expect((await ownerOf())?.project).toBe("acme");

    // Idempotent: the same project migrates again with nothing to do and no complaint.
    const second = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    });
    expect(second[0]?.databases[0]?.results).toEqual([]);
    expect((await ownerOf())?.project).toBe("acme");
  });

  test("refuses a database another project owns, naming both, and applies nothing", async () => {
    await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [h.api([appCapability()])],
      env: "dev",
      project: "acme",
    });

    // A second project, its own capability, pointed at the same local D1 by the same binding.
    const failure = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [h.api([multiplayerCapability("DB")])],
      env: "dev",
      project: "beta",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    const payload = (failure as PithyError).payload;
    expect(payload.code).toBe("core/conflict");
    expect(payload.message).toContain("acme");
    expect(payload.message).toContain("beta");
    expect(payload.message).toContain("DB");
    expect(payload.action).toBeTruthy();

    // Nothing of beta's landed, and acme still owns the database.
    expect(await hasTable("rooms")).toBe(false);
    expect((await ownerOf())?.project).toBe("acme");
  });

  test("a rollback is guarded too — the foreign project cannot step acme's schema back", async () => {
    const workers = [h.api([appCapability()])];
    await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });

    await expect(
      migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "beta", rollback: true }),
    ).rejects.toThrow(/acme/);

    expect(await hasTable("things")).toBe(true);
  });

  test("a reset is guarded too — a foreign project cannot rebuild the schema", async () => {
    const workers = [h.api([appCapability()])];
    await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });

    // `pithy seed --redo` rolls every applied migration's `down` before reseeding — the most destructive
    // thing the CLI does. It must carry the project through to the same guard `pithy migrate` passes.
    await expect(
      seedProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "beta", redo: true }),
    ).rejects.toThrow(/acme/);
    expect(await hasTable("things")).toBe(true);
  });

  test("a capability drop is guarded too — through the step `pithy remove` actually builds", async () => {
    await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [h.api([appCapability()])],
      env: "dev",
      project: "acme",
    });

    // Driven through `defaultRemoveSteps`, not `dropCapabilityTables` directly. Calling the seam with a
    // project the real caller never passed is exactly how this path shipped unguarded: the assertion
    // held while `pithy remove` dropped another project's tables and exited 0.
    const steps = defaultRemoveSteps({
      account: null,
      projectDir: h.projectDir,
      workerDir: join(h.projectDir, "apps", "api"),
      loadCapabilities: async () => [appCapability()],
      project: "beta",
    });

    await expect(steps.dropTables(appCapability(), "dev")).rejects.toThrow(/acme/);
    expect(await hasTable("things")).toBe(true);
  });

  test("two workers sharing one database both claim the same owner — the supported topology", async () => {
    const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability("DB")])];

    const runs = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    });
    expect(runs.map((run) => run.worker)).toEqual(["api", "collab"]);
    expect((await ownerOf())?.project).toBe("acme");
  });

  /**
   * The class, not the instances. Enumerating call sites is how this guard went half-wired in the first
   * place: `pithy migrate` and `pithy seed` carried a project, `pithy remove`, `pithy add`, `pithy
   * upgrade`, and all three `pithy feature` paths did not, and the docs claimed the protection anyway.
   *
   * So the pin is on the choke point every write shares. Each entry point that can change a database
   * funnels through one claim pass, and that pass now refuses rather than shrugging — the guard cannot
   * be *reached* without a project, so no present or future caller can slip past it by forgetting one.
   * The casts stand in for that caller: production cannot even express these calls, because `project` is
   * a required field on every write entry point's options and `tsc` is the first of the two gates.
   */
  test("no write reaches a database without a project — every entry point, at the one choke point", async () => {
    const workers = [h.api([appCapability()])];
    const nameless = { projectDir: h.projectDir, workers, env: "dev" } as unknown as MigrateProjectOptions;

    await expect(migrateProject(nameless)).rejects.toThrow(/project name/i);
    await expect(migrateProject({ ...nameless, rollback: true })).rejects.toThrow(/project name/i);
    await expect(resetProject(nameless)).rejects.toThrow(/project name/i);
    await expect(
      dropCapabilityTables({
        capability: appCapability(),
        workerDir: join(h.projectDir, "apps", "api"),
        persistRoot: h.projectDir,
        env: "dev",
      } as unknown as DropCapabilityOptions),
    ).rejects.toThrow(/project name/i);

    // Refused before Kysely ran: nothing applied, and nothing stamped for the next project to inherit.
    expect(await hasTable("things")).toBe(false);
  });

  test("an empty project name is refused too — a caller cannot opt out by passing nothing", async () => {
    await expect(
      migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
        env: "dev",
        project: "  ",
      }),
    ).rejects.toThrow(/project name/i);
    expect(await hasTable("things")).toBe(false);
  });
});
