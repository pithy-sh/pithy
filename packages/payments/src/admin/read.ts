// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import type { z } from "zod";
import { PaymentsEntitlement } from "../data/entitlement";
import { PaymentsPurchase, type PurchaseEnvironment } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
import { PaymentsReconcileRun } from "../data/reconcileRun";
import type { PurchaseStatus } from "../data/status";
import {
  PAYMENTS_ENTITLEMENTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  PAYMENTS_RECONCILE_RUNS_TABLE,
  paymentsDatabase,
} from "../data/tables";

/**
 * The management read model — the queries behind the control-plane reads, and nothing else.
 *
 * **It lives beside the projection rather than inside it.** Everything in `projection/` writes or reads
 * one account's own rows; these read across *every* account, which is a different operation with a
 * different blast radius. Keeping it out of the projection means no in-process caller reaches it by
 * accident, and it is the same arrangement `@pithy-sh/ledger`'s `admin/read.ts` makes for the same
 * reason.
 *
 * ## The payload is not projected, and it is not selected either
 *
 * `pithy_payments_purchases.payload` is the whole verified provider response: a bearer artifact on Apple
 * and Google, and on Stripe a document carrying the buyer's email address, name and billing details.
 * Every query below names its columns, and that column is not among them — so the receipt does not reach
 * the Worker's memory on a management read at all, let alone the response. A projection that dropped it
 * afterwards would be one refactor away from leaking it; a `SELECT` that never asks for it is not.
 *
 * That is also the honest answer to the masking question `@pithy-sh/email` answers by masking a
 * recipient. Payments stores **no** direct personal identifier of its own — the only identity column on
 * either table is `userId`, the opaque id the adopter's auth capability issued, which is already the
 * address a management client must name to ask about a person. The single field that would have carried
 * an email address into a purchases list is `payload`, and the control is stronger than a mask: it is
 * never read.
 *
 * ## Keyset, never offset
 *
 * Every listing pages on `(sort, id)` descending through core's shared cursor helper. `OFFSET` shifts
 * under a reader whenever a row is inserted, and a purchase table is written to by three paths at once —
 * a client submission, three providers' webhooks, and the nightly reconciliation pass. A page 2 fetched
 * a second later would repeat rows it already showed and skip rows it never did.
 *
 * The primary key here is a **text UUID**, deliberately (sequential ids would leak order volume), so it
 * is no use as a sort: it is unique but it is not monotonic. Purchases therefore sort on `purchasedAt`
 * with the id as the tiebreak, and entitlements on `createdAt` with the same. Both columns are indexed
 * for exactly this by `payments_0001_purchases` — without those indexes a purchases pane would sort a
 * customer's entire order history on every page load.
 */

/** One page of a keyset listing, and where the next one resumes. */
export interface PaymentsPage<T> {
  /** The rows, newest first. */
  items: T[];
  /** The cursor for the next page, or null at the end of the list. Opaque; hand it back verbatim. */
  nextCursor: string | null;
}

/**
 * A purchase as a management read sees it — every column but the stored provider payload, the provider
 * SKU, and the bookkeeping timestamps the projection keeps for itself.
 *
 * Derived from {@link PaymentsPurchase} with `.pick`, never restated, so the row schema stays the one
 * definition of the table and the codecs still decode dates on the way out of D1. `providerProductId`
 * is left behind because `productId` and `rail` already name what was bought and the SKU is the
 * adopter's own config; `providerEventAt` and `createdAt` because they describe when *we* processed
 * something, which is a question for the audit trail rather than for a purchases pane.
 */
export const PaymentsPurchaseRecord = PaymentsPurchase.pick({
  id: true,
  userId: true,
  rail: true,
  providerTransactionId: true,
  originalTransactionId: true,
  productId: true,
  type: true,
  status: true,
  environment: true,
  amountMinor: true,
  currency: true,
  purchasedAt: true,
  expiresAt: true,
  revokedAt: true,
  updatedAt: true,
}).describe("One purchase as a management read selects it — never the stored provider payload.");
export type PaymentsPurchaseRecord = z.output<typeof PaymentsPurchaseRecord>;

/** The columns {@link PaymentsPurchaseRecord} covers, as Kysely needs them. One list, derived from the schema. */
const PURCHASE_COLUMNS = Object.keys(PaymentsPurchaseRecord.shape) as (keyof PaymentsPurchaseRecord)[];

/** What {@link listPurchases} accepts. Every filter is optional; together they are an AND. */
export interface PurchasesQuery {
  /** Restrict to one account's purchases. */
  userId?: string;
  /** Restrict to one store. */
  rail?: PaymentsRail;
  /** Restrict to one normalized status. */
  status?: PurchaseStatus;
  /** Restrict to one store environment — the filter that separates real money from test transactions. */
  environment?: PurchaseEnvironment;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** What {@link listSubscriptions} accepts. No `rail`: a subscription is read forwards, not by store. */
export interface SubscriptionsQuery {
  /** Restrict to one account's subscriptions. */
  userId?: string;
  /** Restrict to one normalized status — `active`, `in_grace`, `canceled`. */
  status?: PurchaseStatus;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** What {@link listEntitlements} accepts. */
export interface EntitlementsQuery {
  /** Restrict to one account. */
  userId?: string;
  /** Restrict to one entitlement key — "who holds `pro`". */
  entitlement?: string;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/**
 * A cursor this table can resume from, or undefined.
 *
 * `PageCursor.sort` is a union because Better Auth stores ISO text where Pithy's own tables store
 * ms-epoch numbers, and comparing a string against an integer column in SQLite silently orders by
 * something nobody meant. Both tables here store a number, so anything else is treated exactly as a
 * malformed cursor is: undefined, and the caller gets a first page rather than an error it could probe.
 */
function resume(raw: string | undefined): { sort: number; id: string } | undefined {
  const cursor: PageCursor | undefined = decodeCursor(raw);
  if (!cursor || typeof cursor.sort !== "number") return undefined;
  return { sort: cursor.sort, id: String(cursor.id) };
}

/**
 * The purchase log, newest first, filtered.
 *
 * Ordered on `purchasedAt` — when the *store* recorded the sale — rather than on when we first heard of
 * it. A reconciliation pass backfilling a week-old purchase must land in the week-old position, or a
 * purchases pane becomes a log of our own processing rather than of the customer's commerce.
 */
export async function listPurchases(
  d1: D1Database,
  query: PurchasesQuery = {},
): Promise<PaymentsPage<PaymentsPurchaseRecord>> {
  return await purchasePage(d1, query, undefined);
}

/**
 * The purchases that renew, newest first.
 *
 * A separate function rather than a `type` filter {@link listPurchases} would accept, because a caller
 * that could name the type could hold `payments:subscriptions:read` and read the whole purchase log
 * through it. The narrowing is applied here, where no request reaches it.
 */
export async function listSubscriptions(
  d1: D1Database,
  query: SubscriptionsQuery = {},
): Promise<PaymentsPage<PaymentsPurchaseRecord>> {
  return await purchasePage(d1, query, "subscription");
}

/** One page of the purchases table, with the product type fixed by the caller rather than by a request. */
async function purchasePage(
  d1: D1Database,
  query: PurchasesQuery,
  type: "subscription" | undefined,
): Promise<PaymentsPage<PaymentsPurchaseRecord>> {
  const limit = pageLimit(query.limit);
  const after = resume(query.cursor);

  let selection = paymentsDatabase(d1)
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    // Named columns, never `selectAll`. `payload` is a bearer artifact and is not among them, so a
    // management read never loads one — see the file comment.
    .select(PURCHASE_COLUMNS)
    .orderBy("purchasedAt", "desc")
    .orderBy("id", "desc")
    // One more than asked for: the extra row is how "is there another page" is answered without a COUNT,
    // which on a purchase table is a full scan on every page load.
    .limit(limit + 1);

  if (type !== undefined) selection = selection.where("type", "=", type);
  if (query.userId !== undefined) selection = selection.where("userId", "=", query.userId);
  if (query.rail !== undefined) selection = selection.where("rail", "=", query.rail);
  if (query.status !== undefined) selection = selection.where("status", "=", query.status);
  if (query.environment !== undefined) selection = selection.where("environment", "=", query.environment);
  if (after) {
    selection = selection.where((eb) =>
      eb.or([
        eb("purchasedAt", "<", after.sort),
        eb.and([eb("purchasedAt", "=", after.sort), eb("id", "<", after.id)]),
      ]),
    );
  }

  const rows = await selection.execute();
  return toPage(
    rows.map((row) => PaymentsPurchaseRecord.parse(row)),
    limit,
    (purchase) => ({ sort: purchase.purchasedAt.getTime(), id: purchase.id }),
  );
}

/**
 * The entitlement model, newest first, filtered.
 *
 * Sorted on `createdAt` rather than `updatedAt`, and the difference matters on this table: the
 * projection re-derives every affected row on every purchase write, so `updatedAt` moves constantly for
 * reasons that have nothing to do with the grant. Ordering on it would shuffle rows under a reader. When
 * a key first appeared for an account never moves.
 *
 * A lapsed row is returned rather than filtered out. Whether it still grants is the projection's question
 * in `http/view.ts`, resolved against `expiresAt` at read time exactly as the hot path resolves it — and an
 * operator answering "when did their Pro end" needs the row and its date to survive the read.
 */
export async function listEntitlements(
  d1: D1Database,
  query: EntitlementsQuery = {},
): Promise<PaymentsPage<PaymentsEntitlement>> {
  const limit = pageLimit(query.limit);
  const after = resume(query.cursor);

  let selection = paymentsDatabase(d1)
    .selectFrom(PAYMENTS_ENTITLEMENTS_TABLE)
    .selectAll()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  if (query.userId !== undefined) selection = selection.where("userId", "=", query.userId);
  if (query.entitlement !== undefined) selection = selection.where("entitlement", "=", query.entitlement);
  if (after) {
    selection = selection.where((eb) =>
      eb.or([eb("createdAt", "<", after.sort), eb.and([eb("createdAt", "=", after.sort), eb("id", "<", after.id)])]),
    );
  }

  const rows = await selection.execute();
  return toPage(
    rows.map((row) => PaymentsEntitlement.parse(row)),
    limit,
    (entitlement) => ({ sort: entitlement.createdAt.getTime(), id: entitlement.id }),
  );
}

/**
 * Every entitlement one account holds, ordered by key.
 *
 * Unpaginated on purpose, and for the reason `@pithy-sh/ledger`'s `readAccounts` is: the table is keyed
 * `UNIQUE (userId, entitlement)`, so this returns at most one row per key the catalog sells plus
 * whatever has been comped by hand. A cursor over a list that short would be ceremony.
 *
 * An account holding nothing is an empty list, not a 404. An entitlement row appears with the first
 * purchase that grants one, so its absence is not a missing person — and answering 404 would make this
 * surface an existence oracle for user ids.
 */
export async function readEntitlements(d1: D1Database, userId: string): Promise<PaymentsEntitlement[]> {
  const rows = await paymentsDatabase(d1)
    .selectFrom(PAYMENTS_ENTITLEMENTS_TABLE)
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("entitlement", "asc")
    .execute();
  return rows.map((row) => PaymentsEntitlement.parse(row));
}

/** What {@link listReconcileRuns} accepts. */
export interface ReconcileRunsQuery {
  /** Restrict to the passes narrowed to one store. Never matches a pass that ran against every rail. */
  rail?: PaymentsRail;
  /** Restrict to one store environment. */
  environment?: PurchaseEnvironment;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/**
 * The reconciliation passes this deployment has run, newest first.
 *
 * Ordered on `startedAt`, not `finishedAt`, and the difference is the health question: a pass that began and
 * never ended is the failure worth seeing, and ordering on the timestamp it never wrote would hide it behind
 * every pass that did. The id is the tiebreak, on the index the migration creates for exactly this.
 *
 * `selectAll` here where the purchase read names its columns, and the reason is the point of the table: there
 * is no column to withhold. Every field is a count, a timestamp or an enum, so there is no bearer artifact to
 * leave behind and no personal identifier to mask — see `data/reconcileRun.ts`.
 */
export async function listReconcileRuns(
  d1: D1Database,
  query: ReconcileRunsQuery = {},
): Promise<PaymentsPage<PaymentsReconcileRun>> {
  const limit = pageLimit(query.limit);
  const after = resume(query.cursor);

  let selection = paymentsDatabase(d1)
    .selectFrom(PAYMENTS_RECONCILE_RUNS_TABLE)
    .selectAll()
    .orderBy("startedAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  if (query.rail !== undefined) selection = selection.where("rail", "=", query.rail);
  if (query.environment !== undefined) selection = selection.where("environment", "=", query.environment);
  if (after) {
    selection = selection.where((eb) =>
      eb.or([eb("startedAt", "<", after.sort), eb.and([eb("startedAt", "=", after.sort), eb("id", "<", after.id)])]),
    );
  }

  const rows = await selection.execute();
  return toPage(
    rows.map((row) => PaymentsReconcileRun.parse(row)),
    limit,
    (run) => ({ sort: run.startedAt.getTime(), id: run.id }),
  );
}
