// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * **An option a manifest states no `default` for is a required option.** That is the whole model.
 *
 * There is no flag beside a default that could contradict it. An option that states a default has an
 * answer the kit is willing to pick; an option that states none has one only the adopter can — so every
 * path that could write a config either carries a value for it or refuses, and none of them guesses.
 *
 * The defect this closes had one shape in three places. `ConfigOption.default` was a required field, so
 * `promptConfigValues` offered `String(option.default)` as the thing enter accepts, and a `--json` or
 * non-TTY run attached no prompt at all and fell straight through to the manifest's value. `pithy add
 * payments --json` picked a billing model: whether an entitlement is held by a person or a company, into
 * a column and a UNIQUE index, reported as `Done.` A project that meant `organization` found out when it
 * had subscriptions (#412).
 *
 * So the rule lives here, once, and both writers ask it — `pithy add`'s flow before it wires anything,
 * and `pithy upgrade`'s reconcile before it splices a key into a registration it did not write.
 */

/** The half of a config option this module needs: what to name, and what it legally takes. */
export interface RequiredOption {
  /** The option's key, as `--set key=value` spells it. */
  readonly key: string;
  /** The closed set of values it takes, when it states one. */
  readonly choices?: readonly string[] | undefined;
  /** The manifest's default. `undefined` is the declaration that this option is required. */
  readonly default?: unknown;
}

/** Whether this option must be answered before anything can be written for it. */
export function isRequired(option: RequiredOption): boolean {
  return option.default === undefined;
}

/**
 * The required options this run has not settled, in manifest order.
 *
 * Asked **after** `--set` and any prompt, because those are the two ways of settling one and the answer
 * is the same whichever it came from. A run with a human attached is never refused for a question it was
 * asked; a run with no human is refused for a question nobody could ask it.
 */
export function unsettledOptions<T extends RequiredOption>(
  options: readonly T[],
  values: Readonly<Record<string, unknown>>,
): T[] {
  return options.filter((option) => isRequired(option) && values[option.key] === undefined);
}

/** What {@link requiredOptionRefusal} names: the capability, and each option nobody answered. */
export interface RequiredOptionRefusalOptions {
  /** The capability being wired, as `pithy add <capability>` spells it. */
  capability: string;
  /** The unsettled options, in manifest order. */
  missing: readonly RequiredOption[];
}

/** `--set key=a or --set key=b` for a closed set, `--set key=<value>` for an open one. */
function flagsFor(option: RequiredOption): string {
  const choices = option.choices;
  if (choices === undefined || choices.length === 0) return `--set ${option.key}=<value>`;
  const flags = choices.map((choice) => `--set ${option.key}=${choice}`);
  if (flags.length === 1) return flags[0] as string;
  return `${flags.slice(0, -1).join(", ")} or ${flags[flags.length - 1]}`;
}

/** `a`, `a and b`, `a, b and c` — for a sentence, never for a command line. */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The refusal a run that names no value for a required option takes.
 *
 * Shaped like `prerequisiteRefusal`, and for the same reason: the `message` says what is wrong and the
 * `action` is the operator's, so it names the exact flag and every value that flag takes. An agent
 * driving `pithy add --json` has one line to correct itself from, and "billingSubject is required" is not
 * that line — `--set billingSubject=user or --set billingSubject=organization` is.
 */
export function requiredOptionRefusal(options: RequiredOptionRefusalOptions): ValidationError {
  const { capability, missing } = options;
  const keys = missing.map((option) => option.key);
  return new ValidationError({
    message: `${capability} needs a value for ${andList(keys)}, and nothing in this run names one.`,
    action: `Pass ${missing.map(flagsFor).join(", and ")}.`,
    detail: `${capability}'s manifest declares ${JSON.stringify(keys)} with no default, which is how a capability says the answer is the adopter's. There is nothing to render and nothing to accept by pressing enter.`,
  });
}
