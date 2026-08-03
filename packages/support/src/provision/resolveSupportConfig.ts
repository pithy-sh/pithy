// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { SupportConfig } from "../config/config";
import { SUPPORT_CAPABILITY, supportWorkflowRegistry } from "../workflows/specs";

/**
 * Resolve the support worker's committed `wrangler.jsonc` template into one environment's standalone
 * config. Every per-environment decision lives here; everything static — the compatibility date, the
 * AI binding, the Workflow class name — stays as the template committed it.
 *
 * Thin over core's {@link resolveWorkflowHost}, which owns the mechanics (clone, fill by binding name,
 * stamp `ENVIRONMENT`). This file owns only what is support's: which binding maps to which provisioned
 * resource, the Workflow name derived from support's own specs, and the serialized config the worker
 * parses.
 *
 * **`AI` is marked remote.** Workflows cannot use remote bindings in general, so a host always runs
 * locally under `wrangler dev` — and Workers AI has no local emulation, so without this flag the
 * classification step has nothing to call in development. Same treatment `@pithy-sh/vector` gives
 * Vectorize, for the same reason.
 *
 * There is no secrets binding and no secrets database, and that absence is deliberate: this worker
 * reads a message and writes a classification. The AI binding is its entire dependency, so it holds no
 * credential at all — which is the smallest blast radius a deployed worker can have.
 */

/** The resolved resource ids + per-env values for one environment's support-worker deploy. */
export interface SupportConfigParams {
  /**
   * The project name — the `<project>` segment the deployed worker and its classification Workflow
   * lead with. The root `pithy.config.ts` `name`, resolved by `requireProjectName` and never guessed.
   */
  project: string;
  /** The target environment. */
  env: ManagedEnvironment;
  /** The app database id for this environment — where the support tables live. */
  appDatabaseId: string;
  /**
   * The app's resolved support config, serialized into the worker's `SUPPORT_CONFIG` var.
   *
   * This is how an adopter's federated categories reach the prompt. The worker is deployed from this
   * package and cannot import their code, so the taxonomy has to travel as data — which it does,
   * because it always was data.
   */
  supportConfig: SupportConfig;
}

/** Fill the template for one environment. */
export function resolveSupportConfig(
  template: WorkflowHostTemplate,
  params: SupportConfigParams,
): WorkflowHostTemplate {
  const { project, env } = params;
  return resolveWorkflowHost(template, {
    project,
    capability: SUPPORT_CAPABILITY,
    env,
    databaseIds: { DB: params.appDatabaseId },
    remoteBindings: ["AI"],
    vars: { SUPPORT_CONFIG: JSON.stringify(params.supportConfig) },
    // The classification Workflow, derived from support's own specs. A Workflow name is
    // account-scoped, so it has to carry the project, and only the registry knows the job.
    workflows: hostWorkflowsFor(supportWorkflowRegistry, { project, capability: SUPPORT_CAPABILITY, env }).workflows,
  });
}
