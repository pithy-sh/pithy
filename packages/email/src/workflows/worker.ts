// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { requireHostEnv } from "@pithy-sh/core/src/workflow/hostEnv";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { emailSigningRegistry, resolveSigningKeys } from "../crypto/signingKey";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { mintBatchId } from "../send/batchIdentity";
import type { SendWorkflowBinding } from "../send/enqueue";
import { emailWorkflowRetry } from "../send/retryPolicy";
import type { EmailSender } from "../send/sender";
import { createEmailHostApp } from "./hostApp";
import { type EmailHostEnv, emailHostEnv } from "./hostEnv";
import { isLiveInstanceStatus } from "./instanceLiveness";
import type { SendWorkflowInstances } from "./instances";
import { runScheduler, type SchedulerDeps } from "./scheduler";
import { type BatchSendReport, runSendBatch, type SendBatchDeps } from "./sendBatch";

/**
 * The prebuilt email worker. `pithy add email` deploys one per environment (`pithy-email-staging`,
 * `pithy-email-prod`); the user authors no code for it. It hosts:
 *
 *   - `EmailSendWorkflow` — sends a batch of jobs durably (dispatch target for immediate sends and
 *     the scheduler's fan-out).
 *   - `EmailSchedulerWorkflow` — finds due jobs and fans them out into send batches.
 *   - `scheduled()` — the every-minute cron that fires the scheduler Workflow.
 *   - `fetch()` — the loopback dispatch door, served only in `dev` (see {@link createEmailHostApp}).
 *
 * The bodies (`runSendBatch`, `runScheduler`, `runSend`) are tested against Miniflare; these classes are
 * the thin durable shells. This module imports `cloudflare:workers`, so it runs only in the Workers
 * runtime (excluded from the node meta-test).
 *
 * **Every entry validates the env first** (pithy-sh/pithy#410). Fourteen settings arrived here from a
 * provisioning run and none of them was checked: a missing `BASE_URL` became a magic link to
 * `undefined/…`, an unparseable `EMAIL_THEME` threw inside a render step, and a `SCHEDULER_BATCH_SIZE`
 * of `"fifty"` became `NaN` and the scheduler claimed nothing, forever, in silence. Now
 * {@link emailHostEnv} is parsed before anything reads a value, the coercions and defaults live in
 * that one schema rather than at each reader, and a host that cannot work says so in one block and
 * refuses.
 */

/**
 * The email worker's env as the runtime hands it over — bindings as objects, every var as a string.
 *
 * The *shape the host runs on* is {@link EmailHostEnv}, which is this parsed: numbers as numbers, the
 * theme as a validated `EmailTheme`, `SCHEDULER_ENABLED` as a boolean. This type stays because it is
 * what a `WorkflowEntrypoint` is generic over and what the platform actually binds.
 */
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

// This is a standalone worker, not assembled by `createBackend`, so the secrets capability's `compose`
// hook never runs here. Configure the shared per-invocation accessor directly from email's own slice so
// `resolveSigningKeys` reads the signing key through the one cached path.
configureSharedSecrets({ registry: emailSigningRegistry });

/** The dispatch door. Built once per isolate; the environment gate reads its answer per request. */
const app = createEmailHostApp();

/**
 * The env, parsed — or one legible block naming every unusable setting and what fills it, then a
 * refusal. Called at the top of every entry, and the block is written once per env object.
 */
function hostConfig(env: EmailWorkerEnv): EmailHostEnv {
  return requireHostEnv(emailHostEnv, env);
}

/** Assemble the send dependencies, resolving the current signing key from the secrets store. */
async function buildSendDeps(env: EmailWorkerEnv): Promise<SendBatchDeps> {
  const config = hostConfig(env);
  const keys = await resolveSigningKeys(env);
  const key = keys.versions[keys.currentVersion];
  return {
    db: emailDatabase(env.DB),
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    sender: env.EMAIL,
    theme: config.EMAIL_THEME,
    baseUrl: config.BASE_URL,
    signing: key ? { key, kid: keys.currentVersion } : undefined,
    linkTtlDays: config.LINK_TTL_DAYS,
    maxAttempts: config.MAX_ATTEMPTS,
    environment: config.ENVIRONMENT,
    heartbeatAt: () => new Date(),
  };
}

/** Assemble the scheduler dependencies, dispatching each batch as a send Workflow. */
function buildSchedulerDeps(env: EmailWorkerEnv): SchedulerDeps {
  const config = hostConfig(env);
  return {
    db: emailDatabase(env.DB),
    now: new Date(),
    graceMs: config.SCHEDULER_GRACE_MS,
    stuckMs: config.SCHEDULER_STUCK_MS,
    batchSize: config.SCHEDULER_BATCH_SIZE,
    maxJobs: config.SCHEDULER_MAX_JOBS,
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
  // The batch report is the instance's output (#380). A job whose step spent its retries is contained
  // so the rest of the batch still sends, and this is where an operator reads which ones those were —
  // beside the failed step in the same instance. It carries job ids and outcomes, never a recipient.
  override async run(event: WorkflowEvent<{ jobIds: string[] }>, step: WorkflowStep): Promise<BatchSendReport> {
    return await runSendBatch(
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
    if (hostConfig(env).SCHEDULER_ENABLED) {
      await env.EMAIL_SCHEDULER.create();
    }
  },

  /**
   * The loopback dispatch door — how a sibling worker under `pithy dev` starts a send batch on this
   * host's own same-script Workflow binding (pithy-sh/pithy#410). Refused in every other environment,
   * where the cross-script binding is the only path in.
   *
   * The env is validated before the router sees the request: a host that cannot work must not accept
   * a dispatch and then lose it. The refusal is `core/internal` and the block is already in the log,
   * which is what its action line points the operator at.
   */
  async fetch(request: Request, env: EmailWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    hostConfig(env);
    return await app.fetch(request, env, ctx);
  },
};
