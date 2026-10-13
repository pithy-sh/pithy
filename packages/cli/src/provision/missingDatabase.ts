// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand, remedy, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { withFix } from "../terminal/exitClass";

/**
 * **A database another command creates, found missing on the confirmed account (#697).**
 *
 * Only for an account that was asked and answered: an unconfirmed account's miss is refused upstream with
 * the account named instead (`provision/resources.ts`, #378), because "does not exist" would send an
 * operator to provision something they already have. Here the cause is known, so the refusal names the
 * command that creates the database — as its `fix` where an agent may run it as written, and as a person's
 * decision where it runs against production (#711).
 */

/**
 * The environment's secrets database is missing. `payments`, `email`, `media` and `storage` all read
 * credentials from it; `why` finishes the action with what this command needs it for.
 */
export function secretsDatabaseMissing(env: string, name: string, why: string): PreconditionFailedError {
  // The provision that creates it runs against every environment, production included: a person's decision, never
  // the fix for one environment's database (#711).
  const creates = remedy("secrets provision");
  const error = new PreconditionFailedError({
    message: `The ${env} secrets database (${name}) does not exist.`,
    action: `${creates.say((command) => `Run \`${command}\`.`)} It creates this database — ${why}`,
  });
  return creates.fix === undefined ? error : withFix(error, creates.fix);
}

/**
 * The project's email-suppression database is missing. It is `@pithy-sh/email`'s, shared across
 * environments, so it carries no environment segment and `pithy email provision` creates it.
 *
 * **That command acts on one Worker**, and with several and no `--worker` it is refused `input/required` — so
 * its `fix` names the Worker the caller resolved, by its `apps/` directory (#697), and the action names the same
 * command (#711). The Worker is required: a sentence with no Worker to name would name a placeholder, which no
 * project runs.
 */
export function suppressionDatabaseMissing(name: string, why: string, workerDir: string): PreconditionFailedError {
  const remedy = pithyCommand("email provision", { flags: { "--worker": workerDirOf({ dir: workerDir }) } });
  const error = new PreconditionFailedError({
    message: `This project's email-suppression database (${name}) does not exist.`,
    action: `Run \`${remedy}\` first — ${why}`,
  });
  return withFix(error, remedy);
}
