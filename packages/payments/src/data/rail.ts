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

/**
 * The rails that sell in a browser — and mint a billing portal, which is the same statement.
 *
 * **One name, because it is one question.** {@link CheckoutRail} declares `createCheckoutSession` and
 * `createPortalSession` together, so a rail cannot start a purchase on the web without also having a
 * portal to send that buyer back to. "Sells in a browser" and "mints a portal we can link to" are not
 * two lists that happen to match today; they are one list, held that way by an interface. Two names
 * would suggest a divergence the type system does not permit, and the next person would have to read
 * both to learn they are the same.
 *
 * The day a rail sells without a portal, `CheckoutRail` splits first — and `providers.test.ts`, which
 * compares this list against the rails that actually satisfy `isCheckoutRail`, goes red. That is the
 * moment a second name is earned, and it arrives with a failing test rather than a judgment call.
 *
 * **Enumerated rather than computed**, because nothing can compute it. A screen cannot construct a rail
 * provider to discover what it implements, and `PaymentsRail.options` cannot answer it either — Apple and
 * Google are rails and are not hosted. So it is a named subset with a gate over it, in both programs: this
 * one, and its DOM-safe mirror in `src/client/api.ts`, which stays a hand-written union because pulling
 * Zod into an adopter's browser program is what that file exists to avoid.
 *
 * Ordered, and the order is only used to make a refusal deterministic when a product sells on two rails
 * and the caller named neither. See `checkoutRailFor`.
 *
 * **Extracted from {@link PaymentsRail} rather than spelled again.** A member misspelled here is a
 * compile error rather than a rail that silently never matches, and the extraction is what lets the four
 * schemas that narrow to this subset share one definition instead of four literals.
 *
 * **One subset, not two.** These are also exactly the rails that mint discount codes today, and both
 * discount schemas narrow to this. A second constant would be a mirror with nothing to mirror. The day a
 * rail mints and does not sell, or sells and does not mint, `providers.test.ts` disagrees with itself and
 * the subset splits — with a failing test rather than a judgment call, which is the same bargain
 * `CheckoutRail` makes for selling and portal-minting.
 */
export const PaymentsHostedRail = PaymentsRail.extract(["stripe", "lemonSqueezy", "paddle"]).describe(
  "Which hosted rail — the three that sell in a browser, mint a portal, and mint a discount code.",
);
export type PaymentsHostedRail = z.infer<typeof PaymentsHostedRail>;

/**
 * The same three as a plain array, for the callers that iterate rather than parse.
 *
 * Derived from the schema rather than written beside it. Four request and response schemas wrote this
 * subset out by hand and Paddle reached none of them (#465), so a rail that sold, minted portals and minted
 * discount codes was a 400 at every point a caller had to name it. One list, one edit — and
 * `providers.test.ts` holds it to the rails that satisfy the interfaces at runtime, in both directions.
 */
export const PAYMENTS_HOSTED_RAILS: readonly PaymentsRail[] = PaymentsHostedRail.options;
