// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { EmailEvent } from "./emailEvent";
import { EmailJob } from "./emailJob";
import { EmailSuppression } from "./emailSuppression";

/**
 * The email capability spans two databases. Jobs and events are **per-environment** — they live in the
 * app `DB`, alongside the app's own data, scoped to the environment that sent them. Suppression is
 * **global** — an address that hard-bounced, complained, or unsubscribed must never be emailed from any
 * environment — so it lives in a dedicated, durable `EMAIL_SUPPRESSIONS` database (the same shared-DB
 * pattern `@pithy-sh/secrets` uses), written by the single inbound bounce worker and the unsubscribe
 * callbacks and read by every environment's send path.
 */

/** The per-environment email tables, on the app `DB`. */
export const emailTables = {
  pithyEmailJobs: EmailJob,
  pithyEmailEvents: EmailEvent,
};
export type EmailTables = typeof emailTables;

/** The global suppression table, on the dedicated durable `EMAIL_SUPPRESSIONS` database. */
export const emailSuppressionTables = {
  pithyEmailSuppressions: EmailSuppression,
};
export type EmailSuppressionTables = typeof emailSuppressionTables;

/** The typed Kysely database over the per-environment email tables (jobs + events). */
export type EmailDatabase = Kysely<DatabaseSchema<EmailTables>>;

/** The typed Kysely database over the global suppression table. */
export type EmailSuppressionDatabase = Kysely<DatabaseSchema<EmailSuppressionTables>>;

/** Build the per-environment email database from the app `DB` binding (CamelCasePlugin installed). */
export function emailDatabase(d1: D1Database): EmailDatabase {
  return createDatabase(d1, emailTables);
}

/** Build the global suppression database from the `EMAIL_SUPPRESSIONS` binding. */
export function emailSuppressionDatabase(d1: D1Database): EmailSuppressionDatabase {
  return createDatabase(d1, emailSuppressionTables);
}
