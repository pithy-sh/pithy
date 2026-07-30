// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { triggerWorkflow } from "@pithy-sh/core/src/workflow/dispatch";
import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import { PAYMENTS_CAPABILITY, type PaymentsReconcileParams, paymentsWorkflowRegistry } from "../workflows/specs";

/**
 * Starting a reconciliation pass from inside a Worker.
 *
 * **One dispatch path, three callers.** The cron in the host worker, an on-demand pass for a single user, and
 * anything a later surface adds all route through {@link triggerWorkflow} — so a scheduled run and a manual
 * one validate their parameters identically, resolve the binding identically, and log an absent binding
 * identically. Calling `env.PAYMENTS_RECONCILE.create()` directly would skip all three: a mistyped payload
 * would surface as a failed step inside a running instance rather than at the call site, and an unprovisioned
 * project would silently do nothing.
 *
 * **An absent binding is a logged skip, not a failure.** The job is declared `optional`, because the Workflow
 * lives in the prebuilt reconcile worker and that worker exists only once `pithy payments provision` has run.
 * A support request that cannot start a pass yet must not become a 500 on a route that otherwise works.
 *
 * It lives under `http/` because the on-demand caller is a request handler — support reconciling one account.
 * The host worker's cron uses the identical function, which is the point: there is one way to start this job.
 */

/** The dispatch key for the reconciliation pass. Built from core's key builder, never spelled out. */
export const PAYMENTS_RECONCILE_KEY = workflowKey(PAYMENTS_CAPABILITY, "reconcile");

/**
 * Start a reconciliation pass.
 *
 * `env` is the raw Worker env rather than a typed binding, because that is what `triggerWorkflow` reads the
 * binding off — and taking the binding itself would let a caller pass one the registry never validated.
 */
export async function triggerPaymentsReconcile(
  env: Record<string, unknown>,
  params: PaymentsReconcileParams = {},
  log?: Logger,
): Promise<void> {
  await triggerWorkflow(env, paymentsWorkflowRegistry, PAYMENTS_RECONCILE_KEY, params, log);
}
