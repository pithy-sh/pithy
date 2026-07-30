// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsProductType } from "../config/config";
import { PaymentsRail } from "./rail";
import { PurchaseStatus } from "./status";

/**
 * Which store environment a purchase happened in. Every purchase carries it, and it never widens: a
 * sandbox StoreKit transaction reaching production must not grant a real entitlement, and granting one is
 * the most common in-app-purchase security defect there is.
 */
export const PurchaseEnvironment = z
  .enum(["production", "sandbox"])
  .describe("The store environment a purchase happened in. A sandbox purchase never grants in production.");
export type PurchaseEnvironment = z.infer<typeof PurchaseEnvironment>;

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
    userId: z.string().describe("The owning Pithy user — the authenticated purchaser."),
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
    environment: PurchaseEnvironment.describe(
      "Which store environment the purchase happened in. Every purchase carries it: a sandbox StoreKit transaction reaching production must never grant a real entitlement.",
    ),
    purchasedAt: SQLiteDate.describe("When the store recorded the purchase."),
    expiresAt: SQLiteDate.nullable().describe(
      "When access lapses, or null for a purchase that never expires. Evaluated at read time as well as write time.",
    ),
    revokedAt: SQLiteDate.nullable().describe("When the purchase was refunded or revoked, or null."),
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
