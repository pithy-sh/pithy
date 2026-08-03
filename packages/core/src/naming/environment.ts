// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";
import { NAME_SEGMENT } from "./segment";

/**
 * What an environment may be called, in one module.
 *
 * An environment name is not decoration: it sits in the middle of every Cloudflare name a project
 * composes (`<project>-<env>-<thing>`), so its length is subtracted from every other segment's
 * budget, and its characters have to be legal in every namespace Pithy writes into. Until this
 * module existed, `--env` was a bare string that nothing checked — a fourteen-character environment
 * quietly ate the room a project name had already been accepted against.
 */

/**
 * The three first-class environments: local `dev`, `staging` for test users, `prod` for paid ones.
 *
 * **`prod`, not `production`.** The long form cost three characters of every project name, in a
 * budget where thirty-three was the ceiling, and bought nothing a four-letter word does not say.
 */
export const ENVIRONMENTS = ["dev", "staging", "prod"] as const;

/** One of Pithy's first-class environments. A custom environment is a `string`, and still validated. */
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The scope that sits beside the environments: one value shared by all of them.
 *
 * It occupies the same slot as an environment in a composed name, which is exactly why an
 * environment may not be *called* `global` — a project would then have one set of names for two
 * different scopes, and teardown could not tell them apart.
 */
export const GLOBAL_SCOPE = "global";

/**
 * The longest an environment name may be — **the longest canonical one, `staging`**.
 *
 * This is a derivation input, not a preference: `WORKFLOW_DERIVED_PROJECT_NAME` and
 * `FEATURE_DERIVED_PROJECT_NAME` are both computed against it, so every project name Pithy has ever
 * accepted was accepted on the assumption that no environment exceeds it. Letting a custom
 * environment run longer would retroactively shrink that cap — and a provisioned project cannot be
 * renamed. So a longer environment is refused here, at the one place that can still say no.
 *
 * Read off {@link ENVIRONMENTS} rather than typed, so adding an environment cannot leave the two
 * disagreeing.
 */
export const MAX_ENVIRONMENT_NAME = Math.max(...ENVIRONMENTS.map((environment) => environment.length));

/**
 * Is this a name an environment may carry?
 *
 * **Read raw, never kebabbed** — and that is the difference between this rule and the project rule.
 * A project name is prose an adopter types once into `pithy.config.ts`, so `Acme Corp` is politely
 * composed into `acme-corp`. An environment is an identifier repeated in `--env`, in
 * `.dev.vars.<environment>`, and in a wrangler environment key; normalising `Prod` to `prod` would
 * make two spellings name one environment in some places and two in others.
 */
export function isValidEnvironment(name: string): boolean {
  if (name === GLOBAL_SCOPE) return false;
  return name.length <= MAX_ENVIRONMENT_NAME && NAME_SEGMENT.test(name);
}

/**
 * Refuse a name no environment may carry, as a `ValidationError` — an environment comes from a flag
 * or a config file, so it is a 400 with an action, never an internal fault.
 *
 * Three different mistakes get three different sentences, because "invalid environment" helps with
 * none of them: `production` is the old spelling and gets the new one, a long name gets the number,
 * and anything else gets the charset.
 */
export function assertValidEnvironment(name: string): void {
  if (isValidEnvironment(name)) return;
  if (name === "production") {
    throw new ValidationError({
      message: `"production" is not an environment name in Pithy.`,
      action: "Use `prod`.",
      detail: `An environment stops at ${MAX_ENVIRONMENT_NAME} characters, the length of the longest of ${ENVIRONMENTS.join(", ")}.`,
    });
  }
  if (name === GLOBAL_SCOPE) {
    throw new ValidationError({
      message: `"${GLOBAL_SCOPE}" is a scope, not an environment.`,
      action: `Name the environment one of ${ENVIRONMENTS.join(", ")}.`,
      detail: `${GLOBAL_SCOPE} occupies the environment slot of a composed name for values shared across every environment.`,
    });
  }
  if (name.length > MAX_ENVIRONMENT_NAME && NAME_SEGMENT.test(name)) {
    throw new ValidationError({
      message: `"${name}" is ${name.length} characters. An environment stops at ${MAX_ENVIRONMENT_NAME}.`,
      action: `Use one of ${ENVIRONMENTS.join(", ")}, or a shorter name.`,
      detail: `Every project-name budget is derived against a ${MAX_ENVIRONMENT_NAME}-character environment, and a provisioned project cannot be renamed.`,
    });
  }
  throw new ValidationError({
    message: `"${name}" can't be an environment name.`,
    action: "Use lowercase letters, digits, and single hyphens, starting with a letter.",
    detail: `An environment is used verbatim in Cloudflare resource names, so it must match ${NAME_SEGMENT.source}.`,
  });
}
