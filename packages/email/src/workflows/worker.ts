// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { emailDatabase } from "../data/tables";
import { mintBatchId } from "../send/batchIdentity";
import { emailWorkflowRetry } from "../send/retryPolicy";
import { createEmailHostApp } from "./hostApp";
import type { EmailHostEnv } from "./hostEnv";
import { isLiveInstanceStatus } from "./instanceLiveness";
import { runScheduler, type SchedulerDeps, schedulerHasWork } from "./scheduler";
import { type BatchSendReport, runSendBatch } from "./sendBatch";
import { buildSendDeps, type EmailWorkerEnv, hostConfig } from "./sendDeps";

/**
 * The prebuilt email worker. `pithy add email` deploys one per environment (`pithy-email-staging`,
 * `pithy-email-prod`); the user authors no code for it. It hosts:
 *
 *   - `EmailSendWorkflow` — sends a batch of jobs durably (dispatch target for immediate sends and
 *     the scheduler's fan-out).
 *   - `EmailSchedulerWorkflow` — finds due jobs and fans them out into send batches.
 *   - `scheduled()` — the every-minute cron that fires the scheduler Workflow when a row is due.
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

/** The dispatch door. Built once per isolate; the environment gate reads its answer per request. */
const app = createEmailHostApp();

/**
 * Assemble the scheduler dependencies, dispatching each batch as a send Workflow.
 *
 * `config` is a parameter so the cron can validate the env once and hand the answer on: it reads
 * `SCHEDULER_ENABLED` before it probes, and re-parsing the same env object a second line later would
 * be one Zod pass per minute for nothing.
 */
function buildSchedulerDeps(env: EmailWorkerEnv, config: EmailHostEnv = hostConfig(env)): SchedulerDeps {
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
  /**
   * Cron entry: fire the scheduler Workflow every minute — when there is something to fire it for.
   *
   * The instance used to be created unconditionally, and the "is anything due" question was asked
   * inside it. At `* * * * *` that spends 1,440 instance creations and 1,440 billed steps a day, per
   * environment, discovering nothing to do; Workers Free allows 3,000 steps a day for the whole
   * account, so a default project's staging and prod burn 96% of it sending no mail, and the sends
   * that do happen compete for the rest (pithy-sh/pithy#538).
   *
   * So the question moved out in front: one indexed read on `pithy_email_jobs`, asked with the tick's
   * own predicate rather than a second copy of it, and an instance only when it finds a row. Nothing
   * is lost with the tick that never starts: this is not the path an immediate send takes (`enqueue`
   * starts that Workflow itself), the work is a pure re-derivation from D1, and a lost minute is
   * recovered by the next one exactly as a throwing `create()` has always been.
   *
   * What it does give up is the per-minute instance in the dashboard that proved the scheduler was
   * alive. An idle minute now leaves no trace, by design — the trace was costing a billed step.
   *
   * **Through {@link schedulerHasWork}, so the tick's configuration is checked before the probe.** The
   * batch-size check inside `runScheduler` exists to complain on the first tick rather than the first
   * busy one, and a probe in front of the instance is in front of that check too.
   */
  async scheduled(_controller: unknown, env: EmailWorkerEnv): Promise<void> {
    const config = hostConfig(env);
    if (!config.SCHEDULER_ENABLED) return;
    if (!(await schedulerHasWork(buildSchedulerDeps(env, config)))) return;
    await env.EMAIL_SCHEDULER.create();
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
