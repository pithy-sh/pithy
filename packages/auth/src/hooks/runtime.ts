// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a hook is handed beside its event and the D1 binding: the Worker it runs in.
 *
 * `env` is the Worker's environment, typed as the adopter's own through `auth<Env>()` or
 * `organization.withEnv<Env>()(...)`, so a hook can read a secret, start a Workflow or send to a queue. `waitUntil` is the request's
 * `ExecutionContext.waitUntil`, already bound, present when the hook fires inside a request and absent when it fires
 * from a purge Workflow, which has no `ExecutionContext` — a Workflow step already runs to completion.
 */
export interface HookRuntime<Env = Record<string, unknown>> {
  /** The Worker's environment: every binding and secret. */
  readonly env: Env;
  /** Keep work running after the response, inside a request. Absent in a Workflow. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** What {@link requestRuntime} reads off a Hono context. */
interface RuntimeSource {
  readonly env: unknown;
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void } | undefined;
}

/**
 * The runtime for a hook fired inside a request: the request's env, and its `waitUntil` bound to the context.
 *
 * Hono's `executionCtx` getter throws when the request carries none, as under `app.request()` with no context, so
 * that case reads as absent rather than failing the hook's caller.
 */
export function requestRuntime<Env = Record<string, unknown>>(c: RuntimeSource): HookRuntime<Env> {
  const env = c.env as Env;
  let ctx: RuntimeSource["executionCtx"];
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (!ctx) return { env };
  return { env, waitUntil: ctx.waitUntil.bind(ctx) };
}
