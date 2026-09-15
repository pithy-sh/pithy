// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";

/**
 * **A rollback outside `dev` is asked for in words (#588).**
 *
 * `pithy migrate --rollback` steps back one migration in every database the environment binds, and
 * `migrate` had no confirmation at all — `seed --redo` asked for a typed phrase while the command that
 * emptied staging's vault asked for nothing. The phrase names its environment, the same shape
 * `resetConfirmPhrase` and `provisionConfirmPhrase` have, so one typed for `staging` cannot be pasted into
 * a command aimed at `prod`.
 *
 * `dev` stays free: a local Miniflare store is what a rollback is for.
 */

/** The exact phrase that unlocks a rollback of `env`. Compared case-insensitively after trimming. */
export function rollbackConfirmPhrase(env: string): string {
  return `yes, i really want to roll back ${env.trim().toLowerCase()}`;
}

/**
 * Refuse a non-`dev` rollback whose phrase is missing or wrong. The command collects the phrase — from
 * `--confirm-rollback`, or interactively — and `migrateProject` checks it, so a caller that reaches the
 * operation without the command still has to state it.
 */
export function assertRollbackConfirmed(env: string, phrase: string | undefined): void {
  if (env === LOCAL_ENVIRONMENT) return;
  const expected = rollbackConfirmPhrase(env);
  if (phrase !== undefined && phrase.trim().toLowerCase() === expected) return;
  throw new ValidationError({
    message:
      phrase === undefined
        ? `Rolling back ${env} steps back every database it binds.`
        : `That is not the confirmation phrase for rolling back ${env}.`,
    action: `Pass --confirm-rollback "${expected}" to roll back ${env}.`,
  });
}

/**
 * The `--destroy-retained <n>` flag, as a count. A non-negative whole number or a refusal: `yes`, `-1` and
 * `5.5` are not a number of rows anybody counted, and a flag that parsed them into something would be
 * agreeing on the operator's behalf. Absent stays absent — see `@pithy-sh/core`'s `migrations/retained`.
 */
export function parseDestroyRetained(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  throw new ValidationError({
    message: `--destroy-retained takes a row count, not "${value}".`,
    action: "Pass the number of retained rows the refusal printed.",
  });
}

/** The help line every command that can reverse migrations gives its `--destroy-retained` flag. */
export const DESTROY_RETAINED_DESCRIPTION =
  "DESTRUCTIVE: drop rows in retained tables (the secrets vault, email suppressions). Must equal the count the refusal printed";
