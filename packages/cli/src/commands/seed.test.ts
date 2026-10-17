// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import seed, { renderSeedText } from "./seed";

/** The args are a static object literal on this command — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown };
const args = seed.args as Record<string, ArgSpec>;

describe("seed command", () => {
  test("is a non-interactive, agent-drivable command with the documented flags", () => {
    expect(seed.meta).toMatchObject({ name: "seed" });
    // Every lifecycle command works headlessly with full flags and a --json surface (docs/CLI.md).
    expect(Object.keys(args)).toEqual([
      "env",
      "worker",
      "json",
      "dry-run",
      "redo",
      "confirm-reset",
      "destroy-retained",
      "yes",
      "confirm-production",
      "host",
    ]);
    // The fan-out over apps/* is the default; --worker narrows it to one worker.
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args.env).toMatchObject({ type: "string", default: "dev" });
    expect(args.json).toMatchObject({ type: "boolean" });
    expect(args["dry-run"]).toMatchObject({ type: "boolean" });
    expect(args.redo).toMatchObject({ type: "boolean", default: false });
    expect(args["confirm-production"]).toMatchObject({ type: "string" });
    // A reset is gated separately from --yes, so it has its own phrase flag (docs/CLI.md §7.5).
    expect(args["confirm-reset"]).toMatchObject({ type: "string" });
  });
});

describe("a --redo that meets retained tables and shared databases (#588)", () => {
  const reset = [
    {
      database: "secrets",
      binding: "SECRETS",
      migrations: 1,
      retained: ["pithy_secrets_rotations", "pithy_secrets_system_secrets"],
    },
    { database: "emailSuppressions", binding: "EMAIL_SUPPRESSIONS", migrations: 1, retained: [], boundBy: ["prod"] },
  ];

  test("a dry run names the retained tables a real reset refuses to drop, and the database it keeps", () => {
    const text = renderSeedText({ command: "seed", env: "staging", dryRun: true, workers: [], reset });
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Would reset secrets (SECRETS): 1 migration. Retained: pithy_secrets_rotations, pithy_secrets_system_secrets.",
      "Kept emailSuppressions (EMAIL_SUPPRESSIONS): prod binds it too.",
    ]);
  });

  // `Dry run. Nothing written.` stands in place of `Done.`, as on every other dry run (#697): a run that wrote
  // nothing has not finished anything, and a transcript that ends `Done.` says it did.
  test("a dry run ends with the dry-run line, never Done., and a real run ends with Done.", () => {
    const planned = renderSeedText({ command: "seed", env: "staging", dryRun: true, workers: [], reset: [] });
    expect(planned.split("\n").at(-1)).toBe("Dry run. Nothing written.");
    expect(planned).not.toContain("Done");
    const written = renderSeedText({ command: "seed", env: "staging", dryRun: false, workers: [], reset: [] });
    expect(written.split("\n").at(-1)).toBe("Done.");
  });

  test("the destroy-retained flag is a count the operator types", () => {
    expect(args["destroy-retained"]).toMatchObject({ type: "string" });
  });
});

/**
 * A real run's line says what landed, not only what the fixtures planned (#764). Every write is
 * `INSERT OR IGNORE` or put-if-absent, so a re-run plans the same rows and writes none of them; a line
 * that kept printing `12 rows.` told the reader something was seeded when nothing was.
 */
describe("a real run reports what landed", () => {
  function run(set: {
    d1?: { database: string; table: string; rows: number; written?: number }[];
    kv?: { namespace: string; store: string; entries: number; written?: number }[];
    r2?: { binding: string; key: string; written?: boolean }[];
  }): string {
    const line = renderSeedText({
      command: "seed",
      env: "dev",
      dryRun: false,
      workers: [
        {
          worker: "api",
          sets: [{ name: "0200_demo", d1: set.d1 ?? [], kv: set.kv ?? [], r2: set.r2 ?? [], media: [] }],
          skippedByEnv: [],
          shared: [],
        },
      ],
    }).split("\n")[0];
    return line ?? "";
  }

  test("a first run that wrote every planned row reads as it always did", () => {
    expect(run({ d1: [{ database: "app", table: "t", rows: 12, written: 12 }] })).toBe("api  0200_demo: 12 rows.");
  });

  test("a re-run that wrote nothing says the rows were already there", () => {
    expect(
      run({
        d1: [{ database: "app", table: "t", rows: 12, written: 0 }],
        kv: [{ namespace: "cache", store: "s", entries: 1, written: 0 }],
        r2: [{ binding: "FILES", key: "logo.svg", written: false }],
      }),
    ).toBe("api  0200_demo: 12 rows already there, 1 entry already there, 1 object already there.");
  });

  test("a partial run names what landed and what was already there", () => {
    expect(
      run({
        d1: [
          { database: "app", table: "a", rows: 2, written: 2 },
          { database: "app", table: "b", rows: 10, written: 1 },
        ],
        r2: [
          { binding: "FILES", key: "a.svg", written: true },
          { binding: "FILES", key: "b.svg", written: false },
        ],
      }),
    ).toBe("api  0200_demo: 3 rows, 9 already there, 1 object, 1 already there.");
  });

  test("a dry run plans counts, and has nothing landed to report", () => {
    const text = renderSeedText({
      command: "seed",
      env: "dev",
      dryRun: true,
      workers: [
        {
          worker: "api",
          sets: [{ name: "0200_demo", d1: [{ database: "app", table: "t", rows: 12 }], kv: [], r2: [], media: [] }],
          skippedByEnv: [],
          shared: [],
        },
      ],
    });
    expect(text.split("\n")[0]).toBe("api  0200_demo: 12 rows.");
  });
});
