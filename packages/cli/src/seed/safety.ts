// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { SeedSet } from "@pithy-sh/core/src/seed/seed";

/**
 * The layered env-safety model for `pithy seed`. Two gates stand between a fixture and a write:
 *
 *  1. **Allowlist** — a set is seeded into an environment only if its `environments` lists it. Core's
 *     `composeSeeds` already filters on this; {@link assertSetAllowedForEnv} re-asserts it per set at
 *     write time, so a set can never reach a disallowed environment even if the plan is bypassed.
 *  2. **Escalating confirmation** — `dev` runs freely; `staging` and `production` require `--yes`; and
 *     `production` additionally requires a hard, exact type-to-confirm phrase. {@link assertSeedConfirmed}
 *     is the gate.
 *
 * `production` is never seeded by accident: the allowlist keeps a set out unless it opts in, and the
 * confirm phrase keeps a run from starting unless a human (or an explicit CI flag) types the exact words.
 */

/** The exact phrase that unlocks a production seed. Compared case-insensitively after trimming. */
export const PRODUCTION_CONFIRM_PHRASE = "yes, i really want to seed production";

/**
 * The built-in env names that trigger the strongest gate — the hard type-to-confirm phrase — not just
 * the literal `"production"`. Recognized case-insensitively after trimming, so `prod` and `Production`
 * cannot slip past the phrase with only `--yes`. A project extends this with `seed.productionEnvironments`
 * in `pithy.config.ts` (see {@link isProductionEnv}), so a prod env named `live`/`prod-eu`/`main` is gated
 * identically. Any env classified as production by neither is still guarded by `--yes`.
 */
const PRODUCTION_ENV_NAMES = new Set(["production", "prod"]);

/**
 * Whether `env` names a production environment (case-insensitive), and so needs the hard confirm phrase.
 * `productionEnvironments` are the extra names the project declared in `pithy.config.ts`
 * (`seed.productionEnvironments`), unioned with the built-in `production`/`prod` — the fix for a prod
 * environment whose name is neither canonical value silently dropping to the weaker `--yes`-only gate.
 */
export function isProductionEnv(env: string, productionEnvironments: readonly string[] = []): boolean {
  const normalized = env.trim().toLowerCase();
  if (PRODUCTION_ENV_NAMES.has(normalized)) return true;
  return productionEnvironments.some((name) => name.trim().toLowerCase() === normalized);
}

/**
 * Re-assert the env allowlist for one set (safety layer 1). Throws if `env` is not among the set's
 * declared `environments` — the write-time guard behind "seed refuses to write a set into a disallowed
 * env". Compose already filters disallowed sets out; this makes the invariant impossible to bypass.
 */
export function assertSetAllowedForEnv(set: SeedSet, env: string): void {
  if (!set.environments.includes(env)) {
    throw new ValidationError({
      message: `Seed set "${set.name}" is not allowed in ${env}.`,
      action: `Add "${env}" to the set's environments, or seed one of: ${set.environments.join(", ")}.`,
    });
  }
}

/** Inputs to the escalating-confirmation gate (safety layer 2). */
export interface ConfirmSeedOptions {
  /** The environment being seeded. `dev` is free; `staging`/`production` escalate. */
  env: string;
  /** The `--yes` flag. Required for any non-`dev` environment. */
  yes: boolean;
  /**
   * Non-interactive mode (set by `--json`, or any headless/CI invocation). No prompt is ever shown;
   * production must be unlocked by {@link ConfirmSeedOptions.confirmProduction} instead.
   */
  json: boolean;
  /**
   * The `--confirm-production` flag value. For production it must equal {@link PRODUCTION_CONFIRM_PHRASE}
   * (case-insensitive, trimmed). When present it is authoritative — used even in interactive mode, so a
   * script never has to answer a prompt.
   */
  confirmProduction?: string;
  /**
   * Interactive confirm seam: prompt the operator for the production phrase and resolve their answer.
   * Injected by the command (an `@clack/prompts` text prompt); omitted in tests and never called when
   * {@link ConfirmSeedOptions.json} is set or {@link ConfirmSeedOptions.confirmProduction} is supplied.
   */
  prompt?: () => Promise<string>;
  /**
   * Extra environment names the project classifies as production (`pithy.config.ts`
   * `seed.productionEnvironments`), unioned with the built-in `production`/`prod`. An env named here also
   * requires the hard confirm phrase, so a project whose production environment is named `live`/`prod-eu`
   * is protected like the canonical names rather than passing on `--yes` alone.
   */
  productionEnvironments?: readonly string[];
}

/** Whether `input`, trimmed and lower-cased, is exactly the production confirm phrase. */
function phraseMatches(input: string | undefined): boolean {
  return input !== undefined && input.trim().toLowerCase() === PRODUCTION_CONFIRM_PHRASE;
}

/**
 * The exact phrase that unlocks a `--redo` schema reset for an environment. **Environment-specific on
 * purpose** — a phrase naming `staging` cannot be pasted into a command targeting another environment,
 * which a single fixed phrase would allow.
 */
export function resetConfirmPhrase(env: string): string {
  return `yes, i really want to reset ${env.trim().toLowerCase()}`;
}

/** Inputs to the reset gate — the stronger confirmation `--redo` requires. */
export interface ConfirmResetOptions {
  /** The environment being reset. `dev` is free; everything else needs the phrase. */
  env: string;
  /** Non-interactive mode: no prompt is shown, so the phrase must arrive by flag. */
  json: boolean;
  /** The `--confirm-reset` flag value; authoritative wherever present. */
  confirmReset?: string;
  /** Interactive confirm seam: prompt the operator for the reset phrase. */
  prompt?: () => Promise<string>;
}

/**
 * Enforce the **reset** gate, which is deliberately stricter than the seed gate.
 *
 * `--yes` means "yes, this is not dev" — it was designed to authorize *writing seed rows*, which is
 * additive and non-destructive. `--redo` drops every table first. Letting one flag authorize both would
 * mean a script (or a hand) that knew only to pass `--yes` could destroy an environment's entire dataset.
 * So a reset requires the exact, environment-named phrase for **any** non-`dev` environment — not only
 * production. `dev` stays free, because a local Miniflare store is the thing reset is for.
 *
 * Automation is preserved: CI passes `--confirm-reset` explicitly, so a headless reset still works — it
 * simply cannot happen by accident.
 */
export async function assertResetConfirmed(options: ConfirmResetOptions): Promise<void> {
  if (options.env === "dev") return;

  const expected = resetConfirmPhrase(options.env);
  const matches = (input: string | undefined): boolean =>
    input !== undefined && input.trim().toLowerCase() === expected;

  // The flag is authoritative wherever present (CI or interactive).
  if (options.confirmReset !== undefined) {
    if (matches(options.confirmReset)) return;
    throw new ValidationError({
      message: `That is not the confirmation phrase for resetting ${options.env}.`,
      action: `Pass --confirm-reset "${expected}" to drop and recreate the ${options.env} schema.`,
    });
  }

  if (!options.json && options.prompt) {
    if (matches(await options.prompt())) return;
    throw new ValidationError({
      message: `Reset of ${options.env} not confirmed.`,
      action: `Type the exact phrase, or pass --confirm-reset "${expected}".`,
    });
  }

  throw new ValidationError({
    message: `Resetting ${options.env} destroys all of its data.`,
    action: `Pass --confirm-reset "${expected}" to drop and recreate the ${options.env} schema.`,
  });
}

/**
 * Enforce the escalating-confirmation gate before any write. Resolves when the run is authorized and
 * throws a `ValidationError` otherwise:
 *
 *  - `dev` → always authorized.
 *  - `staging` (and any other non-`dev`, non-production environment) → requires `--yes`.
 *  - production ({@link isProductionEnv}: the built-in `production`/`prod` plus any name the project
 *    declares in `seed.productionEnvironments`, case-insensitive) → requires `--yes` **and** the exact
 *    confirm phrase. A prod environment named `live`/`prod-eu` is gated only if it is declared. The
 *    phrase comes from `--confirm-production` when supplied (the CI/non-interactive path); otherwise,
 *    if interactive, the injected `prompt` is asked for it. `--json` forbids the prompt, so production
 *    without the flag is refused. A supplied-but-wrong phrase is always refused.
 */
export async function assertSeedConfirmed(options: ConfirmSeedOptions): Promise<void> {
  if (options.env === "dev") return;

  if (!options.yes) {
    throw new ValidationError({
      message: `Seeding ${options.env} needs confirmation.`,
      action: `Re-run with --yes to seed ${options.env}.`,
    });
  }

  if (!isProductionEnv(options.env, options.productionEnvironments)) return;

  // Production: the flag is authoritative wherever it is present (CI or interactive).
  if (options.confirmProduction !== undefined) {
    if (phraseMatches(options.confirmProduction)) return;
    throw new ValidationError({
      message: "The production confirmation phrase did not match.",
      action: `Pass --confirm-production "${PRODUCTION_CONFIRM_PHRASE}" to seed production.`,
    });
  }

  // No flag: only an interactive prompt can unlock production. `--json` (or a missing prompt) forbids it.
  if (options.json || !options.prompt) {
    throw new ValidationError({
      message: "Seeding production needs an explicit confirmation phrase.",
      action: `Pass --confirm-production "${PRODUCTION_CONFIRM_PHRASE}" to seed production.`,
    });
  }

  if (phraseMatches(await options.prompt())) return;
  throw new ValidationError({
    message: "The production confirmation phrase did not match.",
    action: `Type "${PRODUCTION_CONFIRM_PHRASE}" exactly to seed production.`,
  });
}
