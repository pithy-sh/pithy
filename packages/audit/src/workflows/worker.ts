// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { triggerWorkflow } from "@pithy-sh/core/src/workflow/dispatch";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { workflowHostEntry } from "@pithy-sh/core/src/workflow/hostEntry";
import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import { writeCheckpoints } from "../chain/checkpoint";
import { auditDatabase } from "../data/tables";
import { auditWorkflowRetry } from "./retryPolicy";
import { AUDIT_CAPABILITY, AuditCheckpointParams, auditWorkflowRegistry } from "./specs";

/**
 * **The prebuilt checkpoint host (#822).** It hosts the one checkpoint Workflow and fires it from its cron. The app
 * Worker records the events; this one writes each chain's head and count to the checkpoint bucket, where nothing in
 * the app's request path can reach to rewrite it.
 */

/** What the host is bound to. */
export interface AuditWorkerEnv {
  /** The audit database — the app's, by default, or whichever the adopter's `audit({ database })` names. */
  DB: D1Database;
  /** The checkpoint bucket. Under an object-lock rule, nothing here can replace or delete what it writes. */
  AUDIT_CHECKPOINTS: R2Bucket;
  /** The environment served, stamped at deploy. */
  ENVIRONMENT?: string;
}

export class AuditCheckpointWorkflow extends WorkflowEntrypoint<AuditWorkerEnv, AuditCheckpointParams> {
  override async run(event: WorkflowEvent<AuditCheckpointParams>, step: WorkflowStep): Promise<void> {
    AuditCheckpointParams.parse(event.payload ?? {});
    const log = bindWorkflowContext(createWorkerLogger({ name: AUDIT_CAPABILITY }), {
      workflow: event.workflowName,
      instance: event.instanceId,
      env: this.env.ENVIRONMENT ?? "unknown",
    });
    // One step. A retry re-runs the whole pass, which is safe because a pass is idempotent: a head already
    // checkpointed is a key that exists, and the write never replaces one.
    const run = await classifiedSteps(step, auditWorkflowRetry, NonRetryableError).do("checkpoint", async () =>
      writeCheckpoints(auditDatabase(this.env.DB), this.env.AUDIT_CHECKPOINTS, new Date()),
    );
    log.info("audit checkpoint written", { written: run.written, unchanged: run.unchanged });
  }
}

export default {
  ...workflowHostEntry(AUDIT_CAPABILITY),
  /**
   * Cron entry: start one checkpoint run per fire, through the same dispatcher an on-demand run uses, so a host
   * deployed with its binding absent logs a skip rather than throwing inside a cron nobody is watching.
   */
  async scheduled(_controller: unknown, env: AuditWorkerEnv): Promise<void> {
    await triggerWorkflow(
      env as unknown as Record<string, unknown>,
      auditWorkflowRegistry,
      workflowKey(AUDIT_CAPABILITY, "checkpoint"),
      {},
      createWorkerLogger({ name: AUDIT_CAPABILITY }),
    );
  },
};
