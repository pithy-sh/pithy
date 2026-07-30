// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The normalized purchase status set. Each rail's events map into these nine, so nothing downstream of
 * a rail module ever sees `DID_RENEW`, `SUBSCRIPTION_ON_HOLD`, or `invoice.payment_failed`.
 *
 * The set is deliberately about *state*, not about the event that produced it: a projection is keyed on a
 * transaction, and a transaction has one current state however many notifications described it.
 *
 * ## Two endings, and the difference between them is the money
 *
 * **`expired` is a period we were paid for, ended.** A subscription that ran its course, a Stripe
 * subscription Stripe closed, an Apple period past its `expiresDate`. It grants no access — the period is
 * over — but it **credits**, because the invoice behind it cleared.
 *
 * **`never_paid` is a purchase that terminated before any money moved.** A delayed-payment checkout whose
 * bank debit bounced, a Stripe subscription abandoned at `incomplete_expired`, a Play deferred purchase
 * cancelled before payment. It grants nothing and credits nothing, and no clawback ever follows one, because
 * there is no payment to reverse. Leaning on `expired` for these is how a coin pack gets handed out for money
 * that never arrived — see `UNPAID_STATUSES` in `grants/apply.ts`. Apple maps nothing here: StoreKit issues
 * no transaction until the money moves.
 */
export const PurchaseStatus = z
  .enum(["active", "in_grace", "on_hold", "canceled", "expired", "never_paid", "refunded", "revoked", "paused"])
  .describe(
    "The normalized purchase status. `active` is paid and current; `in_grace` is a failed renewal still inside the retry window; `on_hold` is a failed renewal past it; `canceled` is auto-renew turned off with the paid period still running; `expired` is a period we were paid for that has lapsed; `never_paid` terminated before any money cleared, so it credits nothing; `refunded` and `revoked` were taken back; `paused` is a subscription the user suspended.",
  );
export type PurchaseStatus = z.infer<typeof PurchaseStatus>;

/**
 * The statuses a purchase can grant access from — the candidate set the projection's SQL filters on
 * before the expiry check. `in_grace`'s membership is then narrowed per project by
 * {@link statusGrantsAccess}, so this set and that predicate must stay in step; a test asserts both.
 *
 * **`canceled` still grants**, and it is the member most often got wrong. A user who turns off
 * auto-renew has not lost access — they have declined the *next* period. The period they paid for runs
 * to its end, and `expiresAt` is what ends it.
 */
export const ACCESS_GRANTING_STATUSES: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>([
  "active",
  "in_grace",
  "canceled",
]);

/**
 * Whether a purchase in this status grants its entitlements, given the project's grace policy. The
 * expiry check is separate and applied alongside it — a status says whether the purchase is still
 * standing, `expiresAt` says whether the period it paid for is over.
 *
 * `in_grace` granting access is the point of grace: a failed card should not lock a paying subscriber
 * out mid-period. It is a described config flag rather than hardcoded policy because an app that sells
 * something expensive may reasonably decide otherwise. `on_hold` never grants — by then the retry window
 * is exhausted and the renewal has genuinely failed. `never_paid` never grants either, and never can: it
 * says no money ever moved.
 */
export function statusGrantsAccess(status: PurchaseStatus, graceGrantsAccess: boolean): boolean {
  if (status === "in_grace") return graceGrantsAccess;
  return ACCESS_GRANTING_STATUSES.has(status);
}

/** The statuses that grant access under this project's grace policy — what the projection's SQL filters on. */
export function grantingStatuses(graceGrantsAccess: boolean): PurchaseStatus[] {
  return [...ACCESS_GRANTING_STATUSES].filter((status) => statusGrantsAccess(status, graceGrantsAccess));
}
