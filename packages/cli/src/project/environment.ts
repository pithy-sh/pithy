// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { assertValidEnvironment, type DeclaredEnvironments, ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";

/**
 * The `--env` flag, at the CLI edge.
 *
 * An environment is not a label a command carries around: it sits in the middle of every Cloudflare name
 * the project composes (`<project>-<env>-<thing>`), so its length is subtracted from every other
 * segment's budget and its characters have to be legal in every namespace Pithy writes into. Until this
 * module existed, `--env` was a bare string that nothing checked — `pithy migrate --env Production`
 * happily addressed an environment that does not exist, and a fourteen-character `--env` quietly ate the
 * room a project name had already been accepted against.
 *
 * The rule itself lives in `@pithy-sh/core/src/naming/environment`, next to the budgets derived from it.
 * This module exists so the CLI has one grep-able name for "the flag has been checked", and one arg
 * description that says what is legal.
 */

/**
 * The shared citty definition for `--env`. Every command that takes one spreads this, so the help text
 * says the same thing everywhere and a new command cannot invent its own wording.
 *
 * `dev` is the default because every command is safe there: it is local, it is the top-level wrangler
 * stanza, and a missing flag should never reach a deployed environment by accident.
 *
 * **The text names the default set, not the project's.** citty resolves an arg's description when the
 * command tree is built — before any `pithy.config.ts` has been read, and in `pithy --help` outside a
 * project entirely — so a declaration cannot reach it. The refusal is where the project's own set is
 * named: {@link requireManagedEnvironment} lists exactly what this project declared.
 */
export const ENV_ARG = {
  type: "string",
  default: "dev",
  description: `Target environment: ${ENVIRONMENTS.join(", ")}, or one declared in pithy.config.ts`,
} as const;

/**
 * {@link ENV_ARG} with the flag's *purpose* spelled out, for the handful of commands where "target
 * environment" is not the whole story — `--drop`'s environment, the one the pending count is taken
 * against. The legal set is appended here rather than retyped, so it stays one list.
 */
export function envArg(purpose: string): { type: "string"; default: "dev"; description: string } {
  return { ...ENV_ARG, description: `${purpose}: ${ENVIRONMENTS.join(", ")}` };
}

/**
 * The `--env` of a command where the flag is genuinely optional — today only `pithy deploy`, whose bare
 * form ships each worker's top-level wrangler stanza, which is not an environment at all. No default,
 * and {@link requireEnvironment} is applied only to a value that was actually given.
 */
export function optionalEnvArg(purpose: string): { type: "string"; description: string } {
  return { type: "string", description: `${purpose}: ${ENVIRONMENTS.join(", ")}` };
}

/**
 * Check a `--env` value and hand it back, so a command can validate inline:
 * `const env = requireEnvironment(args.env)`.
 *
 * **Call it first, before anything else in the command body.** The point of validating at the edge is
 * that an illegal environment costs nothing — no config load, no Cloudflare call, no half-written
 * wrangler file — and the operator gets one sentence naming the mistake.
 *
 * Throws a `ValidationError` (a flag is something a human typed, never an internal fault) whose action
 * names the fix: `production` is answered with `prod`, an over-long name with the number, and
 * anything else with the charset.
 */
export function requireEnvironment(value: string): string {
  assertValidEnvironment(value);
  return value;
}

/**
 * The same check, narrowed to an environment Pithy **deploys** to — and, since #241, to one **this
 * project declared**. `dev` is a legal environment and not a legal target: it resolves from `.dev.vars`
 * and a local Miniflare, so provisioning it would look up a Worker that was never deployed.
 *
 * One helper rather than a bare `ManagedEnvironment.parse` at each call site, because a Zod failure is
 * not a `PithyError`: it escapes `withErrorReporting` and prints a stack trace where the operator should
 * see one sentence. And `dev` gets its own answer, since typing it is a reasonable mistake with an
 * unreasonable error.
 *
 * **`declared` is the project's own set, from the root `pithy.config.ts`** ({@link loadProjectEnvironments}).
 * Passing it is what makes `--env live` a refusal that names the declared environments instead of a value
 * that half the CLI accepted and the other half skipped — and it is what lets a project that *does*
 * declare `live` use it everywhere. A caller with no project loaded has nothing to check against and no
 * business calling this.
 */
export function requireManagedEnvironment(
  value: string,
  declared: DeclaredEnvironments | readonly string[],
): ManagedEnvironment {
  const parsed = ManagedEnvironment.safeParse(requireEnvironment(value));
  const environments = managedEnvironments(declared);
  if (parsed.success && environments.includes(parsed.data)) return parsed.data;
  throw new ValidationError({
    message: `--env must be one of ${environments.join(", ")}. Got ${JSON.stringify(value)}.`,
    action:
      value === "dev"
        ? "This deploys to a Cloudflare account, and dev is local-only. Run `pithy dev` instead."
        : `Declare it in \`environments\` in the root pithy.config.ts, or pass one this project has: --env ${environments[0]}`,
  });
}
