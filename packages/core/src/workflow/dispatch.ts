// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { originVarName } from "../env/stem";
import { messageOf, PithyError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { noopLogger } from "../logger/logger";
import { ENVIRONMENT_VAR } from "../worker/identity";
import { type LoopbackFetch, loopbackWorkflowBinding } from "./loopback";
import type { RegisteredWorkflow, WorkflowBinding, WorkflowRegistry } from "./spec";

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
   *
   * `options.id` names the instance; without it the spec's `instanceId` does, and without that
   * Cloudflare generates one. A taken id rejects.
   */
  trigger<Key extends keyof Params & string>(
    key: Key,
    params: Params[Key],
    options?: WorkflowTriggerOptions,
  ): Promise<void>;
}

/** What a manual trigger may say about the instance it starts. */
export interface WorkflowTriggerOptions {
  /** The instance id, over the spec's `instanceId`. At most 100 characters of `[A-Za-z0-9_-]`. */
  id?: string;
}

/** How one start was asked for: a manual trigger's chosen id, or the cron fire that scheduled it. */
export interface WorkflowStart extends WorkflowTriggerOptions {
  /**
   * Present for a start a cron fired. A scheduled start whose id is taken is logged as already started and
   * resolves, so a cron that fires twice for one name runs the job once.
   */
  schedule?: {
    /** The cron expression that fired, verbatim. */
    cron?: string;
    /** The scheduled time of the fire. */
    firedAt: Date;
  };
}

/**
 * Read a binding off the per-request env, narrowed to the one method dispatch needs.
 *
 * Exported because the host's dispatch route ({@link ./dispatchRoute.ts}) asks the same question of
 * the same env, and a second duck-type would be a second answer to "is this a Workflow binding" the
 * first day one of them learned about a new shape.
 */
export function workflowBindingFor(env: Record<string, unknown>, name: string): WorkflowBinding | undefined {
  const value = env[name];
  if (typeof value !== "object" || value === null) return undefined;
  const create = (value as { create?: unknown }).create;
  return typeof create === "function" ? (value as WorkflowBinding) : undefined;
}

/** The one environment a loopback substitution is made in. Verbatim, and the only one. */
const LOOPBACK_ENVIRONMENT = "dev";

/** What resolving a binding needs to know: which one, whose, and how to reach a sibling. */
export interface WorkflowBindingRequest {
  /** The binding name on the caller's own env — `EMAIL_SENDER`. */
  binding: string;
  /** The capability that owns the host. Names the origin var, and names the worker in a failure. */
  capability: string;
  /** Where a substitution is noted. Defaults to silence. */
  log?: Logger;
  /** The loopback transport. Defaults to the runtime's `fetch`; injectable for tests. */
  fetch?: LoopbackFetch;
}

/** A non-blank string off the env, or `undefined`. Anything else on that key is not an address. */
function stringVar(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The binding to dispatch on: the real one, or — under `pithy dev` — a loopback stand-in for it.
 *
 * ## Why a stand-in exists at all
 *
 * A deployed app Worker starts a capability's Workflow through a **cross-script** binding pointing at
 * `<project>-<env>-email`. `pithy dev` runs no script under that name, so locally that binding cannot
 * work — it is absent, or it is present and every `create` on it fails. What *does* exist locally is the
 * capability host itself, on a pinned port, with its address in this Worker's own vars as
 * `<STEM>_ORIGIN`. So the seam is filled rather than left empty, and the call site — `enqueueEmail`, the
 * cron handler, `c.var.workflows` — is byte-identical either way.
 *
 * ## Three rules, and each of them is a refusal
 *
 * **In `dev`, a published origin wins over the binding**, whatever wrangler hands a local Worker for a
 * script it is not running: a binding that is present but cannot reach anything is indistinguishable
 * at runtime from one that works, so preferring it would dispatch into nothing and depend on a wrangler
 * behavior nothing here controls. Preferring the origin costs nothing, because a published origin is not something a
 * composition can have by accident — see the next rule.
 *
 * **A published origin names a host `pithy dev` is running.** The orchestrator writes one `--var` per
 * *capability host* in the dev set, and never hands a host its own address. So `EMAIL_ORIGIN` on a
 * Worker's env means exactly one thing: the email host is up, locally, there. An adopter's own
 * app-owned Workflow — the same-script shape, which `wrangler dev` implements unchanged — is never
 * published an origin and so is never diverted.
 *
 * **Only `dev`.** Not `staging`, not `prod`, and — the case that matters — not a composition that
 * stamped no environment at all. A gate that reads silence as `dev` opens itself in exactly the
 * deployment whose `wrangler.jsonc` lost the var.
 *
 * **The environment comes off the request env, not off the host's shell.** `--var ENVIRONMENT` is
 * what puts it on a Worker, and the shell that ran `wrangler dev` does not cross into workerd. The
 * dispatch *route* reads the ambient env instead, because it is registered before any request exists;
 * here there is a request env in hand, and it is the truthful one.
 */
export function resolveWorkflowBinding(
  env: Record<string, unknown>,
  request: WorkflowBindingRequest,
): WorkflowBinding | undefined {
  const origin =
    stringVar(env, ENVIRONMENT_VAR) === LOOPBACK_ENVIRONMENT
      ? stringVar(env, originVarName(request.capability))
      : undefined;

  if (origin) {
    request.log?.debug("workflow dispatch over loopback", {
      binding: request.binding,
      capability: request.capability,
      origin,
    });
    return loopbackWorkflowBinding({
      origin,
      binding: request.binding,
      capability: request.capability,
      fetch: request.fetch,
    });
  }

  return workflowBindingFor(env, request.binding);
}

/**
 * Start one registered job. The single dispatch path — `createBackend`'s per-request dispatcher and
 * `createEntrypoint`'s cron handler both route through here, so a scheduled run and a manual one
 * validate and name their instances identically.
 */
export async function triggerWorkflow(
  env: Record<string, unknown>,
  registry: WorkflowRegistry,
  key: string,
  params: unknown,
  log: Logger = noopLogger,
  start: WorkflowStart = {},
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

  const binding = resolveWorkflowBinding(env, {
    binding: entry.spec.binding,
    capability: entry.capability,
    log,
  });
  if (!binding) {
    // An optional job is one whose host may not be provisioned yet, on a request path that works without
    // it, so it degrades instead of throwing. Always with a warning: a skipped job must never be silent.
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

  const id = instanceIdFor(entry, start, parsed.data);
  try {
    await binding.create(id === undefined ? { params: parsed.data } : { id, params: parsed.data });
  } catch (error) {
    if (start.schedule && id !== undefined && (await instanceExists(binding, id))) {
      log.info("workflow already started", { workflow: key, id });
      return;
    }
    // A binding that is there and will not start anything is the same fact to an optional job's caller as
    // one that is absent. Under `pithy dev` the loopback stand-in is never absent, so a host still starting
    // reaches here.
    if (!entry.spec.optional) throw error;
    log.warn("workflow skipped", {
      workflow: key,
      binding: entry.spec.binding,
      reason: messageOf(error),
    });
  }
}

/**
 * The id one start asks for: the caller's, else the spec's `instanceId` over the fire time, the cron and the
 * parsed params, else none. A manual trigger fires now.
 */
export function instanceIdFor(entry: RegisteredWorkflow, start: WorkflowStart, params: unknown): string | undefined {
  if (start.id !== undefined) return start.id;
  const name = entry.spec.instanceId;
  if (!name) return undefined;
  return name({
    firedAt: start.schedule?.firedAt ?? new Date(),
    ...(start.schedule?.cron === undefined ? {} : { cron: start.schedule.cron }),
    params,
  });
}

/**
 * Whether the binding holds an instance under `id`. False when it cannot look one up, so a stand-in without
 * `get` never turns a refusal into a success.
 */
async function instanceExists(binding: WorkflowBinding, id: string): Promise<boolean> {
  if (typeof binding.get !== "function") return false;
  return binding.get(id).then(
    () => true,
    () => false,
  );
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
    trigger: (key, params, options) => triggerWorkflow(env, registry, key, params, log, { id: options?.id }),
  };
}
