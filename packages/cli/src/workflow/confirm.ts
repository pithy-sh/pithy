// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PersonRequiredError } from "@pithy-sh/core/src/error/pithyError";
import { isProductionEnv } from "../seed/safety";

/**
 * What stands between `pithy workflow trigger` and production: an exact phrase naming the environment, from
 * `--confirm` or typed at a terminal. Who counts as production is `isProductionEnv`'s answer, the one
 * `pithy provision` and `pithy seed` use.
 */

/** The exact phrase that unlocks a trigger in one environment. Compared case-insensitively after trimming. */
export function triggerConfirmPhrase(env: string): string {
  return `yes, i really want to trigger ${env.trim().toLowerCase()}`;
}

/** Inputs to the trigger gate. */
export interface ConfirmTriggerOptions {
  /** The environment the Workflow runs in. */
  env: string;
  /** A run that may not prompt. The phrase must then arrive by flag. */
  json: boolean;
  /** The `--confirm` value. Authoritative wherever present. */
  confirmPhrase?: string;
  /** Ask the operator for the phrase. Never called when `json` is set. */
  prompt?: () => Promise<string>;
  /** The project's `seed.productionEnvironments`. */
  productionEnvironments?: readonly string[];
}

/**
 * Resolve when the trigger may run. Every refusal is `core/person_required`: the phrase is a person's to give, so
 * an agent that meets it stops and asks.
 */
export async function assertTriggerConfirmed(options: ConfirmTriggerOptions): Promise<void> {
  if (!isProductionEnv(options.env, options.productionEnvironments)) return;

  const expected = triggerConfirmPhrase(options.env);
  const matches = (input: string | undefined): boolean =>
    input !== undefined && input.trim().toLowerCase() === expected;

  if (options.confirmPhrase !== undefined) {
    if (matches(options.confirmPhrase)) return;
    throw new PersonRequiredError({
      message: `That is not the confirmation phrase for triggering a Workflow in ${options.env}.`,
      action: `Pass --confirm "${expected}".`,
    });
  }

  if (!options.json && options.prompt) {
    if (matches(await options.prompt())) return;
    throw new PersonRequiredError({
      message: `Triggering a Workflow in ${options.env} was not confirmed.`,
      action: `Type the exact phrase, or pass --confirm "${expected}".`,
    });
  }

  throw new PersonRequiredError({
    message: `${options.env} is a production environment.`,
    action: `Pass --confirm "${expected}".`,
  });
}
