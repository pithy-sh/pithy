// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { SupportDatabase } from "../data/tables";

/**
 * The FTS5 index's lifecycle — created and dropped by `pithy support provision`, **not by a
 * migration**.
 *
 * ## Why this is not a migration
 *
 * Because it holds no data. Every row in it is derived from `pithy_support_messages`, and
 * `reindexThread` rebuilds it from there at any time — so dropping it loses a search box for as long
 * as it takes to rebuild, and nothing else. That is the line: a migration is for schema whose loss
 * loses data, and this is a provisioned resource like the R2 bucket and the routing rule, which
 * support already creates the same way.
 *
 * Making it a migration was the mistake, and the failure was specific rather than theoretical.
 * Composing it conditionally on `search.fts` meant turning the flag **off** removed an
 * already-applied migration from the set, and Kysely reads a previously-executed migration that has
 * vanished as corruption:
 *
 *     corrupted migrations: previously executed migration 1200_support_0002_search is missing
 *
 * Every capability's migrations for a database compose into one provider, so that throw blocked
 * `pithy migrate` for auth, payments, and email too — a whole-database outage from one capability's
 * config flag, fixable only by knowing to roll back first. Out of the ledger, there is nothing to
 * corrupt and toggling either way is just a re-provision.
 *
 * Both statements are idempotent, so provisioning stays safe to re-run — the property every other
 * step of `pithy support provision` already has.
 */

/** The virtual table's name. Snake_case because nothing translates it — every statement here is hand-written. */
export const SEARCH_TABLE = "pithy_support_search";

/**
 * Create the full-text index if it is not already there.
 *
 * A standalone (not external-content) FTS5 table. External content would store the text once rather
 * than twice, but it requires the indexed column names to exist verbatim on the content table, and
 * ours is `text_body` rather than `body`. Duplicating is the honest trade for an index that cannot
 * desynchronize on a column rename.
 *
 * `thread_id` and `message_id` are UNINDEXED: they are carried so a match resolves straight to a
 * conversation and so one message's rows can be replaced, and tokenizing a UUID would only add noise
 * to every query.
 */
export async function createSearchIndex(db: SupportDatabase | Kysely<unknown>): Promise<void> {
  await sql`
    create virtual table if not exists pithy_support_search using fts5(
      thread_id unindexed,
      message_id unindexed,
      subject,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `.execute(db as Kysely<unknown>);
}

/**
 * Drop the full-text index if it is there.
 *
 * Safe by construction: the index is derived, so this costs a rebuild rather than a restore. It is
 * what `pithy support provision` runs when `search.fts` goes back to false — and the reason turning
 * the feature off is now a one-command operation instead of a migration rollback.
 */
export async function dropSearchIndex(db: SupportDatabase | Kysely<unknown>): Promise<void> {
  await sql`drop table if exists pithy_support_search`.execute(db as Kysely<unknown>);
}
