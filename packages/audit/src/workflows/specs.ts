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

/** Audit's jobs as a dispatch registry, keyed `audit/<job>`, with core's key format. */
export const auditWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(auditWorkflows).map(([job, spec]) => {
    const key = workflowKey(AUDIT_CAPABILITY, job);
    return [key, { key, capability: AUDIT_CAPABILITY, job, spec }];
  }),
);
