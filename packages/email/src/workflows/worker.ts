// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { emailSigningRegistry, resolveSigningKeys } from "../crypto/signingKey";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import type { SendWorkflowBinding } from "../send/enqueue";
import { runSend, type SendDeps } from "../send/runSend";
import type { EmailSender } from "../send/sender";
import { defaultTheme, EmailTheme } from "../templates/theme";
import { runScheduler, type SchedulerDeps } from "./scheduler";

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

/** The email worker's env: the app + secrets databases, the send binding, the Workflow bindings, theme/config vars. */
export interface EmailWorkerEnv extends SecretsStoreEnv {
  /** The app database the per-environment jobs/events tables live in. */
  DB: D1Database;
  /** The shared, durable suppression database. */
  EMAIL_SUPPRESSIONS: D1Database;
  /** The Cloudflare Email Service send binding. */
  EMAIL: EmailSender;
  /** The send Workflow (self) — the scheduler creates batches against it. */
  EMAIL_SENDER: SendWorkflowBinding;
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

/**
 * Assemble the send dependencies, resolving the current signing key from the secrets store.
 *
 * `now` is a parameter rather than a read, because the only caller is a Workflow driver body and a driver body
 * re-executes on every resume. Read here, a batch interrupted at 23:59 and resumed at 00:01 would date the
 * jobs it had already sent yesterday and the rest today, and every link's expiry would move with it (#331).
 */
async function buildSendDeps(env: EmailWorkerEnv, now: Date): Promise<SendDeps> {
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
    now,
  };
}

/** Assemble the scheduler dependencies, dispatching each batch as a send Workflow. `now` is the tick's own. */
function buildSchedulerDeps(env: EmailWorkerEnv, now: Date): SchedulerDeps {
  return {
    db: emailDatabase(env.DB),
    now,
    graceMs: Number(env.SCHEDULER_GRACE_MS ?? 2 * MINUTE_MS),
    stuckMs: Number(env.SCHEDULER_STUCK_MS ?? 15 * MINUTE_MS),
    batchSize: Number(env.SCHEDULER_BATCH_SIZE ?? 50),
    maxJobs: Number(env.SCHEDULER_MAX_JOBS ?? 500),
    dispatch: async (jobIds) => {
      await env.EMAIL_SENDER.create({ params: { jobIds } });
    },
  };
}

/** Sends a batch of jobs durably. Started for immediate sends and by the scheduler's fan-out. */
export class EmailSendWorkflow extends WorkflowEntrypoint<EmailWorkerEnv, { jobIds: string[] }> {
  override async run(event: WorkflowEvent<{ jobIds: string[] }>, step: WorkflowStep): Promise<void> {
    // The batch's clock, journalled: this body re-executes on every resume, so a read here would date the
    // second half of a batch hours after the first (#331). Epoch milliseconds, because the journal is JSON.
    const nowMs: number = await step.do("start-batch", async () => Date.now());
    const deps = await buildSendDeps(this.env, new Date(nowMs));
    // One step per job: each is independently retried/backed-off by the Workflow runtime, and a
    // single bad recipient never blocks the rest of the batch.
    for (const jobId of event.payload.jobIds) {
      await step.do(`send-${jobId}`, () => runSend(deps, jobId).then(() => {}));
    }
  }
}

/** Finds due jobs and fans them out into send batches. Fired by the every-minute cron. */
export class EmailSchedulerWorkflow extends WorkflowEntrypoint<EmailWorkerEnv, unknown> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    // The clock is read *inside* the step, which is where a tick's clock belongs: a scheduler tick is one
    // step, so a resume re-reads nothing — the journal returns the completed tick.
    await step.do("dispatch-due", async () => {
      await runScheduler(buildSchedulerDeps(this.env, new Date()));
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
