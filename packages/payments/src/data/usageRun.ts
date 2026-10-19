// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsSubject } from "./subject";

/**
 * Why a subject was not reported on one run. Each is counted and named, and none is ever turned into a
 * number: a skip bills last period's number and leaves a line an operator can act on, where a guess bills a
 * wrong one silently.
 */
export const UsageFindingReason = z
  .enum(["unanswered", "not_integer", "negative", "below_min", "above_max", "resolver_failed", "report_failed"])
  .describe(
    "Why a subject was not reported: the resolver answered nothing, answered a non-integer, a negative, a count outside the product's min or max, or threw — or the store refused the report.",
  );
export type UsageFindingReason = z.infer<typeof UsageFindingReason>;

/** One subject a run did not report, and why. */
export const UsageFinding = z
  .object({
    subjectType: PaymentsSubject.shape.subjectType.describe("Whether `subjectId` names a user or an organization."),
    subjectId: PaymentsSubject.shape.subjectId.describe("The subject."),
    productId: z.string().describe("The product whose count was not reported."),
    reason: UsageFindingReason.describe("Why."),
  })
  .describe("One subject a usage run did not report, and why.");
export type UsageFinding = z.infer<typeof UsageFinding>;

/** The most findings one run keeps by name. The counts are always whole; the names are a sample past this. */
export const MAX_USAGE_FINDINGS = 100;

/**
 * One usage-reporting pass, kept — the row in `pithy_payments_usage_runs`. The same shape and the same
 * reason as `pithy_payments_reconcile_runs`: a silent job and a job that is not running look identical, and
 * a run that reported nothing is the answer to "is it healthy".
 */
export const PaymentsUsageRun = z
  .object({
    id: z.string().describe("The run's UUID."),
    startedAt: SQLiteDate.describe("When the pass began."),
    finishedAt: SQLiteDate.describe("When the pass finished."),
    scanned: z.number().int().nonnegative().describe("Subscriptions examined."),
    reported: z.number().int().nonnegative().describe("Periods a store accepted a report for on this run."),
    sampled: z.number().int().nonnegative().describe("Daily-peak samples taken for a day still open."),
    alreadyReported: z
      .number()
      .int()
      .nonnegative()
      .describe("Periods found already reported or claimed, so nothing was sent. The replay count."),
    skipped: z.number().int().nonnegative().describe("Subjects whose resolver answered nothing."),
    invalid: z
      .number()
      .int()
      .nonnegative()
      .describe("Subjects whose resolver answered a non-integer, a negative, or a count outside min and max."),
    failed: z.number().int().nonnegative().describe("Subjects whose resolver threw, or whose report a store refused."),
    findings: sqliteJson(z.array(UsageFinding)).describe(
      `The subjects not reported, and why — up to ${MAX_USAGE_FINDINGS}. The counts above are whole either way.`,
    ),
    createdAt: SQLiteDate.describe("When this row was written."),
  })
  .describe("One usage-reporting pass — when it ran and its tally — the row in `pithy_payments_usage_runs`.");
export type PaymentsUsageRun = z.output<typeof PaymentsUsageRun>;
export type PaymentsUsageRunRow = z.input<typeof PaymentsUsageRun>;
