// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { SupportDatabase } from "../data/tables";

/**
 * The FTS5 index's lifecycle — the virtual table **and the three triggers that keep it in step**,
 * created and dropped by `pithy support provision`, **not by a migration**.
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
 * **The triggers inherit that constraint exactly.** They exist only where the table exists, so they
 * are provisioning and not schema — a `CREATE TRIGGER` composed conditionally on `search.fts` would
 * corrupt the ledger for exactly the same reason the table's own statement did. `migrations.workers.test.ts`
 * keeps proving the migration set carries none.
 *
 * ## Why triggers at all
 *
 * The index used to be written by hand at every message write — three call sites, each best-effort —
 * and correctness depended on every future author remembering. There is no shared message-write
 * helper, so a fourth path that forgot produced a thread nobody could search, with nothing failing,
 * nothing logging and no test catching it.
 *
 * `CREATE TRIGGER` was in an undocumented middle on D1 when that was decided: D1 runs an authorizer
 * that rejects SQLite constructs workerd permits (`fts5vocab` is refused where plain FTS5 succeeds),
 * so a trigger passing under Miniflare proved nothing about the deployment that matters. That is
 * settled — the Leed CMS ships a `BEFORE UPDATE … BEGIN SELECT RAISE(ABORT, …); END` trigger in a
 * production migration, so the authorizer permits both the statement and a body that aborts.
 *
 * **The durability contract inverts, deliberately.** A trigger runs inside the message's own
 * statement, so a failure in its body takes the message write down with it — where the old call sites
 * logged and carried on. That swallow existed because a second round trip to a separate table can
 * fail on its own; inside one statement it cannot. The body is a `DELETE` plus an `INSERT` of values
 * already present in `NEW.*`, with no conversion, no constraint and no foreign key, so what remains is
 * the FTS table being absent — which is what {@link SEARCH_TRIGGERS} cannot outlive, since
 * {@link dropSearchIndex} drops the pair together — or disk and corruption, which would have failed the
 * message insert anyway.
 *
 * The one gap the kit cannot close from here is an adopter who upgrades and deploys without re-running
 * `pithy support provision`: the calls are gone, the triggers were never created, and messages
 * silently stop being indexed. `pithy doctor` reports a provisioned table with no triggers as drift
 * and names that command, per environment.
 *
 * Every statement here is idempotent, so provisioning stays safe to re-run — the property every other
 * step of `pithy support provision` already has.
 */

/** The virtual table's name. Snake_case because nothing translates it — every statement here is hand-written. */
export const SEARCH_TABLE = "pithy_support_search";

/**
 * The three triggers, in create order — `_ai`, `_au`, `_ad` after SQLite's own FTS5 naming for the
 * insert, update and delete hooks.
 *
 * Exported because two other places need the exact names and may not re-derive them: `pithy doctor`
 * asks a deployed database whether they are there, and {@link dropSearchIndex} drops them. They carry
 * the `pithy_support_` prefix every table in this capability does, for the same reason — `sqlite_master`
 * is one flat namespace per database and the prefix is the only partition.
 */
export const SEARCH_TRIGGERS = [
  "pithy_support_search_ai",
  "pithy_support_search_au",
  "pithy_support_search_ad",
] as const;

/**
 * Every name a provisioner or `pithy doctor` asks `sqlite_master` about — the table and its triggers.
 *
 * One list, read by both, because the two have to agree about what "provisioned" means. A doctor that
 * looked for two triggers while the provisioner created three would report drift nothing could clear.
 */
export const SEARCH_OBJECTS: readonly string[] = [SEARCH_TABLE, ...SEARCH_TRIGGERS];

/** What is actually in a database: the virtual table, and how much of the trigger set. */
export interface SearchIndexState {
  /** Whether `pithy_support_search` exists. */
  table: boolean;
  /** How many of the three triggers exist — `"some"` is drift, not a pass. */
  triggers: "all" | "some" | "none";
}

/**
 * Read a `sqlite_master` name listing into the two facts anything acts on.
 *
 * **The trigger count is three-valued, and `"some"` is why.** A partial set means one `CREATE TRIGGER`
 * failed or one was dropped by hand, and the consequence is per statement kind — two of three leaves
 * updates or deletes going unindexed while inserts look fine, which is the worst way round. Folding it
 * into `"none"` would also hide it from a teardown: `search.fts: false` has to clear a stray trigger,
 * because a trigger whose table is gone fails every write to `pithy_support_messages`.
 */
export function searchIndexState(names: readonly string[]): SearchIndexState {
  const found = new Set(names);
  const present = SEARCH_TRIGGERS.filter((name) => found.has(name)).length;
  return {
    table: found.has(SEARCH_TABLE),
    triggers: present === SEARCH_TRIGGERS.length ? "all" : present === 0 ? "none" : "some",
  };
}

/** What a provision run has to do to one environment's index. */
export type SearchIndexAction =
  /** Already in the state `search.fts` asks for. */
  | "none"
  /** The table is not there: create it, its triggers, and backfill. */
  | "create"
  /** The table is there and its triggers are not: create them, and backfill the gap they left. */
  | "repair"
  /** `search.fts` is off and something is there: drop the triggers and the table. */
  | "drop";

/**
 * Decide what `pithy support provision` does to one environment's index.
 *
 * **`repair` is the member this release exists for.** A run used to compare one boolean against one
 * boolean — table present against flag set — and return early when they matched. That is exactly the
 * state an adopter is in after upgrading and deploying: the table is present, the flag is set, the
 * `indexMessage` calls are gone from every write path, and the triggers were never created. The old
 * comparison read that as nothing to do, so the command `pithy doctor` names would not have been the
 * command that fixes it.
 *
 * A repair backfills as a create does, because the gap is real: messages written between the deploy
 * and the re-provision had no trigger to fire for them and no application call either.
 *
 * `drop` fires on triggers alone as well as on the table. A trigger body resolves its table at run
 * time, so a trigger outlives a hand-dropped table — and while it does, every write to
 * `pithy_support_messages` fails. Turning the flag off has to clear that rather than read it as a
 * database with no index.
 */
export function searchIndexAction(state: SearchIndexState, wanted: boolean): SearchIndexAction {
  if (!wanted) return state.table || state.triggers !== "none" ? "drop" : "none";
  if (!state.table) return "create";
  return state.triggers === "all" ? "none" : "repair";
}

/**
 * The `CREATE TRIGGER` statements, one per {@link SEARCH_TRIGGERS} entry and in that order.
 *
 * **`BEGIN` and `END` are uppercase, and that is load-bearing.** Miniflare accepts a lowercase
 * compound-statement body; remote D1 rejects it as `incomplete input [code: 7500]`, so a lowercased
 * body passes every local test in this repository and fails on deploy. `searchIndex.test.ts` fails on
 * the lowercase form, because no Workers test can.
 *
 * **Every column is the physical snake_case name.** `CamelCasePlugin` snake-cases the identifiers the
 * query builder emits and never touches a string inside a `sql` template, so this is the one place in
 * the package that has to spell them itself: `NEW.id`, `NEW.thread_id`, `NEW.subject`, `NEW.text_body`
 * — never the camelCase keys `data/tables.ts` declares.
 *
 * **Insert and update both delete first.** An FTS5 table has no primary key and no unique constraint
 * to lean on, so a bare insert on a second write for the same message would add a second copy and the
 * thread would start appearing twice in its own search results — the same reason `indexMessage` is
 * remove-then-insert. The update body keys its delete on `OLD.id`, so a row whose id changed takes its
 * old index entry with it.
 */
export function searchTriggerStatements(): string[] {
  const insert = "INSERT INTO pithy_support_search(thread_id, message_id, subject, body)";
  const values = "VALUES (NEW.thread_id, NEW.id, NEW.subject, NEW.text_body)";
  return [
    `CREATE TRIGGER ${SEARCH_TRIGGERS[0]} AFTER INSERT ON pithy_support_messages BEGIN
       DELETE FROM pithy_support_search WHERE message_id = NEW.id;
       ${insert} ${values};
     END`,
    `CREATE TRIGGER ${SEARCH_TRIGGERS[1]} AFTER UPDATE ON pithy_support_messages BEGIN
       DELETE FROM pithy_support_search WHERE message_id = OLD.id;
       ${insert} ${values};
     END`,
    `CREATE TRIGGER ${SEARCH_TRIGGERS[2]} AFTER DELETE ON pithy_support_messages BEGIN
       DELETE FROM pithy_support_search WHERE message_id = OLD.id;
     END`,
  ];
}

/**
 * Create the full-text index and its triggers if they are not already there.
 *
 * A standalone (not external-content) FTS5 table. External content would store the text once rather
 * than twice, but it requires the indexed column names to exist verbatim on the content table, and
 * ours is `text_body` rather than `body`. Duplicating is the honest trade for an index that cannot
 * desynchronize on a column rename.
 *
 * `thread_id` and `message_id` are UNINDEXED: they are carried so a match resolves straight to a
 * conversation and so one message's rows can be replaced, and tokenizing a UUID would only add noise
 * to every query.
 *
 * **The triggers are dropped and recreated rather than guarded with `IF NOT EXISTS`**, which is what
 * makes re-provisioning after a kit upgrade actually converge. `IF NOT EXISTS` is idempotent in the
 * weak sense — it leaves a trigger whose body this release has changed exactly as it was, so a fixed
 * body would reach nobody who already had the old one, and the command `pithy doctor` names would not
 * be the command that fixes it. The pair is ordered so the table is always there before a body refers
 * to it.
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
  for (const [index, statement] of searchTriggerStatements().entries()) {
    await sql.raw(`drop trigger if exists ${SEARCH_TRIGGERS[index]}`).execute(db as Kysely<unknown>);
    await sql.raw(statement).execute(db as Kysely<unknown>);
  }
}

/**
 * Drop the full-text index and its triggers if they are there.
 *
 * Safe by construction: the index is derived, so this costs a rebuild rather than a restore. It is
 * what `pithy support provision` runs when `search.fts` goes back to false — and the reason turning
 * the feature off is now a one-command operation instead of a migration rollback.
 *
 * **The triggers go first, and the order is the whole point.** A trigger whose body inserts into a
 * table that is gone fails every write to `pithy_support_messages`, so dropping the table out from
 * under them would turn a feature flag into an outage on the capability's main write path.
 */
export async function dropSearchIndex(db: SupportDatabase | Kysely<unknown>): Promise<void> {
  for (const trigger of SEARCH_TRIGGERS) {
    await sql.raw(`drop trigger if exists ${trigger}`).execute(db as Kysely<unknown>);
  }
  await sql`drop table if exists pithy_support_search`.execute(db as Kysely<unknown>);
}
