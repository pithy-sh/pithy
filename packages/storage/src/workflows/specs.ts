// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/**
 * The one durable job storage owns: the orphan sweep.
 *
 * Declared once, here. `capability.ts` derives its Workflow binding from this map, `provision/`
 * derives the host worker's `workflows` array and its cron from it, and any caller triggers it by the
 * `storage/sweep` key. There is no second place where the binding name, the class name, or the
 * schedule is written down, so none of them can drift.
 *
 * `optional: true` because the Workflow lives in the prebuilt sweep worker, which exists only once
 * `pithy storage provision` has run. Until then an app composing storage must still boot and serve
 * every upload and download route; an absent binding degrades to a logged skip.
 */

/** The capability name — the first segment of the dispatch key and of every deployed resource name. */
export const STORAGE_CAPABILITY = "storage";

/**
 * The sweep's parameters. Every field is optional, which is a requirement rather than a convenience:
 * a cron supplies no input, and `createEntrypoint` dispatches a scheduled job with `{}`. A schema
 * that demanded a field could never run on its schedule.
 */
export const StorageSweepParams = z
  .object({
    olderThanSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Override how old a `pending` row must be before it is reclaimed. Omitted uses the config's `pendingTtlSeconds`. Lower it to reproduce a reclaim in staging without waiting a day.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Report what would be reclaimed and delete nothing. The safe way to answer 'what is this sweep about to do to production' before letting it run.",
      ),
    maxPages: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Cap how many 1,000-key bucket pages one run scans. A bound on the work, so a first sweep over a very large bucket finishes rather than running until it is killed.",
      ),
  })
  .describe("What one orphan-sweep run should do. Every field optional, because a cron passes none of them.");
export type StorageSweepParams = z.infer<typeof StorageSweepParams>;

/**
 * Storage's durable jobs, keyed by job name.
 *
 * The schedule is daily at 03:00 UTC. Divergence between the bucket and the table accumulates slowly
 * — an abandoned upload here, an interrupted delete there — so an hourly pass would list the whole
 * bucket twenty-four times to find nothing. It is a cron *and* a dispatch target: a sweep nobody can
 * run on demand cannot be tested in staging, which is precisely when you want to know what it does.
 */
export const storageWorkflows = {
  sweep: {
    binding: "STORAGE_SWEEP",
    className: "StorageSweepWorkflow",
    params: StorageSweepParams,
    schedule: "0 3 * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * Storage's jobs as a dispatch registry, keyed `storage/<job>`. Built here rather than through
 * `composeWorkflows` because the sweep worker dispatches its own job before any project-wide registry
 * exists — and the key format comes from core's {@link workflowKey} either way, so the two cannot drift.
 */
export const storageWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(storageWorkflows).map(([job, spec]) => {
    const key = workflowKey(STORAGE_CAPABILITY, job);
    return [key, { key, capability: STORAGE_CAPABILITY, job, spec }];
  }),
);
