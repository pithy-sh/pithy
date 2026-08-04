// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { LedgerAccount } from "../data/account";
import { LEDGER_ACCOUNTS_TABLE, LEDGER_TRANSACTIONS_TABLE, ledgerDatabase } from "../data/tables";
import { LedgerTransaction } from "../data/transaction";

/**
 * The management read model — the queries behind the control-plane routes, and nothing else.
 *
 * **It lives beside `ledger.ts` rather than inside it.** The `Ledger` interface is the
 * server-authoritative movement primitive: everything on it changes a balance or reads the caller's
 * own. These read across *every* player, which is a different operation with a different blast radius,
 * and keeping it out of the primitive means an in-process caller cannot reach it by accident.
 *
 * ## Keyset, never offset
 *
 * Both listings paginate on `id`, descending, through the shared cursor helper in
 * `@pithy-sh/core/src/data/cursor`. `id` is an autoincrement primary key on both tables, so it is
 * monotonic and unique — which makes it a sufficient keyset position on its own, with the cursor's
 * `sort` and `id` carrying the same value. `OFFSET` would shift under a reader the moment any balance
 * moves, and on a ledger something is always moving: a page 2 fetched a second later would repeat rows
 * it already showed and skip rows it never did.
 *
 * ## The indexes these were written for
 *
 * `pithyLedgerTransactionsOwnerIdx` is `(userId, currency, id)`, which is exactly the shape
 * {@link listTransactions} needs — both filters are equalities and the ordering column is the index's
 * tail, so the page is a range scan and the `LIMIT` genuinely stops it. That is why the route requires
 * a currency rather than offering "everything this player did": without it the index gives no ordering
 * and the database sorts the player's whole history to return twenty-five rows.
 *
 * {@link listAccounts} orders by the accounts table's primary key for the same reason — it is the only
 * indexed monotonic column on that table. `updatedAt` would be the more useful sort for an operator
 * ("who moved most recently"), and it has no index; adding one is a migration a read-only pane does not
 * justify, so the order is account-opened order and this says so rather than pretending otherwise.
 */

/** One page of a keyset listing, and where the next one resumes. */
export interface LedgerPage<T> {
  /** The rows, newest first. */
  items: T[];
  /** The cursor for the next page, or null at the end of the list. Opaque; hand it back verbatim. */
  nextCursor: string | null;
}

/** What {@link listAccounts} accepts. */
export interface AccountsQuery {
  /** Restrict to one currency code. Already resolved against config by the handler. */
  currency?: string;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** What {@link listTransactions} accepts, beyond the account it is for. */
export interface TransactionsQuery {
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** A row's keyset position. `id` is monotonic on both tables, so it is both the sort and the tiebreak. */
function position(row: { id: number }): PageCursor {
  return { sort: row.id, id: row.id };
}

/**
 * The `id` a page resumes before, or undefined for the first page.
 *
 * A cursor whose `id` is not a number was not one of ours — a truncated value, a cursor from another
 * listing, a hand-built guess. It resolves to the first page rather than to an error, which is what
 * core's `decodeCursor` promises and what stops a bad cursor from being a probe.
 */
function resumeBefore(cursor: string | undefined): number | undefined {
  const decoded = decodeCursor(cursor);
  return typeof decoded?.id === "number" ? decoded.id : undefined;
}

/**
 * Every account holding a balance, newest first, optionally in one currency.
 *
 * The rows are parsed through {@link LedgerAccount}, so dates decode and the shape is validated on the
 * way out of D1 exactly as it is on the way in.
 */
export async function listAccounts(d1: D1Database, query: AccountsQuery = {}): Promise<LedgerPage<LedgerAccount>> {
  const limit = pageLimit(query.limit);
  const before = resumeBefore(query.cursor);
  let selection = ledgerDatabase(d1)
    .selectFrom(LEDGER_ACCOUNTS_TABLE)
    .selectAll()
    .orderBy("id", "desc")
    // One more than asked for: the extra row is how "is there another page" is answered without a
    // COUNT, which on this table would be a full scan on every page load.
    .limit(limit + 1);
  if (query.currency !== undefined) selection = selection.where("currency", "=", query.currency);
  if (before !== undefined) selection = selection.where("id", "<", before);
  const rows = await selection.execute();
  return toPage(
    rows.map((row) => LedgerAccount.parse(row)),
    limit,
    position,
  );
}

/**
 * Every account one player holds, ordered by currency code.
 *
 * Unpaginated on purpose: an account is keyed `(userId, currency)` and currencies are config rather
 * than rows, so this returns at most one row per configured currency. A cursor over a list bounded by
 * the adopter's own config would be ceremony.
 */
export async function readAccounts(d1: D1Database, userId: string): Promise<LedgerAccount[]> {
  const rows = await ledgerDatabase(d1)
    .selectFrom(LEDGER_ACCOUNTS_TABLE)
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("currency", "asc")
    .execute();
  return rows.map((row) => LedgerAccount.parse(row));
}

/** One account's entry log, newest first — the history that explains its balance. */
export async function listTransactions(
  d1: D1Database,
  userId: string,
  currency: string,
  query: TransactionsQuery = {},
): Promise<LedgerPage<LedgerTransaction>> {
  const limit = pageLimit(query.limit);
  const before = resumeBefore(query.cursor);
  let selection = ledgerDatabase(d1)
    .selectFrom(LEDGER_TRANSACTIONS_TABLE)
    .selectAll()
    .where("userId", "=", userId)
    .where("currency", "=", currency)
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (before !== undefined) selection = selection.where("id", "<", before);
  const rows = await selection.execute();
  return toPage(
    rows.map((row) => LedgerTransaction.parse(row)),
    limit,
    position,
  );
}
