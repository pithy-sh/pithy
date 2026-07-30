import { z } from "zod";

/**
 * The three payment rails, as one normalized name each. Nothing downstream of a rail's own module ever
 * branches on a store's vocabulary — Apple's `originalTransactionId`, Google's `purchaseToken`, and
 * Stripe's `subscription` all arrive as a `(rail, providerTransactionId)` pair, which is what lets one
 * projection serve three stores and one entitlement resolve across them.
 *
 * Adding a fourth rail (Amazon Appstore, Paddle) is a member here plus a provider module. Nothing else
 * in the package knows how many there are.
 */
export const PaymentsRail = z
  .enum(["apple", "google", "stripe"])
  .describe("Which store a transaction came from — Apple's App Store, Google Play, or Stripe.");
export type PaymentsRail = z.infer<typeof PaymentsRail>;

/** Every rail, in a stable order — for iterating the catalog's per-rail blocks and cross-checking them. */
export const PAYMENTS_RAILS: readonly PaymentsRail[] = PaymentsRail.options;
