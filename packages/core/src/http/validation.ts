// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { fromZodError } from "../error/pithyError";

/**
 * How a route declares what it accepts. Its sibling {@link ./verification.VerificationStrategy}
 * declares how a caller is verified; this declares the shape the caller may send. Both are
 * mandatory, and both belong on the route line — reading a route tells you what it takes without
 * opening the handler.
 *
 * Routes use `validate(target, Schema)`. `@hono/zod-validator` owns the middleware and the
 * `c.req.valid(target)` typing; this file owns two things — what happens when the parse fails, and
 * leaving the schema readable on the middleware afterwards.
 *
 * The failure: without {@link validationHook}, zod-validator answers with its own JSON body, which is
 * neither a `PithyError` payload nor routed through `pithyErrorHandler`. With it, a malformed request
 * is indistinguishable from every other failure the app can produce.
 *
 * The schema: `zValidator` returns the same anonymous closure whatever it validates, so once a route is
 * registered nothing can tell which schema it holds. That was tolerable while the only reader was the
 * route line. The OpenAPI contract (`../openapi/document.ts`) is a second reader, and it reads the
 * composed app, so the schema has to survive registration. `validate` is `zValidator` with the hook
 * applied and the `{ target, schema }` pair attached under {@link REQUEST_CONTRACT}. It was once kept
 * out of here on purpose, as a second name for a library; it earns the name now by carrying the one
 * thing the library drops. The target stays the first argument, so the route line reads as before.
 */

/**
 * The outcome `@hono/zod-validator` hands a hook. Declared structurally rather than by importing
 * the library's `Hook` generic: `Hook` is parameterized by env, path, target and schema, so a
 * single shared hook value could not name it without pinning all four. Every real outcome is
 * assignable to this.
 */
export type ValidationOutcome = { success: true } | { success: false; error: z.core.$ZodError };

/**
 * The one validation-failure hook every provided route passes to `zValidator`. Maps the `ZodError`
 * through `fromZodError`, so the client sees the same `validation/invalid_input` 400 with the same
 * `issues[]` that the hand-rolled parse helpers produced before — the migration changes where
 * validation is declared, not what a caller sees when it fails.
 */
export function validationHook(outcome: ValidationOutcome): void {
  if (outcome.success) return;
  throw fromZodError(outcome.error as z.ZodError);
}

/** The key a {@link validate} middleware carries its contract under. Global, so two copies of core agree. */
export const REQUEST_CONTRACT = Symbol.for("pithy.requestContract");

/** What one validator declares: the part of the request it reads, and the schema that part must satisfy. */
export interface RequestContract {
  /** The request part, as Hono names it: `json`, `query`, `param`, `header`, `cookie` or `form`. */
  readonly target: keyof ValidationTargets;
  /** The schema the part is parsed with. Its input side is what a caller sends. */
  readonly schema: z.ZodType;
}

/**
 * Declare what a route accepts in one part of the request, and fail a malformed one as a
 * `validation/invalid_input` 400. The handler reads the parsed value with `c.req.valid(target)`.
 *
 * ```ts
 * app.post(path, requireAuth(), validate("param", BoardParam), validate("json", SubmitScoreBody), handler);
 * ```
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  const middleware = zValidator(target, schema, validationHook);
  const contract: RequestContract = { target, schema };
  return Object.assign(middleware, { [REQUEST_CONTRACT]: contract });
}

/** The contract a {@link validate} middleware carries, or `undefined` for any other handler. */
export function requestContractOf(handler: unknown): RequestContract | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as { [REQUEST_CONTRACT]?: RequestContract })[REQUEST_CONTRACT];
}
