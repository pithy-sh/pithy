// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database } from "@cloudflare/workers-types";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { emailSigningRegistry, resolveSigningKeys } from "../crypto/signingKey";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { mintBatchId } from "../send/batchIdentity";
import type { SendWorkflowBinding } from "../send/enqueue";
import { emailWorkflowRetry } from "../send/retryPolicy";
import type { EmailSender } from "../send/sender";
import { defaultTheme, EmailTheme } from "../templates/theme";
import { isLiveInstanceStatus } from "./instanceLiveness";
import { runScheduler, type SchedulerDeps } from "./scheduler";
import { runSendBatch, type SendBatchDeps } from "./sendBatch";

/**
 * The prebuilt email worker. `pithy add email` deploys one per environment (`pithy-email-staging`,
 * `pithy-email-prod`); the user authors no code for it. It hosts:
 *
 *   - `EmailSendWorkflow` — sends a batch of jobs durably (dispatch target for immediate sends and
 *     the scheduler's fan-out).
 *   - `EmailSchedulerWorkflow` — finds due jobs and fans them out into send batches.
 *   - `scheduled()` — the every-minute cron that fires the scheduler Workflow.
 *
 * The bodies (`runSendBatch`, `runScheduler`, `runSend`) are tested against Miniflare; these classes are
 * the thin durable shells. This module imports `cloudflare:workers`, so it runs only in the Workers
 * runtime (excluded from the node meta-test).
 */

/**
 * The half of the Workflows binding that answers about an instance already created.
 *
 * Declared here rather than taken from `cloudflare:workers` because the scheduler must not depend on the
 * platform types — it takes a question as a function, and this is the only place that answers it with a
 * real Workflow.
 */
export interface SendWorkflowInstances {
  /** Look an instance up by the id it was created with. Rejects when no such instance exists. */
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}

/** The email worker's env: the app + secrets databases, the send binding, the Workflow bindings, theme/config vars. */
export interface EmailWorkerEnv extends SecretsStoreEnv {
  /** The app database the per-environment jobs/events tables live in. */
  DB: D1Database;
  /** The shared, durable suppression database. */
  EMAIL_SUPPRESSIONS: D1Database;
  /** The Cloudflare Email Service send binding. */
  EMAIL: EmailSender;
  /** The send Workflow (self) — the scheduler creates batches against it, and asks after them. */
  EMAIL_SENDER: SendWorkflowBinding & SendWorkflowInstances;
  /** The scheduler Workflow (self) — fired by the cron. */
  EMAIL_SCHEDULER: { create(): Promise<unknown> };
  /** The resolved brand theme as a JSON string (the full `EmailTheme`), set at provision from the app config. */
  EMAIL_THEME?: string;
  BASE_URL: string;
  // ENVIRONMENT is inherited from SecretsStoreEnv (a `ManagedEnvironment`); never redeclare it as a plain string.
  LINK_TTL_DAYS?: string;
  MAX_ATTEMPTS?: string;
  SCHEDULER_ENABLED?: string;
  SCHEDULER_BATCH_SIZE?: string;
  SCHEDULER_MAX_JOBS?: string;
  SCHEDULER_GRACE_MS?: string;
  SCHEDULER_STUCK_MS?: string;
}

const MINUTE_MS = 60_000;

// This is a standalone worker, not assembled by `createBackend`, so the secrets capability's `compose`
// hook never runs here. Configure the shared per-invocation accessor directly from email's own slice so
// `resolveSigningKeys` reads the signing key through the one cached path.
configureSharedSecrets({ registry: emailSigningRegistry });

/** Parse the brand theme from the single `EMAIL_THEME` JSON var, validated against the schema; default if unset. */
function buildTheme(env: EmailWorkerEnv): EmailTheme {
  if (!env.EMAIL_THEME) return defaultTheme;
  return EmailTheme.parse(JSON.parse(env.EMAIL_THEME));
}

/** Assemble the send dependencies, resolving the current signing key from the secrets store. */
async function buildSendDeps(env: EmailWorkerEnv): Promise<SendBatchDeps> {
  const keys = await resolveSigningKeys(env);
  const key = keys.versions[keys.currentVersion];
  return {
    db: emailDatabase(env.DB),
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    sender: env.EMAIL,
    theme: buildTheme(env),
    baseUrl: env.BASE_URL,
    signing: key ? { key, kid: keys.currentVersion } : undefined,
    linkTtlDays: Number(env.LINK_TTL_DAYS ?? 90),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 5),
    environment: env.ENVIRONMENT,
    heartbeatAt: () => new Date(),
  };
}

/** Assemble the scheduler dependencies, dispatching each batch as a send Workflow. */
function buildSchedulerDeps(env: EmailWorkerEnv): SchedulerDeps {
  return {
    db: emailDatabase(env.DB),
    now: new Date(),
    graceMs: Number(env.SCHEDULER_GRACE_MS ?? 2 * MINUTE_MS),
    stuckMs: Number(env.SCHEDULER_STUCK_MS ?? 15 * MINUTE_MS),
    batchSize: Number(env.SCHEDULER_BATCH_SIZE ?? 50),
    maxJobs: Number(env.SCHEDULER_MAX_JOBS ?? 500),
    // The same mint as the other two dispatchers, so the three cannot drift into three id schemes.
    newBatchId: mintBatchId,
    // The batch's id is the instance's id, so this is the whole of the lookup. A rejection means the
    // instance is not there to ask — a dispatch that never landed — and that is stranded, not alive: the
    // answer may only ever veto a re-drive, so the cautious reading is the one that keeps recovering.
    batchIsAlive: async (batchId) => {
      try {
        const instance = await env.EMAIL_SENDER.get(batchId);
        const { status } = await instance.status();
        return isLiveInstanceStatus(status);
      } catch {
        return false;
      }
    },
    dispatch: async (batchId, jobIds) => {
      await env.EMAIL_SENDER.create({ id: batchId, params: { jobIds } });
    },
  };
}

/**
 * Sends a batch of jobs durably. Started for immediate sends and by the scheduler's fan-out.
 *
 * Every step runs under {@link emailWorkflowRetry}, which agrees with `errorMapping.ts` by
 * construction: a rate limit and a transient provider fault re-drive the job, and a template that does
 * not exist, a payload that will not render, or a job row that is gone fail it at once. See
 * `send/retryPolicy.ts`.
 */
export class EmailSendWorkflow extends WorkflowEntrypoint<EmailWorkerEnv, { jobIds: string[] }> {
  override async run(event: WorkflowEvent<{ jobIds: string[] }>, step: WorkflowStep): Promise<void> {
    await runSendBatch(
      await buildSendDeps(this.env),
      classifiedSteps(step, emailWorkflowRetry, NonRetryableError),
      event.payload.jobIds,
    );
  }
}

/** Finds due jobs and fans them out into send batches. Fired by the every-minute cron. */
export class EmailSchedulerWorkflow extends WorkflowEntrypoint<EmailWorkerEnv, unknown> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    await classifiedSteps(step, emailWorkflowRetry, NonRetryableError).do("dispatch-due", async () => {
      await runScheduler(buildSchedulerDeps(this.env));
    });
  }
}

export default {
  /** Cron entry: fire the scheduler Workflow every minute, unless disabled. */
  async scheduled(_controller: unknown, env: EmailWorkerEnv): Promise<void> {
    if ((env.SCHEDULER_ENABLED ?? "true") !== "false") {
      await env.EMAIL_SCHEDULER.create();
    }
  },
};
