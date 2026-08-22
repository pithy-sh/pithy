// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { configureSharedSecrets, sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { PurchaseEnvironment } from "../data/purchase";
import { triggerPaymentsReconcile } from "../http/dispatch";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry, railCredentials } from "../secret/registry";
import { sweepPaddle } from "./paddleSweep";
import { batchedRailAccess } from "./railAccess";
import { type ReconcileReport, reconcilePayments } from "./reconcile";
import { auditLogEmit, logReconcileReport } from "./report";
import { paymentsWorkflowRetry } from "./retryPolicy";
import { PaymentsReconcileParams } from "./specs";
import { type PaymentsWorkerEnv, reconcileWorkerConfig } from "./workerConfig";

/**
 * The prebuilt payments reconcile worker. `pithy payments provision` deploys one per environment; the adopter
 * authors none of it. It hosts a single Workflow — the reconciliation pass — and fires it on a daily cron.
 *
 * **Why its own worker rather than the app worker's `scheduled()`.** The pass makes hundreds of authenticated
 * calls to three stores and can rewrite any purchase row. Keeping it out of the request-serving deployment
 * means it cannot compete with a checkout for CPU, and the app worker never needs the App Store Connect key
 * or the Play service account on a path that serves a request. It is a Workflow rather than a plain scheduled
 * pass because a Worker invocation is wall-clock bounded while a Workflow step is not: a catalog of ten
 * thousand subscriptions is a hundred pages against rate-limited third-party APIs, and that is work you want
 * journalled rather than restarted.
 *
 * ## A Workflow here runs with **no subject seam**, and that is structural
 *
 * Read this before adding the next Workflow to this worker. Payments splits the "who holds a purchase"
 * decision in two: `billingSubject` is a two-value enum in `PaymentsConfig`, and `resolveSubject` is a
 * **function** on `PaymentsOptions`, the non-config argument to the `payments()` factory. The split follows
 * the round trip this file sits at the end of — `provision/resolvePaymentsConfig.ts` `JSON.stringify`s the
 * config into the `PAYMENTS_CONFIG` var and {@link reconcileWorkerConfig} parses it back, and a function
 * does not survive that.
 *
 * So this worker **always** runs with no adopter resolver, on every project, in every environment. There is
 * nothing to run one against either: `resolvePaymentsSubject` takes a Hono context, and a cron fire has no
 * request, no session, and no caller.
 *
 * **Every subject anything in here touches therefore comes off a row it read** — the pair stored on a
 * purchase, the pair on a provider-account link, or the reference a checkout stamped and the store echoed
 * back. That is not a gap waiting to be closed; it is what a durable repair pass has to do regardless, since
 * the holder of a subscription bought eleven months ago is not whoever happens to be signed in tonight.
 * A Workflow added here that wants to know who holds something reads the row, and if the row cannot say,
 * the honest outcome is an orphan: recorded, replayable, granting nothing.
 *
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime and is excluded from the
 * node `.describe()` meta-test.
 */

export type { PaymentsWorkerEnv } from "./workerConfig";

// A standalone worker, not assembled by `createBackend`, so wire the shared secrets accessor directly. Without
// this the `secrets` capability's `compose` hook never runs and every rail's credential read throws.
configureSharedSecrets({ registry: paymentsSecretsRegistry });

/**
 * This deployment's store environment, from the `ENVIRONMENT` var — the same rule the app worker's routes use.
 *
 * Only a worker deployed to `prod` is production. The failure directions are not symmetric: treating
 * production as sandbox refuses a repair that the next pass makes anyway, while treating sandbox as production
 * would let a test transaction rewrite a real entitlement.
 */
function deploymentEnvironment(env: PaymentsWorkerEnv): PurchaseEnvironment {
  return env.ENVIRONMENT === "prod" ? "production" : "sandbox";
}

/**
 * The reconciliation pass, as a cron-triggered Workflow. One journalled step per page of purchases.
 *
 * Every step runs under {@link paymentsWorkflowRetry}: a store that could not be reached re-drives the
 * page, and anything else fails it at once rather than spending a run's retry budget on an answer that
 * will not change. See `retryPolicy.ts`.
 */
export class PaymentsReconcileWorkflow extends WorkflowEntrypoint<PaymentsWorkerEnv, PaymentsReconcileParams> {
  override async run(event: WorkflowEvent<PaymentsReconcileParams>, step: WorkflowStep): Promise<ReconcileReport> {
    // Parse rather than trust: an instance can be started by the cron, by `triggerPaymentsReconcile`, or by an
    // operator through the Cloudflare dashboard, and only the first two have already been validated.
    const params = PaymentsReconcileParams.parse(event.payload ?? {});
    // Before anything else in the run: a config the build cannot read makes every step below meaningless,
    // and failing on the first line is what puts the refusal at the top of the instance rather than six
    // journalled steps in.
    const config = reconcileWorkerConfig(this.env);

    // A run has no request, so there is no `c.var.log` to inherit: the Workflow builds its own and binds the
    // instance onto it. The instance id is what the dashboard and `wrangler workflows` key on, so binding it
    // once here is what lets an operator read a whole pass — tally and every repair — as one correlated set.
    const log = bindWorkflowContext(createWorkerLogger({ name: "payments:reconcile" }), {
      workflow: event.workflowName,
      instance: event.instanceId,
      env: this.env.ENVIRONMENT ?? "unknown",
    });

    // Read at the point of need, through the one reader. The credentials are handed to the rail access builder
    // and never cached beyond the run.
    const secrets = await sharedSecretsStore(this.env, paymentsSecretsRegistry);
    const credentials = secrets.get(PAYMENTS_PROVIDER_SECRET);

    const report = await reconcilePayments(
      {
        d1: this.env.DB,
        config,
        environment: deploymentEnvironment(this.env),
        // Built per page inside the step, so each page mints its own batch tokens rather than replaying an
        // expired pair after a retry.
        railAccess: (now) => batchedRailAccess({ config, credentials, now }),
        now: () => new Date(),
        emit: auditLogEmit(log),
        /**
         * The Paddle events sweep, supplied only when that rail is on.
         *
         * Undefined otherwise, and the difference is a statement rather than an optimization: a rail
         * nobody sells through did not sweep, where a rail that swept and found nothing is a healthy
         * integration. Collapsing the two makes "the webhooks are fine" indistinguishable from "we never
         * looked", which is the exact ambiguity this pass exists to remove.
         *
         * Built here rather than inside `reconcilePayments`, because it needs Paddle's credentials and its
         * own account, and that module deliberately knows nothing about any single rail.
         */
        ...(config.rails.paddle && config.paddle !== undefined
          ? {
              sweepPaddle: () =>
                sweepPaddle({
                  d1: this.env.DB,
                  config,
                  environment: deploymentEnvironment(this.env),
                  credentials: railCredentials(credentials, "paddle"),
                  paddleEnvironment: config.paddle?.environment ?? "sandbox",
                  // The raw `ENVIRONMENT`, not the two-valued store environment: the shared-sandbox fence
                  // separates `dev` from `staging`, and both are `sandbox` on the other axis.
                  deployment: this.env.ENVIRONMENT,
                  now: () => new Date(),
                }),
            }
          : {}),
      },
      classifiedSteps(step, paymentsWorkflowRetry, NonRetryableError),
      params,
    );

    logReconcileReport(log, report);
    return report;
  }
}

export default {
  /**
   * Cron entry: start one pass per fire, with empty parameters — the defaults are the scheduled behavior.
   *
   * Through the same dispatcher an on-demand pass uses, rather than `env.PAYMENTS_RECONCILE.create()`: the
   * parameters are validated against the job's own schema before the binding is touched, and a host deployed
   * without its binding logs a skip instead of throwing inside a cron nobody is watching.
   */
  async scheduled(_controller: unknown, env: PaymentsWorkerEnv): Promise<void> {
    // The logger is the point of the sentence above. Without one the dispatcher logs its skip to the no-op,
    // so a host deployed with `PAYMENTS_RECONCILE` absent or renamed fires at 04:00 every night, does nothing,
    // and says nothing — the one failure mode a nightly repair job cannot afford, because silence is also what
    // success looks like.
    await triggerPaymentsReconcile(env as unknown as Record<string, unknown>, {}, createWorkerLogger());
  },
};
