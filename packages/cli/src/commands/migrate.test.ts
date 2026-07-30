// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { WorkerMigrationRun } from "../migrations/run";
import migrate, { formatMigrateReport } from "./migrate";

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
    expect(Object.keys(args)).toEqual(["env", "worker", "rollback", "json"]);
    expect(args.env).toMatchObject({ type: "string", default: "dev" });
    // The fan-out is the default; --worker narrows it to one worker in apps/.
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args.rollback).toMatchObject({ type: "boolean", default: false });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });

  describe("output", () => {
    test("groups by worker, one aligned line each", () => {
      const report = formatMigrateReport(
        [
          run("api", "app", "DB", ["0100_auth_0001", "0100_auth_0002"]),
          run("collab", "collab", "COLLAB_DB", ["0500_multiplayer_0001"]),
        ],
        { env: "dev", rollback: false, json: false },
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

    test("a project with nothing to migrate says so once", () => {
      const report = formatMigrateReport([{ worker: "api", databases: [] }], {
        env: "dev",
        rollback: false,
        json: false,
      });
      expect(plain(report)).toBe("Nothing to migrate.\nDone.\n");
    });

    test("--json groups per worker, in a stable shape", () => {
      const line = formatMigrateReport([run("api", "app", "DB", ["0100_auth_0001"])], {
        env: "staging",
        rollback: false,
        json: true,
      });
      expect(JSON.parse(line)).toEqual({
        command: "migrate",
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

    test("--json names the other workers on a database several share", () => {
      const shared: WorkerMigrationRun[] = [
        { worker: "api", databases: [{ database: "app", binding: "DB", results: [], sharedWith: ["collab"] }] },
        { worker: "collab", databases: [{ database: "app", binding: "DB", results: [], sharedWith: ["api"] }] },
      ];
      const parsed = JSON.parse(formatMigrateReport(shared, { env: "dev", rollback: false, json: true })) as {
        workers: { databases: { sharedWith?: string[] }[] }[];
      };
      expect(parsed.workers.map((worker) => worker.databases[0]?.sharedWith)).toEqual([["collab"], ["api"]]);
    });
  });
});
