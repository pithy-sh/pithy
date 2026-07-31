// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { SupportConfig } from "../config/config";
import { SUPPORT_CAPABILITY } from "../workflows/specs";

/**
 * Resolve the support worker's committed `wrangler.jsonc` template into one environment's standalone
 * config. Every per-environment decision lives here; everything static — the compatibility date, the
 * AI binding, the Workflow class name — stays as the template committed it.
 *
 * Thin over core's {@link resolveWorkflowHost}, which owns the mechanics (clone, fill by binding name,
 * suffix every Workflow name with the environment, stamp `ENVIRONMENT`). This file owns only what is
 * support's: which binding maps to which provisioned resource, and the serialized config the worker
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
  return resolveWorkflowHost(template, {
    capability: SUPPORT_CAPABILITY,
    env: params.env,
    databaseIds: { DB: params.appDatabaseId },
    remoteBindings: ["AI"],
    vars: { SUPPORT_CONFIG: JSON.stringify(params.supportConfig) },
  });
}
