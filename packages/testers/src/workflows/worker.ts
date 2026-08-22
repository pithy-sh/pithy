// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database } from "@cloudflare/workers-types";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { triggerWorkflow } from "@pithy-sh/core/src/workflow/dispatch";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { confirmUrl, optInUrl, optOutUrl, TestersConfig } from "../config/config";
import type { NudgeKind } from "../data/enums";
import type { TestersMember } from "../data/member";
import { testersDatabase } from "../data/tables";
import { buildNudgeEnqueue, type NudgeEnqueueEnv } from "../nudge/enqueueSeam";
import type { EnqueueNudge } from "../nudge/send";
import type { CohortPassResult } from "./daily";
import { runDurableDailyPass } from "./pass";
import { testersWorkflowRetry } from "./retryPolicy";
import { TESTERS_CAPABILITY, TestersDailyParams, testersWorkflowRegistry } from "./specs";

/**
 * The prebuilt worker hosting the daily pass.
 *
 * **Why its own worker rather than the app worker's `scheduled()`.** The pass can mail every tester on
 * every roster. Keeping it out of the request-serving deployment means it cannot compete with a
 * tester's confirmation click for CPU, and — more to the point — the app worker never needs a binding
 * that can send mail to an entire roster on a timer. It is a Workflow rather than a plain scheduled
 * handler because a Worker invocation is wall-clock bounded while a Workflow step is not: several
 * cohorts of a hundred testers each is a job you want checkpointed rather than restarted.
 *
 * This is the only module in the package that imports `cloudflare:workers`, which is why the
 * schema-description meta-test excludes it — the import is unresolvable outside the Workers runtime.
 */

/**
 * The bindings and vars this worker's env carries, filled by `pithy testers provision`.
 *
 * The sending identity and the send binding are carried as vars rather than guessed, because this
 * worker is standalone: it is not assembled by `createBackend`, so the email capability's `compose`
 * hook never runs here and there is no bound `enqueue` seam to borrow. A default would be worse than an
 * absent value — mail from the wrong domain fails DKIM and lands the adopter's testers in spam, which is
 * exactly the outcome this capability exists to avoid. They are declared on {@link NudgeEnqueueEnv},
 * beside the seam that reads them.
 */
export interface TestersWorkerEnv extends NudgeEnqueueEnv {
  DB: D1Database;
  TESTERS_CONFIG?: string;
  ENVIRONMENT?: string;
  /** The global email-suppression database, for reconciling which addresses have bounced. */
  EMAIL_SUPPRESSIONS?: D1Database;
}

/** The daily pass over every open cohort. */
export class TestersDailyWorkflow extends WorkflowEntrypoint<TestersWorkerEnv, TestersDailyParams> {
  override async run(event: WorkflowEvent<TestersDailyParams>, step: WorkflowStep): Promise<CohortPassResult[]> {
    // Parse rather than trust: an instance can be started by the cron, by `c.var.workflows.trigger`, or
    // by an operator through the dashboard, and only the first two have already been validated.
    const params = TestersDailyParams.parse(event.payload ?? {});
    const config = TestersConfig.parse(this.env.TESTERS_CONFIG ? JSON.parse(this.env.TESTERS_CONFIG) : {});

    // A run has no request, so there is no `c.var.log` to inherit: the Workflow builds its own and binds
    // the instance onto it. That id is what the dashboard and `wrangler workflows` key on, so binding it
    // once here is what lets an operator read a whole pass — the tally and every failed cohort — as one
    // correlated set. It is handed to the pass too, so a suppression list it could not read says so
    // against the same instance.
    const log = bindWorkflowContext(createWorkerLogger({ name: `${TESTERS_CAPABILITY}:daily` }), {
      workflow: event.workflowName,
      instance: event.instanceId,
      env: this.env.ENVIRONMENT ?? "unknown",
    });

    // Built with the default clock, which the seam reads **per nudge**. This is the pass's other clock
    // and it is the opposite of the journalled one: see `enqueueSeam.ts`.
    const enqueue: EnqueueNudge | undefined = params.skipNudges ? undefined : await buildNudgeEnqueue(this.env);
    const linkForKind = params.skipNudges ? undefined : linkFor(config);

    return runDurableDailyPass(
      {
        db: testersDatabase(this.env.DB),
        d1: this.env.DB,
        config,
        newId: () => crypto.randomUUID(),
        log,
        enqueue,
        linkFor: linkForKind,
        optOutLinkFor: (member: TestersMember) => optOutUrl(config, member.optInToken),
        suppressionD1: this.env.EMAIL_SUPPRESSIONS,
      },
      // Under `testersWorkflowRetry`, whose record is empty and says so: the pass is D1, core answers
      // for D1, and a closed cohort or a deleted member is a decision rather than an outage. Contained
      // per cohort already, so a terminal fault loses one cohort's day, not everyone's.
      classifiedSteps(step, testersWorkflowRetry, NonRetryableError),
      params,
    );
  }
}

/**
 * Build the link a nudge carries.
 *
 * No secret, no minting, no failure mode: the token lives on the member row, so this is string
 * concatenation. That is the whole reason the token stopped being a signature.
 */
function linkFor(config: TestersConfig): (kind: NudgeKind, member: TestersMember) => string | undefined {
  return (kind, member) => {
    if (kind === "confirm") return confirmUrl(config, member.optInToken);
    if (kind === "store") return optInUrl(config, member.optInToken);
    return undefined;
  };
}

export default {
  /**
   * Cron entry: start one pass per fire, with empty parameters — the defaults are the scheduled
   * behavior.
   *
   * Through the same dispatcher an on-demand pass uses, rather than `env.TESTERS_DAILY.create()`: the
   * parameters are validated against the job's own schema before the binding is touched, and a host
   * deployed with the binding absent or renamed logs a skip instead of throwing inside a cron nobody is
   * watching. A daily job that fires, does nothing, and says nothing is the one failure mode this pass
   * cannot afford — because silence is also what success looks like.
   */
  async scheduled(_controller: unknown, env: TestersWorkerEnv): Promise<void> {
    await triggerWorkflow(
      env as unknown as Record<string, unknown>,
      testersWorkflowRegistry,
      "testers/daily",
      {},
      createWorkerLogger(),
    );
  },
};
