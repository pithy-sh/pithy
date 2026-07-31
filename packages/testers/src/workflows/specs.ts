// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/** This capability's name, and the first segment of every workflow dispatch key. */
export const TESTERS_CAPABILITY = "testers";

/**
 * The daily pass's parameters.
 *
 * **Every field is optional, which is a requirement rather than a convenience.** A cron supplies no
 * input, and `createEntrypoint` dispatches a scheduled job with `{}` — so a schema demanding a field
 * could never run on its own schedule. The fields exist for the on-demand case: running one cohort in
 * staging, or checking what a pass would do before letting it mail twelve people.
 */
export const TestersDailyParams = z
  .object({
    cohortId: z
      .string()
      .min(1)
      .optional()
      .describe("Run the pass for one cohort only. Omit for every open cohort, which is what the cron does."),
    skipNudges: z
      .boolean()
      .optional()
      .describe(
        "Advance state and write the snapshot, but send nothing. The safe way to exercise the pass in staging against real testers.",
      ),
  })
  .describe("What one daily pass should do. Every field optional, because a cron passes none of them.");
export type TestersDailyParams = z.infer<typeof TestersDailyParams>;

/**
 * The one durable job this capability owns.
 *
 * **Daily at 05:00 UTC**, offset from storage's 03:00 sweep, the secrets rotation at 03:00, and
 * payments' 04:00 reconciliation, so four hosts in one account do not contend for the same minute.
 * Daily is the right cadence because the thing being measured is a day counter: an hourly pass would
 * write the same row twenty-four times and change the answer on none of them.
 *
 * It is a cron **and** a dispatch target. A pass nobody can run on demand cannot be tested in staging,
 * which is precisely when a developer wants to know what it will send.
 *
 * `optional: true` because the binding exists only once `pithy testers provision` has deployed the
 * host, and a project that has not provisioned it must still be able to invite testers, accept
 * confirmations, and read its cohorts.
 */
export const testersWorkflows = {
  daily: {
    binding: "TESTERS_DAILY",
    className: "TestersDailyWorkflow",
    params: TestersDailyParams,
    schedule: "0 5 * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * The jobs as a dispatch registry, keyed `testers/<job>`.
 *
 * Built here rather than through `composeWorkflows` because the host worker dispatches its own job
 * before any project-wide registry exists — and the key format comes from core's `workflowKey` either
 * way, so the two cannot drift.
 */
export const testersWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(testersWorkflows).map(([job, spec]) => {
    const key = workflowKey(TESTERS_CAPABILITY, job);
    return [key, { key, capability: TESTERS_CAPABILITY, job, spec }];
  }),
);
