// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The five payment rails, as one normalized name each. Nothing downstream of a rail's own module ever
 * branches on a store's vocabulary — Apple's `originalTransactionId`, Google's `purchaseToken`, Stripe's
 * `subscription` and Paddle's `sub_…` all arrive as a `(rail, providerTransactionId)` pair, which is what
 * lets one projection serve five stores and one entitlement resolve across them.
 *
 * Adding a sixth rail (Amazon Appstore) is a member here plus a provider module. Nothing else in the
 * package knows how many there are.
 *
 * `lemonSqueezy` and `paddle` are the two **merchants of record**: each owns the tax registration, the VAT
 * thresholds, the invoices and the chargebacks, where the other three leave every one of those to the
 * adopter. That is a commercial difference rather than a technical one, and the only place it shows in
 * this package is that a refund can arrive with no local write preceding it — both issue them on their own.
 */
export const PaymentsRail = z
  .enum(["apple", "google", "stripe", "lemonSqueezy", "paddle"])
  .describe("Which store a transaction came from — Apple's App Store, Google Play, Stripe, Lemon Squeezy, or Paddle.");
export type PaymentsRail = z.infer<typeof PaymentsRail>;

/** Every rail, in a stable order — for iterating the catalog's per-rail blocks and cross-checking them. */
export const PAYMENTS_RAILS: readonly PaymentsRail[] = PaymentsRail.options;
