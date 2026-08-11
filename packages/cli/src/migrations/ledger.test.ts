// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { buildDoctorReport, doctorExitCode, renderDoctorText } from "../commands/doctor";
import { buildProjectHealth } from "../doctor/health";
import { doctorHarness } from "../test-utils/doctorHarness";
import { createTable, migrateHarness } from "../test-utils/migrateHarness";
import { describeUndeclared, undeclaredRemedy } from "./ledger";
import { migrateProject, readProjectLedger } from "./run";

/**
 * A ledger row for a migration the project no longer declares — **in a real local D1**, put there the
 * way an adopter puts it there: migrate, then drop the migration from the declaration.
 *
 * The state is the whole point, so it is reproduced rather than described. A unit test over a formatter
 * would have passed on the day #282 was filed: both commands were individually self-consistent, and the
 * fault was that one of them could not see a state the other refused on. Only a database that actually
 * holds the row shows that, which is why this suite migrates through Miniflare and then asks both
 * commands about the same store.
 */

/** The `app` capability at two migrations, then at one — the collapse #276/#277 performed, in miniature. */
function board(migrations: string[]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: {
        binding: "DB",
        tables: {},
        migrationOrder: 1000,
        migrations: Object.fromEntries(migrations.map((key) => [key, createTable(key.replace(/^\d+_/, ""))])),
      },
    },
  });
}

const BOTH = ["0001_things", "0002_tenant"];
const FEWER = ["0001_things"];

describe("a ledger row the project no longer declares", () => {
  const h = migrateHarness();
  const doctor = doctorHarness();

  /** Migrate at two migrations, then hand back the Worker as it is declared now: at one. */
  async function staleLedger(): Promise<{ name: string; dir: string; capabilities: Capability[] }> {
    await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [h.api([board(BOTH)])],
      env: "dev",
      project: "acme",
    });
    return h.api([board(FEWER)]);
  }

  test("pithy migrate refuses, naming the binding, the migration, and a remedy that fits a dev store", async () => {
    const worker = await staleLedger();

    const failure: unknown = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [worker],
      env: "dev",
      project: "acme",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    const { payload } = failure as PithyError;
    // Before #282 this was, in full: "Migration run failed. / Fix the migration. Run pithy migrate again."
    expect(payload.message).toBe("DB records 1000_app_0002_tenant. This project no longer declares it.");
    expect(payload.action).toContain("delete .wrangler/state");
    // Not "fix the migration": no migration is broken, and the files it would send the reader to are fine.
    expect(payload.action).not.toContain("Fix the migration");
    // Which registries the ledger was compared against — throw-site context, never rendered.
    expect(payload.detail).toBe("Compared against the migrations composed by api for dev.");
  });

  test("nothing is pending, and the undeclared row is reported beside that", async () => {
    const worker = await staleLedger();

    expect(await readProjectLedger({ account: null, projectDir: h.projectDir, workers: [worker], env: "dev" })).toEqual(
      {
        // The subtraction that used to be the whole check. It is right, and it is not the answer.
        pending: 0,
        undeclared: [{ database: "app", binding: "DB", name: "1000_app_0002_tenant" }],
      },
    );
  });

  test("pithy doctor fails the check on it, where it used to report none pending ✓", async () => {
    const worker = await staleLedger();

    const health = await buildProjectHealth({
      account: null,
      projectDir: h.projectDir,
      env: "dev",
      workers: [{ name: worker.name, dir: worker.dir, capabilities: worker.capabilities }],
    });

    expect(health.ok).toBe(false);
    expect(health.workers[0]?.migrations).toEqual({
      ok: false,
      pending: 0,
      undeclared: [{ database: "app", binding: "DB", name: "1000_app_0002_tenant" }],
      env: "dev",
    });
  });

  test("pithy doctor prints the migration's name and exits non-zero", async () => {
    const worker = await staleLedger();

    // The real reconcile engine and the real ledger read, against the same store migrate just refused on.
    const report = await buildDoctorReport(
      doctor.baseOptions({
        projectDir: h.projectDir,
        resolveWorkers: async () => [worker] as never,
        buildPlan: undefined,
      }),
    );
    const text = renderDoctorText(report);

    expect(text).toContain("DB records 1000_app_0002_tenant. This project no longer declares it.");
    expect(text).toContain("delete .wrangler/state");
    expect(doctorExitCode(report)).toBe(1);
  });

  test("a project that still declares everything it applied migrates and reports clean", async () => {
    const workers = [h.api([board(BOTH)])];
    await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });

    const again = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    });

    expect(again[0]?.databases[0]?.results).toEqual([]);
    expect(await readProjectLedger({ account: null, projectDir: h.projectDir, workers, env: "dev" })).toEqual({
      pending: 0,
      undeclared: [],
    });
  });
});

describe("the sentence both commands print", () => {
  const entries = [{ database: "app", binding: "DB", name: "1000_app_0002_tenant" }];

  test("groups by binding and agrees with itself about how many there are", () => {
    expect(describeUndeclared(entries)).toBe("DB records 1000_app_0002_tenant. This project no longer declares it.");
    expect(
      describeUndeclared([
        ...entries,
        { database: "app", binding: "DB", name: "1000_app_0003_notes" },
        { database: "collab", binding: "COLLAB_DB", name: "0500_multiplayer_0001_rooms" },
      ]),
    ).toBe(
      "DB records 1000_app_0002_tenant, 1000_app_0003_notes. COLLAB_DB records 0500_multiplayer_0001_rooms. This project no longer declares them.",
    );
  });

  test("the remedy depends on what the database is, because that is what decides it", () => {
    // Local dev: throwing the store away costs a re-migrate.
    expect(undeclaredRemedy("dev")).toContain("delete .wrangler/state");
    // Anywhere else it is a database with rows in it, and the same advice would be data loss.
    const staging = undeclaredRemedy("staging");
    expect(staging).toContain("staging holds real rows");
    expect(staging).toContain("pithy_migrations");
    expect(staging).not.toContain(".wrangler/state");
  });
});
