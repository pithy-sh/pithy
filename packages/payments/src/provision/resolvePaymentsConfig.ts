// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { PaymentsConfig } from "../config/config";
import { PAYMENTS_CAPABILITY, paymentsWorkflowRegistry } from "../workflows/specs";

/**
 * Resolve the reconcile worker's committed `wrangler.jsonc` template into one environment's standalone config.
 * Every per-environment decision lives here; everything static — the compatibility date, the binding names —
 * stays as the template committed it.
 *
 * Thin over core's {@link resolveWorkflowHost}, which owns the mechanics (clone, fill by binding name, stamp
 * `ENVIRONMENT`). What this file adds is the one thing the generic resolver deliberately does not do: it
 * **rewrites `workflows` and `triggers.crons` from the capability's specs** rather than from the template's own
 * block. The template carries both so it reads as a complete, deployable config, but `workflows/specs.ts` is
 * the single source of the binding name, the class name, and the schedule — so moving the pass off 04:00 is a
 * one-line spec edit rather than a spec edit plus a JSONC edit that nothing checks agree.
 *
 * Pure: the caller parses the template and writes the result.
 */

/** The resolved ids and per-env values for one environment's reconcile-worker deploy. */
export interface PaymentsConfigParams {
  /** The target environment. */
  env: ManagedEnvironment;
  /** The app database id for this environment — where the `pithy_payments_*` tables live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`pithy-secrets-<env>`) — holds the rails' credentials. */
  secretsDatabaseId: string;
  /** The CF Secrets Store id holding the per-env master key. */
  storeId: string;
  /** The app's resolved payments config — serialized into the worker's `PAYMENTS_CONFIG` var. */
  paymentsConfig: PaymentsConfig;
}

/** The deployed reconcile-worker name for an environment — also its resolved config's basename. */
export function paymentsWorkerName(env: ManagedEnvironment): string {
  return workflowHostName(PAYMENTS_CAPABILITY, env);
}

/** Fill the template for one environment. */
export function resolvePaymentsConfig(
  template: WorkflowHostTemplate,
  params: PaymentsConfigParams,
): WorkflowHostTemplate {
  const { env, appDatabaseId, secretsDatabaseId, storeId, paymentsConfig } = params;

  const resolved = resolveWorkflowHost(template, {
    capability: PAYMENTS_CAPABILITY,
    env,
    databaseIds: { DB: appDatabaseId, SECRETS: secretsDatabaseId },
    secretsStoreId: storeId,
    // The master key entry is env-scoped — its name is env-prefixed, matching what the secrets manager wrote.
    masterKeySecretName: masterKeySecretName(env),
    // The catalog travels whole: the pass has to map a refreshed store SKU back to a product before it can
    // project it, and the rails' toggles decide which stores it may ask at all. Nothing sensitive is in it —
    // every credential lives in the secrets store, which is why this can be a plain var.
    vars: { PAYMENTS_CONFIG: JSON.stringify(paymentsConfig) },
  });

  const derived = hostWorkflowsFor(paymentsWorkflowRegistry, PAYMENTS_CAPABILITY, env);
  resolved.workflows = derived.workflows;
  // Only declare a cron block when a spec actually carries one. An empty `crons` array is a declaration
  // wrangler honours, and a worker that advertises a schedule it does not have is a deployment nobody can
  // reason about.
  resolved.triggers = derived.crons.length > 0 ? { crons: derived.crons } : undefined;

  return resolved;
}
