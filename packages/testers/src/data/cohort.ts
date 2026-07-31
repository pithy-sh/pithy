// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { ResetPolicy, TesterPlatform } from "../config/config";

/**
 * One testing cohort — the row in `pithy_testers_cohorts`.
 *
 * **The target, window, and reset policy are stored on the row, not read from config at query time.**
 * A cohort runs for a fortnight and config is redeployed whenever anything else changes; if the clock
 * read its rules live, raising `targetSize` from twelve to fifteen would retroactively rewrite whether
 * last Tuesday counted, and the trend chart would silently change shape behind the developer. A cohort
 * inherits the defaults when it is created, then owns its copy for life.
 */
export const TestersCohort = z
  .object({
    id: z
      .string()
      .describe(
        "The cohort's UUID. Text rather than an autoincrement integer because cohort ids appear in control-plane responses and CLI output, and a sequential id would leak how many test programmes a project has run.",
      ),
    name: z
      .string()
      .describe("A human label for the cohort, e.g. `launch-closed-test`. Shown in the CLI and the dashboard."),
    targetPlatform: TesterPlatform.describe(
      "Which store's programme this cohort serves. Decides which registered device counts as usable when scoring a tester's health, and nothing else.",
    ),
    targetSize: z
      .number()
      .int()
      .positive()
      .describe(
        "How many testers must be opted in simultaneously. Google Play requires twelve; the value is frozen on the row so a later config change cannot rewrite whether a past day counted.",
      ),
    windowDays: z
      .number()
      .int()
      .positive()
      .describe(
        "How many continuous days the target must hold. Fourteen for Play. Frozen on the row for the same reason as `targetSize`.",
      ),
    maxRosterSize: z
      .number()
      .int()
      .positive()
      .describe(
        "The most members this cohort's roster may hold. Refusing the invitation is better than discovering the cap at the store.",
      ),
    storeOptInUrl: z
      .string()
      .nullable()
      .describe(
        "The store's own opt-in page — `https://play.google.com/apps/testing/<package>` for Play, a `https://testflight.apple.com/join/<code>` public link for TestFlight. THIS is where a tester actually enrols; Pithy's confirmation link only records that they went. Pasted from the console rather than derived, because Google documents no format for it. Null until set, and the invitation says so rather than sending anyone nowhere.",
      ),
    resetPolicy: ResetPolicy.describe(
      "Pithy's assumption about what a dip below target does to the streak. Stored per cohort so changing the project default never silently re-reads a finished cohort's history.",
    ),
    closedAt: SQLiteDate.nullable().describe(
      "When the developer closed this cohort, or null while it is running. A closed cohort stops accruing snapshots and nudges but keeps its history.",
    ),
    createdAt: SQLiteDate.describe("When the cohort was created. The zero point of its `dayIndex` axis."),
    updatedAt: SQLiteDate.describe("When the cohort row was last written."),
  })
  // The one rule that spans two fields, and therefore the one the field schemas cannot carry alone. A
  // target larger than the roster cap can never be reached, however many people accept — so it is an
  // author error, and the schema is where an author error about this table's shape belongs.
  .check((ctx) => {
    if (ctx.value.maxRosterSize < ctx.value.targetSize) {
      ctx.issues.push({
        code: "custom",
        message: `targetSize (${ctx.value.targetSize}) exceeds maxRosterSize (${ctx.value.maxRosterSize}). A cohort whose target is larger than its roster cap can never reach target.`,
        input: ctx.value,
        path: ["targetSize"],
      });
    }
  })
  .describe(
    "One testing cohort in `pithy_testers_cohorts` — the roster's owner, and the frozen copy of the rules its clock is measured against.",
  );
export type TestersCohort = z.output<typeof TestersCohort>;
export type TestersCohortRow = z.input<typeof TestersCohort>;
