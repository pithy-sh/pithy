// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { triggerWorkflow } from "@pithy-sh/core/src/workflow/dispatch";
import { confirmUrl, optInUrl, optOutUrl, TestersConfig } from "../config/config";
import type { NudgeKind } from "../data/enums";
import type { TestersMember } from "../data/member";
import { testersDatabase } from "../data/tables";
import type { EnqueueNudge } from "../nudge/send";
import { type CohortPassResult, openCohortIds, runCohortPass } from "./daily";
import { TestersDailyParams, testersWorkflowRegistry } from "./specs";

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

/** The bindings and vars this worker's env carries, filled by `pithy testers provision`. */
export interface TestersWorkerEnv {
  DB: D1Database;
  TESTERS_CONFIG?: string;
  ENVIRONMENT?: string;
  /**
   * The sending identity, copied from the email capability's resolved config at provision.
   *
   * Carried as vars rather than guessed, because this worker is standalone: it is not assembled by
   * `createBackend`, so the email capability's `compose` hook never runs here and there is no bound
   * `enqueue` seam to borrow. A default would be worse than an absent value — mail from the wrong
   * domain fails DKIM and lands the adopter's testers in spam, which is exactly the outcome this
   * capability exists to avoid.
   */
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  /** The resolved email theme, as the email worker carries it. */
  EMAIL_THEME?: string;
  EMAIL_SENDER?: { create(options: { params: { jobIds: string[] } }): Promise<unknown> };
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
    const db = testersDatabase(this.env.DB);
    const now = new Date();

    const enqueue: EnqueueNudge | undefined = params.skipNudges ? undefined : await buildEnqueue(this.env);
    const linkForKind = params.skipNudges ? undefined : linkFor(config);

    const deps = {
      db,
      d1: this.env.DB,
      config,
      now,
      newId: () => crypto.randomUUID(),
      enqueue,
      linkFor: linkForKind,
      optOutLinkFor: (member: TestersMember) => optOutUrl(config, member.optInToken),
      suppressionD1: this.env.EMAIL_SUPPRESSIONS,
    };

    // One step per cohort. A cohort whose activity read fails is retried on its own rather than taking
    // the rest of the day's cohorts down with it, and a retried step re-runs an idempotent pass.
    if (params.cohortId) {
      const result = await step.do(`cohort-${params.cohortId}`, () => runCohortPass(deps, params.cohortId as string));
      console.log("testers daily pass", JSON.stringify(result));
      return [result];
    }

    // Enumerated in its own step, then one step per cohort — which is what the comment above has always
    // claimed and what every other Workflow in this repo does. A single `all-cohorts` step wrapping the
    // loop meant a deterministic failure on one cohort (a corrupt member row, a cohort deleted between
    // the list and the read) denied every cohort after it its snapshot and its nudges, on every retry
    // attempt, until retries ran out. The darkness histogram cannot be recomputed after the fact, so
    // those days were gone for good.
    const cohortIds: string[] = await step.do("list-cohorts", async () => await openCohortIds(db));

    const results: CohortPassResult[] = [];
    for (const cohortId of cohortIds) {
      // Contained per cohort. A cohort that keeps failing loses its own day rather than everyone's, and
      // the failure is still visible in the Workflow instance rather than swallowed.
      try {
        results.push(await step.do(`cohort-${cohortId}`, () => runCohortPass(deps, cohortId)));
      } catch (error) {
        console.error("testers daily pass: cohort failed", cohortId, error);
      }
    }
    console.log("testers daily pass", JSON.stringify(results));
    return results;
  }
}

/**
 * The email enqueue seam, loaded from the project's own install.
 *
 * A guarded dynamic import: a project can compose testers without email — inviting nobody and simply
 * tracking a roster it imported — and the pass should still advance state and write its snapshot rather
 * than fail on a dependency it does not strictly need.
 */
async function buildEnqueue(env: TestersWorkerEnv): Promise<EnqueueNudge | undefined> {
  // No sending identity means no send. Falling back to a plausible-looking default address would mail
  // the adopter's testers from a domain their DKIM does not cover, which is worse than sending nothing:
  // it trains the recipients' providers to treat the real domain as spam.
  if (!env.EMAIL_FROM_ADDRESS || !env.EMAIL_FROM_NAME) return undefined;

  try {
    const { enqueueEmail } = await import("@pithy-sh/email/src/send/enqueue");
    const { emailDatabase } = await import("@pithy-sh/email/src/data/tables");
    const { defaultTheme, EmailTheme } = await import("@pithy-sh/email/src/templates/theme");
    const theme = env.EMAIL_THEME ? EmailTheme.parse(JSON.parse(env.EMAIL_THEME)) : defaultTheme;
    const fromAddress = env.EMAIL_FROM_ADDRESS;
    const fromName = env.EMAIL_FROM_NAME;
    return async (input) =>
      enqueueEmail(
        {
          db: emailDatabase(env.DB),
          fromAddress,
          fromName,
          theme,
          sender: env.EMAIL_SENDER,
          now: new Date(),
          newId: () => crypto.randomUUID(),
        },
        input,
      );
  } catch {
    return undefined;
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
   * behaviour.
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
