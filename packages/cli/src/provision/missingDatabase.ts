// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { withFix } from "../terminal/exitClass";

/**
 * **A database another command creates, found missing on the confirmed account (#697).**
 *
 * Only for an account that was asked and answered: an unconfirmed account's miss is refused upstream with
 * the account named instead (`provision/resources.ts`, #378), because "does not exist" would send an
 * operator to provision something they already have. Here the cause is known, so the refusal carries the
 * command that creates the database as its `fix`.
 */

/**
 * The environment's secrets database is missing. `payments`, `email`, `media` and `storage` all read
 * credentials from it; `why` finishes the action with what this command needs it for.
 */
export function secretsDatabaseMissing(env: string, name: string, why: string): PreconditionFailedError {
  return withFix(
    new PreconditionFailedError({
      message: `The ${env} secrets database (${name}) does not exist.`,
      action: `Run \`pithy secrets provision\` first — ${why}`,
    }),
    { fix: "pithy secrets provision" },
  );
}

/**
 * The project's email-suppression database is missing. It is `@pithy-sh/email`'s, shared across
 * environments, so it carries no environment segment and `pithy email provision` creates it.
 *
 * **That command acts on one Worker**, and with several and no `--worker` it is refused `input/required` — so
 * its `fix` names the Worker the caller resolved, by its `apps/` directory, and a caller that knows none gets
 * no `fix` at all (#697). The action still says what to run, for a person who can answer the question.
 */
export function suppressionDatabaseMissing(name: string, why: string, workerDir?: string): PreconditionFailedError {
  const worker = workerDir === undefined ? undefined : basename(workerDir);
  const command = worker === undefined ? "pithy email provision" : `pithy email provision --worker ${worker}`;
  const error = new PreconditionFailedError({
    message: `This project's email-suppression database (${name}) does not exist.`,
    action: `Run \`${command}\` first — ${why}`,
  });
  return worker === undefined ? error : withFix(error, { fix: `pithy email provision --worker ${worker}` });
}
