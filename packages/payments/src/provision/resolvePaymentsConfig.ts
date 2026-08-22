// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
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
  /**
   * The project name — the `<project>` segment the deployed worker and its reconcile Workflow lead
   * with. The root `pithy.config.ts` `name`, resolved by `requireProjectName` and never guessed:
   * Worker script and Workflow names are account-scoped, so a wrong value overwrites another project's
   * running reconcile host rather than colliding with it.
   */
  project: string;
  /** The target environment. */
  env: ManagedEnvironment;
  /** The app database id for this environment — where the `pithy_payments_*` tables live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`<project>-<env>-secrets`) — holds the rails' credentials. */
  secretsDatabaseId: string;
  /** The CF Secrets Store id holding the per-env master key. */
  storeId: string;
  /** The app's resolved payments config — serialized into the worker's `PAYMENTS_CONFIG` var. */
  paymentsConfig: PaymentsConfig;
}

/**
 * The deployed reconcile-worker name for a project's environment — also its resolved config's basename.
 *
 * Through core's naming facade under the **`worker`** namespace, so the name is held to a Worker
 * script's 63 (not the generic composer's one-size 63 that happened to agree) and the environment is
 * validated where it is bound rather than at the deploy that would have used it.
 */
export function paymentsWorkerName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).worker(PAYMENTS_CAPABILITY);
}

/** Fill the template for one environment. */
export function resolvePaymentsConfig(
  template: WorkflowHostTemplate,
  params: PaymentsConfigParams,
): WorkflowHostTemplate {
  const { project, env, appDatabaseId, secretsDatabaseId, storeId, paymentsConfig } = params;

  // Derived before the resolve rather than assigned after it: `resolveWorkflowHost` refuses to fill a
  // template that declares `workflows` without them, because the only name it could invent unaided is an
  // unscoped one a second project in the same account would overwrite.
  const derived = hostWorkflowsFor(paymentsWorkflowRegistry, { project, capability: PAYMENTS_CAPABILITY, env });

  const resolved = resolveWorkflowHost(template, {
    project,
    capability: PAYMENTS_CAPABILITY,
    env,
    databaseIds: { DB: appDatabaseId, SECRETS: secretsDatabaseId },
    secretsStoreId: storeId,
    // The master key entry is project- and env-scoped, matching what the secrets manager wrote.
    masterKeySecretName: masterKeySecretName(project, env),
    workflows: derived.workflows,
    // The catalog travels whole: the pass has to map a refreshed store SKU back to a product before it can
    // project it, and the rails' toggles decide which stores it may ask at all. Nothing sensitive is in it —
    // every credential lives in the secrets store, which is why this can be a plain var.
    vars: { PAYMENTS_CONFIG: JSON.stringify(paymentsConfig) },
  });

  // Only declare a cron block when a spec actually carries one. An empty `crons` array is a declaration
  // wrangler honors, and a worker that advertises a schedule it does not have is a deployment nobody can
  // reason about.
  resolved.triggers = derived.crons.length > 0 ? { crons: derived.crons } : undefined;

  return resolved;
}
