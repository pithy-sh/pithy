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

  test("the destroy-retained flag is a count the operator types", () => {
    expect(args["destroy-retained"]).toMatchObject({ type: "string" });
  });
});
