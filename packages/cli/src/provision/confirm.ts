// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isProductionEnv } from "../seed/safety";

/**
 * **What stands between `pithy provision` and production.**
 *
 * Provisioning creates real account resources and runs migrations against them. Everything else in the
 * kit that reaches production behind one flag is gated the same way, and for the same reason `--redo`
 * is: `--yes` means "yes, this is not dev", and it is the flag every CI job already passes. It cannot
 * also be what authorizes a first write against the environment paying customers are on.
 *
 * So production takes an exact phrase, **and the phrase names its environment** — a phrase typed for
 * `staging` cannot be pasted into a command targeting `prod`, which one fixed sentence would allow. Who
 * counts as production is `isProductionEnv`'s answer, the same one `pithy seed` uses, so a project whose
 * production environment is called `live` declares it once in `seed.productionEnvironments` and is
 * protected everywhere rather than in one command.
 */

/** The exact phrase that unlocks provisioning one environment. Compared case-insensitively after trimming. */
export function provisionConfirmPhrase(env: string): string {
  return `yes, i really want to provision ${env.trim().toLowerCase()}`;
}

/** Inputs to the provisioning gate. */
export interface ConfirmProvisionOptions {
  /** The environment being provisioned. */
  env: string;
  /** The `--yes` flag. Required for every environment; never sufficient for production. */
  yes: boolean;
  /** Non-interactive mode (`--json`, or any headless run). No prompt is shown; the phrase must arrive by flag. */
  json: boolean;
  /** The `--confirm` flag value. Authoritative wherever present, so CI never has to answer a prompt. */
  confirmPhrase?: string;
  /** Interactive confirm seam: ask the operator for the phrase. Never called under `--json`. */
  prompt?: () => Promise<string>;
  /**
   * **Say what is about to happen, before asking anyone to agree to it (#515).**
   *
   * This is where an operator is asked to authorize real Cloudflare resources, and it asked without
   * naming a single one. The plan goes here rather than a line later, so the production prompt is
   * answered by someone who has read what they are unlocking.
   *
   * Called **after** the `--yes` check and before anything is classified as production, and it is a
   * callback rather than a string for exactly that ordering: a run with no `--yes` is a mistake in the
   * command line, gets an answer about the command line, and must not pay for a Worker resolution to
   * hear it. Omitted under `--json`, which prints one line and nothing else.
   */
  announce?: () => Promise<void>;
  /** The names this project classifies as production (`seed.productionEnvironments`), plus the built-ins. */
  productionEnvironments?: readonly string[];
}

/**
 * Enforce the gate. Resolves when the run is authorized, throws a `ValidationError` otherwise.
 *
 * - Any environment → requires `--yes`. Provisioning is never the accidental result of a bare command.
 * - Authorized, and the run has something to say → {@link ConfirmProvisionOptions.announce} prints the
 *   plan. After the flag check, before the production classification, so nobody types a phrase blind.
 * - Production → requires `--yes` **and** the exact {@link provisionConfirmPhrase}, from `--confirm` or,
 *   interactively, from the prompt. `--json` forbids the prompt, so a headless production provision
 *   happens only when a human wrote the phrase into the pipeline.
 */
export async function assertProvisionConfirmed(options: ConfirmProvisionOptions): Promise<void> {
  if (!options.yes) {
    throw new ValidationError({
      message: `Provisioning ${options.env} creates real Cloudflare resources.`,
      action: `Re-run with --yes to provision ${options.env}.`,
    });
  }

  // What the run will touch, before the production gate and before any prompt. See `announce`.
  await options.announce?.();

  if (!isProductionEnv(options.env, options.productionEnvironments)) return;

  const expected = provisionConfirmPhrase(options.env);
  const matches = (input: string | undefined): boolean =>
    input !== undefined && input.trim().toLowerCase() === expected;

  // The flag is authoritative wherever present (CI or interactive).
  if (options.confirmPhrase !== undefined) {
    if (matches(options.confirmPhrase)) return;
    throw new ValidationError({
      message: `That is not the confirmation phrase for provisioning ${options.env}.`,
      action: `Pass --confirm "${expected}".`,
    });
  }

  if (!options.json && options.prompt) {
    if (matches(await options.prompt())) return;
    throw new ValidationError({
      message: `Provisioning ${options.env} was not confirmed.`,
      action: `Type the exact phrase, or pass --confirm "${expected}".`,
    });
  }

  throw new ValidationError({
    message: `${options.env} is a production environment.`,
    action: `Pass --confirm "${expected}".`,
  });
}
