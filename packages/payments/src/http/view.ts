// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsPurchaseRecord } from "../admin/read";
import type { PaymentsConfig } from "../config/config";
import type { PaymentsEntitlement } from "../data/entitlement";
import type { PaymentsReconcileRun } from "../data/reconcileRun";
import type { PurchaseProjection } from "../projection/writer";
import type {
  PaymentsAdminCatalogResponse,
  PaymentsAdminEntitlementView,
  PaymentsAdminPurchaseView,
  PaymentsAdminReconcileRunView,
  PaymentsEntitlementView,
  PaymentsPurchaseView,
} from "./responses";

/**
 * What a client is shown. Nothing in this package ever returns a raw row.
 *
 * ## What payments holds, and therefore what this can leak
 *
 * There is exactly one column across all four tables that is personal data in the ordinary sense, and it
 * is `pithy_payments_purchases.payload` — the verified provider response, retained as received. On Apple
 * and Google it is a bearer artifact. On Stripe it is a document carrying the buyer's email address,
 * their name, and their billing details. So the question `@pithy-sh/email` answers by masking a
 * recipient has a different answer here, and a stronger one: **the payload is not masked, it is not
 * projected, and the management queries do not select it** (`admin/read.ts`). A field that never reaches
 * the Worker's memory cannot reach a response.
 *
 * Everything else payments stores is an identifier or a fact about a transaction. The only identity is the
 * **subject pair**, `(subjectType, subjectId)` — opaque ids the adopter's auth capability and its own
 * membership model issued, and already the address a management client must name to ask about a holder.
 * Turning either into a name or an address needs `auth:users:read`, which is a separate grant against a
 * separate capability.
 *
 * The two halves are projected together or not at all. A view carrying `subjectId` alone would read as a
 * person whenever an adopter's organization ids and user ids met on a value, so the management
 * projections below copy the pair off one row and never assemble one from config and a column.
 *
 * ## The two audiences, and why their projections differ
 *
 * {@link purchaseView} and {@link entitlementView} answer the adopter's own app, over `requireAuth()`,
 * always about the caller's own rows. {@link adminPurchaseView} and {@link adminEntitlementView} answer a
 * management client, over the control-plane seam, about everybody's. The management views are wider by
 * the facts an operator cannot work without — who owns it, what was charged, whether a human granted it,
 * and which purchase is the reason — and narrower by `outcome`, which describes a write and has no
 * meaning on a read. The client views name no subject at all: the caller is the holder, and a body
 * echoing that back would be the protocol offering a field a client could one day fill in.
 *
 * ## The field lists live in `responses.ts`
 *
 * Every return type below is `z.output` of the Zod object there, so there is one declaration of what a
 * client receives rather than an interface here and a hand-written mirror of it in every management
 * client. A field added to one and not the other does not compile.
 *
 * Dates render as ISO-8601 strings. They are ms-epoch integers in SQLite and `Date`s in TypeScript, and
 * a JSON number would leave every client guessing which unit it was in.
 */

/**
 * A purchase as its own buyer may see it — the projection a write hands back.
 *
 * Deliberately not the row: the stored `payload` is the whole provider response, and a client has no use
 * for its own receipt read back to it.
 */
export function purchaseView(projection: PurchaseProjection): PaymentsPurchaseView {
  const { purchase } = projection;
  return {
    id: purchase.id,
    rail: purchase.rail,
    productId: purchase.productId,
    type: purchase.type,
    status: purchase.status,
    environment: purchase.environment,
    purchasedAt: purchase.purchasedAt.toISOString(),
    expiresAt: purchase.expiresAt?.toISOString() ?? null,
    resumesAt: purchase.resumesAt?.toISOString() ?? null,
    outcome: projection.outcome,
  };
}

/** An entitlement as its holder reads it: the key, whether it grants right now, and when it lapses. */
export function entitlementView(entitlement: {
  key: string;
  active: boolean;
  expiresAt: Date | null;
}): PaymentsEntitlementView {
  return { key: entitlement.key, granted: entitlement.active, expiresAt: entitlement.expiresAt?.toISOString() ?? null };
}

/**
 * Project the catalog for a management client — what this project sells, and nothing about who bought it.
 *
 * The one projection in this file built from **config** rather than from a row, and that is the whole
 * reason it is safe: the value it reads is `pithy.config.ts`, so a credential, a stored payload, and a
 * customer's identity are not merely withheld here, they are not in the input. What *is* in the input and
 * must not cross is the commercial half of the catalog — every rail's SKU, the Stripe price id, and the
 * `grants` block's currency and amount — and the four fields below are the whole of what does.
 *
 * `{ enabled: false }` when the project defines nothing, matching `clientProjection`'s answer for the same
 * state and for the same reason: a client branches on `enabled`, so "composed with nothing to sell" must
 * read as its own state rather than as an empty list that looks like a failed load.
 */
export function adminCatalogView(config: PaymentsConfig): PaymentsAdminCatalogResponse {
  const products = Object.entries(config.products).map(([id, product]) => ({
    id,
    type: product.type,
    name: product.name,
    entitlements: [...product.entitlements],
  }));
  const manualEntitlements = [...config.manualEntitlements];
  if (products.length === 0 && manualEntitlements.length === 0) return { enabled: false };
  // Catalog order, not sorted: the order an adopter wrote their products in is the order a list should
  // show them, exactly as the client projection argues.
  return { enabled: true, products, manualEntitlements };
}

/** Project one purchase for a management client. The record's columns, verbatim, with dates as strings. */
export function adminPurchaseView(purchase: PaymentsPurchaseRecord): PaymentsAdminPurchaseView {
  return {
    id: purchase.id,
    subjectType: purchase.subjectType,
    subjectId: purchase.subjectId,
    rail: purchase.rail,
    providerTransactionId: purchase.providerTransactionId,
    originalTransactionId: purchase.originalTransactionId,
    productId: purchase.productId,
    type: purchase.type,
    status: purchase.status,
    environment: purchase.environment,
    amountMinor: purchase.amountMinor,
    currency: purchase.currency,
    purchasedAt: purchase.purchasedAt.toISOString(),
    expiresAt: purchase.expiresAt?.toISOString() ?? null,
    revokedAt: purchase.revokedAt?.toISOString() ?? null,
    resumesAt: purchase.resumesAt?.toISOString() ?? null,
    updatedAt: purchase.updatedAt.toISOString(),
  };
}

/**
 * Project one entitlement row for a management client, resolving `granted` against `now`.
 *
 * The stored `active` flag is what the projection last wrote; `expiresAt` is the truth. A subscription
 * can lapse with no notification arriving at all, so a row can say `active` with an expiry in the past —
 * and the gate the adopter's own app calls applies the timestamp on every request. A dashboard that
 * rendered the flag would disagree with that gate, and the customer would believe the dashboard.
 */
export function adminEntitlementView(row: PaymentsEntitlement, now: Date): PaymentsAdminEntitlementView {
  const lapsed = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  return {
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    key: row.entitlement,
    granted: row.active && !lapsed,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    manual: row.manual,
    source: row.sourcePurchaseId,
  };
}

/**
 * Project one reconciliation run for a management client.
 *
 * The row's columns verbatim, with the dates as ISO strings and `createdAt` left behind — when the row was
 * *written* is bookkeeping, and `finishedAt` already answers the only version of that question an operator
 * asks. Nothing is withheld beyond it, because there is nothing to withhold: the table has no column a
 * store's response could reach.
 */
export function adminReconcileRunView(run: PaymentsReconcileRun): PaymentsAdminReconcileRunView {
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    environment: run.environment,
    rail: run.rail,
    pages: run.pages,
    scanned: run.scanned,
    unchanged: run.unchanged,
    drifted: run.drifted,
    superseded: run.superseded,
    skipped: run.skipped,
    failed: run.failed,
    truncated: run.truncated,
    dryRun: run.dryRun,
  };
}
