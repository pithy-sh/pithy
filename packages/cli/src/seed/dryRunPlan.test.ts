// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { Plan } from "../plan/plan";
import { seedDryRunPlan } from "./dryRunPlan";
import type { SeedRunReport } from "./run";

/** **The seed report, restated as the one plan shape (#697)** — every write an entry, nothing invented. */

const report: SeedRunReport = {
  command: "seed",
  env: "staging",
  dryRun: true,
  workers: [
    {
      worker: "api",
      sets: [
        {
          name: "0300_auth_users",
          d1: [{ database: "app", table: "pithy_auth_users", rows: 3 }],
          kv: [{ namespace: "cache", store: "flags", entries: 2 }],
          r2: [{ binding: "FILES", key: "logo.png" }],
          media: [
            { store: "images", mode: "once", action: "upload" },
            { store: "images", mode: "once", action: "skip", id: "abc" },
          ],
        },
      ],
      skippedByEnv: [],
      shared: [],
    },
  ],
  reset: [
    { database: "app", binding: "DB", migrations: 4, retained: [] },
    { database: "shared", binding: "SHARED", migrations: 2, retained: [], boundBy: ["prod"] },
  ],
};

describe("seedDryRunPlan", () => {
  test("every write is one data entry, in the report's order, and the plan is the one shape", () => {
    const plan = seedDryRunPlan(report);
    expect(Plan.parse(plan)).toEqual(plan);
    expect(plan.data).toEqual([
      { store: "d1", target: "app (DB)", count: 4, action: "reset" },
      { worker: "api", store: "d1", target: "app.pithy_auth_users", count: 3, action: "write" },
      { worker: "api", store: "kv", target: "cache/flags", count: 2, action: "write" },
      { worker: "api", store: "r2", target: "FILES/logo.png", count: 1, action: "write" },
      { worker: "api", store: "media", target: "images", count: 1, action: "upload" },
      { worker: "api", store: "media", target: "images", count: 1, action: "skip" },
    ]);
    expect(plan.files).toEqual([]);
  });

  test("a database another environment binds is kept, and said, not planned", () => {
    expect(seedDryRunPlan(report).notes).toEqual(["shared (SHARED) is bound by prod, so the reset keeps it."]);
  });

  test("in dev, the dev secrets a dry run skips are named", () => {
    expect(seedDryRunPlan({ ...report, env: "dev", reset: undefined }).notes).toEqual([
      "A real run also seeds the project's dev secrets into each Worker's .dev.vars and the local SECRETS store.",
    ]);
  });
});
