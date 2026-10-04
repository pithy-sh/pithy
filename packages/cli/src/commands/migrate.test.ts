// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { type MigrateProjectOptions, migrateProject, type WorkerMigrationRun } from "../migrations/run";
import migrate, { formatMigrateReport } from "./migrate";

/** The account the stubbed project names — a nickname *and* a pin, so both halves are asserted. */
const ACCOUNT = { accountName: "leed", accountId: "acct-leed" };

// The root config is the only thing stubbed: `requireProjectName` stays real, so the wiring test
// proves the command normalizes the configured name the same way every other resource name is.
// `projectCloudflareAccount` stands in for a config that names an account — the one source of a value.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "Acme Corp", cloudflare: ACCOUNT }),
  projectCloudflareAccount: async () => ACCOUNT,
}));

vi.mock("../migrations/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrations/run")>()),
  migrateProject: vi.fn(async (): Promise<WorkerMigrationRun[]> => []),
}));

/** Drop the saffron escape codes so an assertion compares the words, not the color. */
function plain(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point.
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/** The args are a static object literal on this command — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown };
const args = migrate.args as Record<string, ArgSpec>;

/** A worker run carrying `names` on one database, for the output assertions. */
function run(worker: string, database: string, binding: string, names: string[]): WorkerMigrationRun {
  return {
    worker,
    databases: [
      {
        database,
        binding,
        results: names.map((migrationName) => ({
          migrationName,
          direction: "Up" as const,
          status: "Success" as const,
        })),
      },
    ],
  };
}

describe("migrate command", () => {
  test("is a non-interactive, agent-drivable command with the documented flags", () => {
    expect(migrate.meta).toMatchObject({ name: "migrate" });
    // Every lifecycle command works headlessly with full flags and a --json surface (docs/CLI.md).
    expect(Object.keys(args)).toEqual([
      "env",
      "worker",
      "binding",
      "group",
      "rollback",
      "confirm-rollback",
      "destroy-retained",
      "json",
    ]);
    expect(args.env).toMatchObject({ type: "string", default: "dev" });
    // The fan-out is the default; --worker narrows it to one worker in apps/.
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args.rollback).toMatchObject({ type: "boolean", default: false });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });

  test("hands the run the project name from the root config, so every database is stamped with it", async () => {
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await migrate.run?.({ args: { env: "dev", rollback: false, json: true } } as never);
    } finally {
      stdout.mockRestore();
    }

    const [options] = vi.mocked(migrateProject).mock.calls.at(-1) ?? [];
    expect((options as MigrateProjectOptions).project).toBe("acme-corp");
    // And the --json line names it, so an agent reads which project owns what it just migrated.
    expect(JSON.parse(String(written.at(-1)))).toMatchObject({ command: "migrate", project: "acme-corp" });
  });

  /**
   * **The one that matters, and the run's own docstring says why (#226).**
   *
   * `MigrationFanOutOptions.account`: *"A remote migration alters a real schema, so the wrong account's
   * credentials would run it against another company's database."* The parameter was added, documented
   * with precisely that hazard, and this command did not supply it — so `pithy migrate --env staging`
   * in a project naming a non-default account resolved `<config>/cloudflare.json` and migrated whatever
   * those credentials reached.
   */
  test("hands the run the account the project names, so a remote migration cannot reach the default file", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await migrate.run?.({ args: { env: "staging", rollback: false, json: true } } as never);
    } finally {
      stdout.mockRestore();
    }
    const [options] = vi.mocked(migrateProject).mock.calls.at(-1) ?? [];
    expect((options as MigrateProjectOptions).account).toEqual(ACCOUNT);
  });

  describe("the run's group", () => {
    /** Run the command headlessly and hand back the options the run was given and the lines written. */
    async function invoke(args: Record<string, unknown>): Promise<{ options: MigrateProjectOptions; out: string }> {
      const written: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
      try {
        await migrate.run?.({ args } as never);
      } finally {
        stdout.mockRestore();
      }
      const [options] = vi.mocked(migrateProject).mock.calls.at(-1) ?? [];
      return { options: options as MigrateProjectOptions, out: plain(written.join("")) };
    }

    test("a run with no --group is given a generated ISO-8601 timestamp", async () => {
      const { options } = await invoke({ env: "dev", rollback: false, json: true });
      expect(options.group).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test("--group is handed through verbatim — the caller's own release stamp", async () => {
      const { options } = await invoke({ env: "dev", rollback: false, group: "release-7", json: true });
      expect(options.group).toBe("release-7");
    });

    test("a rollback with no --group is handed none, so the run refuses and names the group on top", async () => {
      // The command does not invent one here: generating a group for a rollback would ask to reverse a
      // group that never applied anything.
      const { options } = await invoke({ env: "dev", rollback: true, json: true });
      expect(options.group).toBeUndefined();
      expect(options.rollback).toBe(true);
    });

    test("--json reports the group in both directions", async () => {
      const forward = await invoke({ env: "dev", rollback: false, group: "release-7", json: true });
      expect(JSON.parse(forward.out)).toMatchObject({ rollback: false, group: "release-7" });

      const back = await invoke({ env: "dev", rollback: true, group: "release-7", json: true });
      expect(JSON.parse(back.out)).toMatchObject({ rollback: true, group: "release-7" });
    });
  });

  describe("output", () => {
    test("groups by worker, one aligned line each", () => {
      const report = formatMigrateReport(
        [
          run("api", "app", "DB", ["0100_auth_0001", "0100_auth_0002"]),
          run("collab", "collab", "COLLAB_DB", ["0500_multiplayer_0001"]),
        ],
        { project: "acme", env: "dev", rollback: false, json: false },
      );
      expect(plain(report).split("\n").slice(0, 2)).toEqual([
        "api     0100_auth_0001, 0100_auth_0002 applied.",
        "collab  0500_multiplayer_0001 applied.",
      ]);
      expect(plain(report)).toMatch(/Done\.$/m);
    });

    test("names the direction on a rollback, and says so when a worker moved nothing", () => {
      const report = formatMigrateReport(
        [run("api", "app", "DB", ["0100_auth_0002"]), run("collab", "collab", "DB", [])],
        {
          project: "acme",
          env: "dev",
          rollback: true,
          json: false,
        },
      );
      expect(plain(report).split("\n").slice(0, 2)).toEqual([
        "api     0100_auth_0002 rolled back.",
        "collab  nothing to roll back.",
      ]);
    });

    test("a successful migrate prints the group it applied under, on one line", () => {
      const report = formatMigrateReport([run("api", "app", "DB", ["0100_auth_0001"])], {
        project: "acme",
        env: "dev",
        rollback: false,
        json: false,
        group: "2026-10-03T19:52:47.611Z",
      });
      // It is the handle to everything groups add, and the alternative is making somebody run the wrong
      // command once in order to learn the right one.
      expect(plain(report)).toBe("api  0100_auth_0001 applied.\nGroup: 2026-10-03T19:52:47.611Z\nDone.\n");
    });

    test("a run that applied nothing names no group — nothing belongs to it", () => {
      const report = formatMigrateReport([run("api", "app", "DB", [])], {
        project: "acme",
        env: "dev",
        rollback: false,
        json: false,
        group: "2026-10-03T19:52:47.611Z",
      });
      expect(plain(report)).not.toContain("Group:");
    });

    test("a rollback does not print the group — the operator typed it", () => {
      const report = formatMigrateReport([run("api", "app", "DB", ["0100_auth_0001"])], {
        project: "acme",
        env: "dev",
        rollback: true,
        json: false,
        group: "release-7",
      });
      expect(plain(report)).not.toContain("Group:");
    });

    test("a project with nothing to migrate says so once", () => {
      const report = formatMigrateReport([{ worker: "api", databases: [] }], {
        project: "acme",
        env: "dev",
        rollback: false,
        json: false,
      });
      expect(plain(report)).toBe("Nothing to migrate.\nDone.\n");
    });

    test("--json groups per worker, in a stable shape", () => {
      const line = formatMigrateReport([run("api", "app", "DB", ["0100_auth_0001"])], {
        project: "acme",
        env: "staging",
        rollback: false,
        json: true,
      });
      expect(JSON.parse(line)).toEqual({
        command: "migrate",
        // The project every migrated database is stamped with — an agent reads which project ran.
        project: "acme",
        env: "staging",
        rollback: false,
        workers: [
          {
            worker: "api",
            databases: [
              {
                database: "app",
                binding: "DB",
                results: [{ migrationName: "0100_auth_0001", direction: "Up", status: "Success" }],
              },
            ],
          },
        ],
      });
    });

    test("a rollback names the database it kept because another environment binds it, once (#588)", () => {
      const kept = { database: "emailSuppressions", binding: "EMAIL_SUPPRESSIONS", results: [], boundBy: ["prod"] };
      const report = formatMigrateReport(
        [
          {
            worker: "api",
            databases: [{ database: "app", binding: "DB", results: [] }, kept],
          },
          { worker: "email", databases: [kept] },
        ],
        { project: "acme", env: "staging", rollback: true, json: false },
      );
      expect(plain(report).split("\n")).toEqual([
        "api    nothing to roll back.",
        "email  nothing to roll back.",
        "EMAIL_SUPPRESSIONS kept. prod binds it too.",
        "Done.",
        "",
      ]);
    });

    test("--destroy-retained is a whole number or a refusal, never a guess", async () => {
      const { parseDestroyRetained } = await import("../migrations/confirm");
      expect(parseDestroyRetained(undefined)).toBeUndefined();
      expect(parseDestroyRetained("5")).toBe(5);
      for (const bad of ["yes", "-1", "5.5", ""]) expect(() => parseDestroyRetained(bad)).toThrow(/row count/);
    });

    test("hands the run the rollback phrase and the retained count it was given", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await migrate.run?.({
          args: {
            env: "staging",
            rollback: true,
            json: true,
            binding: "DB",
            "confirm-rollback": "yes, i really want to roll back staging",
            "destroy-retained": "5",
          },
        } as never);
      } finally {
        stdout.mockRestore();
      }
      const [options] = vi.mocked(migrateProject).mock.calls.at(-1) ?? [];
      expect(options).toMatchObject({
        binding: "DB",
        rollback: true,
        confirmRollback: "yes, i really want to roll back staging",
        destroyRetained: 5,
      });
    });

    test("--json names the other workers on a database several share", () => {
      const shared: WorkerMigrationRun[] = [
        { worker: "api", databases: [{ database: "app", binding: "DB", results: [], sharedWith: ["collab"] }] },
        { worker: "collab", databases: [{ database: "app", binding: "DB", results: [], sharedWith: ["api"] }] },
      ];
      const parsed = JSON.parse(
        formatMigrateReport(shared, { project: "acme", env: "dev", rollback: false, json: true }),
      ) as {
        workers: { databases: { sharedWith?: string[] }[] }[];
      };
      expect(parsed.workers.map((worker) => worker.databases[0]?.sharedWith)).toEqual([["collab"], ["api"]]);
    });
  });
});
