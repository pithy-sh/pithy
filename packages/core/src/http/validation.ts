// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { fromZodError } from "../error/pithyError";

/**
 * How a route declares what it accepts. Its sibling {@link ./verification.VerificationStrategy}
 * declares how a caller is verified; this declares the shape the caller may send. Both are
 * mandatory, and both belong on the route line — reading a route tells you what it takes without
 * opening the handler.
 *
 * Routes use `zValidator(target, Schema, validationHook)` from `@hono/zod-validator`. The library
 * owns the middleware and the `c.req.valid(target)` typing; this file owns exactly one thing —
 * what happens when the parse fails. Without the hook, zod-validator answers with its own JSON
 * body, which is neither a `PithyError` payload nor routed through `pithyErrorHandler`. With it,
 * a malformed request is indistinguishable from every other failure the app can produce.
 *
 * The hook is deliberately not a wrapper around `zValidator`. A wrapper would be a second name for
 * a library we do not re-export (CLAUDE.md §Toolchain), and it would hide the target from the route
 * line — the one thing the migration exists to make visible.
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
