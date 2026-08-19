// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsProductType } from "../config/config";
import { PaymentsRail } from "./rail";
import { PurchaseStatus } from "./status";
import { PaymentsSubject } from "./subject";

/**
 * Which store environment a purchase happened in. Every purchase carries it, and it never widens: a
 * sandbox StoreKit transaction reaching production must not grant a real entitlement, and granting one is
 * the most common in-app-purchase security defect there is.
 */
export const PurchaseEnvironment = z
  .enum(["production", "sandbox"])
  .describe("The store environment a purchase happened in. A sandbox purchase never grants in production.");
export type PurchaseEnvironment = z.infer<typeof PurchaseEnvironment>;

/**
 * What a purchase row *is* — the thing that grants access, or the thing that took the money.
 *
 * On three of the four rails these are one object and `charge` is the only value ever written: an Apple
 * renewal, a Play renewal and a Stripe invoice each carry both the money and the subscription's state, so
 * one row does both jobs and nothing needs distinguishing.
 *
 * Lemon Squeezy splits them, and splits them at the source. Its `subscription_*` webhooks carry a
 * subscription object with the status and the renewal date and no charge; its `subscription_payment_*`
 * webhooks carry an invoice with the money and no subscription state. Neither names the other's key —
 * an LS subscription has no latest-invoice pointer — so collapsing them onto one row would mean inventing
 * the missing pointer and stamping two different clocks into one monotonic watermark, which is exactly
 * the ordering defect `providerEventAt` exists to prevent.
 *
 * So that rail writes two rows, and this field says which is which. **`state` never credits a ledger.**
 * A `grants` clause fires once per paid provider transaction, and a subscription's state is not a
 * transaction — without this discriminator a live subscription's honest `active` status passes
 * `purchaseIsPaid` and every subscriber is credited once more than they paid for.
 */
export const PurchaseRole = z
  .enum(["charge", "state"])
  .describe(
    "Whether this row records money moving (`charge`) or a subscription's standing (`state`). Only `charge` rows fulfill a `grants` clause. Every rail but Lemon Squeezy writes `charge` for everything.",
  );
export type PurchaseRole = z.infer<typeof PurchaseRole>;

/** The raw verified provider payload — an object, whatever the rail's own shape. Retained as received. */
const ProviderPayload = z
  .record(z.string(), z.unknown())
  .describe("The rail's verified response, as received. Shapes differ per rail, so only the envelope is fixed.");

/**
 * One provider transaction, as the projection of provider truth — the row in `pithy_payments_purchases`.
 *
 * `UNIQUE (rail, providerTransactionId)` is the idempotency guard all three write paths rely on: a client
 * submission, a webhook, and a reconciliation pass produce the identical row, so a dropped client call
 * costs nothing and a replayed webhook changes nothing.
 *
 * The owner is a **subject pair**, not a user id: the buyer is whoever the project bills, which under
 * organization billing is the organization rather than the person who happened to click. Both columns are
 * written together, and `data/subject.ts` states why either alone is ambiguous.
 *
 * `providerEventAt` is what makes the write monotonic. Providers do not guarantee delivery order, so an
 * `expired` notification can arrive after the `renewed` that superseded it. Last-write-wins would
 * silently revoke a paying subscriber, so the writer ignores any event staler than the row it is
 * updating.
 */
export const PaymentsPurchase = z
  .object({
    id: z
      .string()
      .describe(
        "The purchase's UUID. Text rather than an autoincrement integer because these surface in API responses, and sequential ids would leak order volume.",
      ),
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Whether `subjectId` names a user or an organization. Half the owner — the id alone is ambiguous, so the two columns travel together.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject that owns the purchase — the authenticated buyer, or the organization they bought for.",
    ),
    rail: PaymentsRail.describe("Which store this transaction came from."),
    providerTransactionId: z
      .string()
      .describe("The rail's own transaction id. `UNIQUE (rail, providerTransactionId)` — the idempotency anchor."),
    productId: z.string().describe("The logical catalog product id, from `products` in pithy.config.ts."),
    providerProductId: z.string().describe("The rail's own SKU or price id, exactly as the provider presented it."),
    type: PaymentsProductType.describe(
      "The product type, copied from the catalog at projection time so a later config edit cannot rewrite history.",
    ),
    status: PurchaseStatus.describe("The normalized status. Nothing downstream ever sees a rail-specific state."),
    role: PurchaseRole.default("charge").describe(
      "Whether this row is the money or the subscription's standing. Defaults to `charge`, which is what every rail but Lemon Squeezy writes for every row.",
    ),
    environment: PurchaseEnvironment.describe(
      "Which store environment the purchase happened in. Every purchase carries it: a sandbox StoreKit transaction reaching production must never grant a real entitlement.",
    ),
    purchasedAt: SQLiteDate.describe("When the store recorded the purchase."),
    expiresAt: SQLiteDate.nullable().describe(
      "When access lapses, or null for a purchase that never expires. Evaluated at read time as well as write time.",
    ),
    revokedAt: SQLiteDate.nullable().describe("When the purchase was refunded or revoked, or null."),
    resumesAt: SQLiteDate.nullable().describe(
      "When a paused subscription comes back, as the provider stated it — never computed. Null on a paused row means the provider said none, which is an indefinite pause; null everywhere else means the purchase is not paused, and the table's check constraint is what keeps those two apart. See `data/pause.ts`.",
    ),
    originalTransactionId: z
      .string()
      .nullable()
      .describe("Chains renewals back to the transaction that started the subscription. Null for a one-time purchase."),
    amountMinor: z
      .number()
      .int()
      .nullable()
      .describe(
        "The amount charged, in the currency's minor unit — an integer, never a float. Nullable: not every rail reports it on every event.",
      ),
    currency: z
      .string()
      .nullable()
      .describe("The ISO currency the amount is in, or null when the rail did not report one."),
    providerEventAt: SQLiteDate.describe(
      "The provider's own timestamp for the event that produced this row. The monotonic write rule compares against it, so out-of-order delivery cannot revoke a live subscription.",
    ),
    payload: sqliteJson(ProviderPayload).describe(
      "The raw verified provider payload, Zod-validated on write and on read. Retained for reconciliation and audit.",
    ),
    createdAt: SQLiteDate.describe("When this row was first projected."),
    updatedAt: SQLiteDate.describe("When this row was last projected."),
  })
  .describe("One verified provider transaction — the row in `pithy_payments_purchases`.");
export type PaymentsPurchase = z.output<typeof PaymentsPurchase>;
export type PaymentsPurchaseRow = z.input<typeof PaymentsPurchase>;
