// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { PithyError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { noopLogger } from "../logger/logger";
import type { WorkflowBinding, WorkflowRegistry } from "./spec";

/**
 * Dispatch: start a registered job by its `<capability>/<job>` key.
 *
 * Two things happen before the binding is touched, in this order. The key resolves against the
 * registry, so a typo is `core/unknown_workflow` rather than a `TypeError` on `undefined.create`.
 * Then the params parse through the spec's schema, so a malformed payload is
 * `core/invalid_workflow_params` at the call site — with the offending field named — instead of a
 * failed step inside a running instance, where the only signal is a retry budget burning down and
 * the payload is no longer in anyone's hands.
 *
 * The dispatcher is a closure over the per-request `env`, built once per request by
 * `createBackend` and served as `c.var.workflows`.
 */

/**
 * The typed dispatcher. `Params` maps each `<capability>/<job>` key to that job's parameter type,
 * derived by `createBackend` from the composed capabilities — so `trigger` autocompletes the key
 * set and type-checks the payload against the declaring capability's schema.
 */
export interface WorkflowDispatcher<Params extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Start an instance of one job. Resolves once Cloudflare has accepted the instance; it does not
   * wait for the Workflow to finish. Instance status and termination are deliberately not on this
   * seam — a Workflow is durable precisely so the caller need not hold its progress.
   */
  trigger<Key extends keyof Params & string>(key: Key, params: Params[Key]): Promise<void>;
}

/** Read a binding off the per-request env, narrowed to the one method dispatch needs. */
function bindingFor(env: Record<string, unknown>, name: string): WorkflowBinding | undefined {
  const value = env[name];
  if (typeof value !== "object" || value === null) return undefined;
  const create = (value as { create?: unknown }).create;
  return typeof create === "function" ? (value as WorkflowBinding) : undefined;
}

/**
 * Start one registered job. The single dispatch path — `createBackend`'s per-request dispatcher and
 * `createEntrypoint`'s cron handler both route through here, so a scheduled run and a manual one
 * validate identically.
 */
export async function triggerWorkflow(
  env: Record<string, unknown>,
  registry: WorkflowRegistry,
  key: string,
  params: unknown,
  log: Logger = noopLogger,
): Promise<void> {
  const entry = registry[key];
  if (!entry) {
    const known = Object.keys(registry).sort().join(", ");
    throw new PithyError({
      code: "core/unknown_workflow",
      status: 500,
      message: `No workflow is registered as "${key}".`,
      action: "Check the key, and compose the capability that declares the job.",
      detail: known ? `Registered workflows: ${known}.` : "No capability registered any workflow.",
    });
  }

  // Params first: a bad payload is the caller's fault and must not depend on whether the binding
  // happens to be wired, so the same mistake reports the same way in every environment.
  const parsed = entry.spec.params.safeParse(params);
  if (!parsed.success) {
    throw new PithyError({
      code: "core/invalid_workflow_params",
      status: 400,
      message: `The parameters for workflow "${key}" are not valid.`,
      action: "Correct the parameters to match the workflow's schema.",
      detail: (parsed.error as z.ZodError).issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
  }

  const binding = bindingFor(env, entry.spec.binding);
  if (!binding) {
    // An optional job is one whose host may not be provisioned yet. Throwing would take down a
    // request path that works perfectly well without the job — `@pithy-sh/media` finalizes an upload
    // and merely skips enrichment. So it degrades instead. It degrades *loudly*, though: the previous
    // shape of this (an `?.create()` in media) made a whole capability silently do nothing, with no
    // error and no log, which is the harder failure to diagnose by far.
    if (entry.spec.optional) {
      log.warn("workflow skipped", {
        workflow: key,
        binding: entry.spec.binding,
        reason: "binding absent — the workflow host is not deployed or not bound",
      });
      return;
    }
    throw new PithyError({
      code: "core/missing_workflow_binding",
      status: 500,
      message: `The workflow binding "${entry.spec.binding}" is not available.`,
      action: `Deploy the ${entry.capability} workflow host, then bind ${entry.spec.binding} in wrangler.jsonc.`,
      detail: `Dispatching "${key}" needs a Workflow binding named ${entry.spec.binding} on the Worker env.`,
    });
  }

  await binding.create({ params: parsed.data });
}

/**
 * Build the per-request dispatcher over one registry. A closure rather than a lazily-built registry
 * object: there is one method and no per-job resource to construct, so there is nothing to defer.
 */
export function buildWorkflowDispatcher<Params extends Record<string, unknown> = Record<string, unknown>>(
  env: Record<string, unknown>,
  registry: WorkflowRegistry,
  log: Logger = noopLogger,
): WorkflowDispatcher<Params> {
  return {
    trigger: (key, params) => triggerWorkflow(env, registry, key, params, log),
  };
}
