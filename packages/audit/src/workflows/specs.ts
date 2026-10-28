// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/**
 * The one durable job audit owns: the checkpoint (#822).
 *
 * Declared once, here. `capability.ts` derives its Workflow binding from this map, the host resolver derives the
 * checkpoint host's `workflows` array and its cron from it, and a caller triggers it by the `audit/checkpoint` key.
 *
 * `optional: true` because the Workflow lives in the prebuilt checkpoint host, which exists only once the project
 * deploys it. Until then an app composing audit records every event and verifies every link; only the checkpoints
 * are missing, and the verify read says so.
 */

/** The capability name — the first segment of the dispatch key and of every deployed resource name. */
export const AUDIT_CAPABILITY = "audit";

/** The checkpoint's parameters: none. A cron passes none, and every run checkpoints every chain whose head moved. */
export const AuditCheckpointParams = z
  .object({})
  .describe("One checkpoint run. No parameters: a cron passes none, and a run covers every chain whose head moved.");
export type AuditCheckpointParams = z.infer<typeof AuditCheckpointParams>;

/**
 * Audit's durable jobs, keyed by job name.
 *
 * **Hourly, on the hour's 20th minute.** The checkpoint bounds how much of a chain's tail can be rewritten unseen:
 * everything after the last checkpoint is held only by its own links. An hour is that window. A run writes one
 * small object per chain whose head moved and nothing for one that did not, so a quiet hour costs a listing. Offset
 * from the other kit hosts' hourly work at `:15`.
 */
export const auditWorkflows = {
  checkpoint: {
    binding: "AUDIT_CHECKPOINT",
    className: "AuditCheckpointWorkflow",
    params: AuditCheckpointParams,
    schedule: "20 * * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/** The binding the retention prune runs on, in the adopter's own Worker. */
export const AUDIT_PRUNE_BINDING = "AUDIT_PRUNE";

/** The prune's parameters. Every field optional, because a cron passes none. */
export const AuditPruneParams = z
  .object({
    pages: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many pages of 500 rows one chain is pruned in this pass, at most. Defaults to 20."),
  })
  .describe("One retention prune pass over every chain. A cron passes no field.");
export type AuditPruneParams = z.infer<typeof AuditPruneParams>;

/**
 * The job audit runs in the adopter's own Worker: the retention prune. Not in the checkpoint host, because the prune
 * reads the Worker's `retention` block, which exists only where `createEntrypoint` resolved it. No `className`: the
 * class is the adopter's, five lines calling `runAuditPrune` in `./prune.ts`.
 *
 * **Daily, at 02:00 UTC**, the trigger auth's and organization's purge passes share, so a Worker composing all three
 * spends one cron. Windows are counted in days, so a daily pass prunes nothing later than an hourly one would.
 *
 * `optional: true`, so a Worker composing audit boots before the adopter has bound it. Until then nothing is pruned
 * and the trail is kept, which is what a Worker with no `retention` block does anyway.
 */
export const auditAppWorkflows = {
  prune: {
    binding: AUDIT_PRUNE_BINDING,
    params: AuditPruneParams,
    schedule: "0 2 * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * The checkpoint host's jobs as a dispatch registry, keyed `audit/<job>`, with core's key format. The prune is not
 * in it: the host resolver derives the host's Workflows from this registry, and the prune is hosted elsewhere.
 */
export const auditWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(auditWorkflows).map(([job, spec]) => {
    const key = workflowKey(AUDIT_CAPABILITY, job);
    return [key, { key, capability: AUDIT_CAPABILITY, job, spec }];
  }),
);
