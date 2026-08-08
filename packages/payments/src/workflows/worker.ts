// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets, sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { PaymentsConfig } from "../config/config";
import type { PurchaseEnvironment } from "../data/purchase";
import { triggerPaymentsReconcile } from "../http/dispatch";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";
import { batchedRailAccess } from "./railAccess";
import { type ReconcileReport, reconcilePayments } from "./reconcile";
import { auditLogEmit, logReconcileReport } from "./report";
import { PaymentsReconcileParams } from "./specs";

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
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime and is excluded from the
 * node `.describe()` meta-test.
 */

/** The reconcile worker's env: the app database, the secrets database, the master key, and its config. */
export interface PaymentsWorkerEnv extends SecretsStoreEnv {
  /** The app database the `pithy_payments_*` tables live in. */
  DB: D1Database;
  /** The resolved payments config as a JSON string, filled at provision. Absent falls back to defaults. */
  PAYMENTS_CONFIG?: string;
  /** This worker's own Workflow binding — how `scheduled()` starts an instance. */
  PAYMENTS_RECONCILE?: { create(options?: { id?: string; params?: unknown }): Promise<unknown> };
}

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

/** The reconciliation pass, as a cron-triggered Workflow. One journalled step per page of purchases. */
export class PaymentsReconcileWorkflow extends WorkflowEntrypoint<PaymentsWorkerEnv, PaymentsReconcileParams> {
  override async run(event: WorkflowEvent<PaymentsReconcileParams>, step: WorkflowStep): Promise<ReconcileReport> {
    // Parse rather than trust: an instance can be started by the cron, by `triggerPaymentsReconcile`, or by an
    // operator through the Cloudflare dashboard, and only the first two have already been validated.
    const params = PaymentsReconcileParams.parse(event.payload ?? {});
    const config = PaymentsConfig.parse(this.env.PAYMENTS_CONFIG ? JSON.parse(this.env.PAYMENTS_CONFIG) : {});

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
      },
      step,
      params,
    );

    logReconcileReport(log, report);
    return report;
  }
}

export default {
  /**
   * Cron entry: start one pass per fire, with empty parameters — the defaults are the scheduled behaviour.
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
