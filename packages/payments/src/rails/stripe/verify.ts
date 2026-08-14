// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import { noteText, type VerifiedPurchase } from "../contract";
import { type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";
import { mapStripeSession, StripeCheckoutSession } from "./objects";

/**
 * The client-submission path for Stripe: the Checkout Session id a returning browser carries.
 *
 * Hosted Checkout sends the buyer back to `success_url`, and Stripe substitutes the session id into it wherever
 * the adopter put `{CHECKOUT_SESSION_ID}`. Posting that id to `/payments/purchases` is the Stripe equivalent of
 * submitting a StoreKit transaction: **nothing about correctness rests on it**, because the webhook produces the
 * identical row through the same idempotent writer. What it buys is immediacy — the buyer sees their entitlement
 * when they land on the thank-you page rather than when Stripe gets round to delivering.
 *
 * ## Why a session id is safe to accept, and where it stops
 *
 * A session id is not a bearer artifact the way a receipt is: it is not a secret, and it is not proof of anything
 * on its own. What makes this path safe is that the session **names its own purchaser**. Pithy set
 * `client_reference_id` from the authenticated caller when it created the session, and that value comes back on
 * the retrieve — so a caller submitting somebody else's session id is refused by the route, before the projection
 * writer's owner check ever has to catch it. The shape is checked here first, so an Apple receipt posted to the
 * Stripe rail costs no round-trip.
 *
 * ## Why all three expansions
 *
 * `line_items` because a session's price is otherwise unknowable, and Stripe's own answer is better than the copy
 * this deployment stamped into metadata. `subscription` because a subscription-mode session carries only an id,
 * and expanding it turns one retrieve into the whole state — the same row the subscription's own webhook will
 * later produce. And **`payment_intent.latest_charge` because a completed session is refund-blind**: its
 * `payment_status` reads `paid` for ever, so without the charge this path would answer `active` on a purchase
 * Stripe has already given back. The charge is the only object here that knows what became of the money.
 */

/** A Checkout Session id. Stripe's are `cs_` plus base62; the bound is generous and the shape is exact. */
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/;

/** What verifying a submitted session needs: the API key, a clock, and the transport. */
export interface StripeVerifyOptions {
  /** Stripe's credential block. Only `secretKey` is used here. */
  credentials: PaymentsStripeCredentials;
  /** The clock. A retrieve is a read of the state now, so this is the honest provider event time. */
  now: Date;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: StripeHttpFetch;
}

/** Verify a client-submitted Checkout Session and normalize it. The caller binds the authenticated purchaser. */
export async function verifyStripeSession(receipt: string, options: StripeVerifyOptions): Promise<VerifiedPurchase> {
  if (!SESSION_ID.test(receipt)) {
    // Never echo the submitted value: it is caller-supplied and lands in an operator's log.
    throw new PaymentsInvalidReceiptError({
      detail: "Stripe: the submitted value is not a Checkout Session id. Submit the `cs_…` id from your success URL.",
    });
  }

  const retrieved = await stripeJson(
    options.transport ?? stripeHttpFetch,
    `/checkout/sessions/${encodeURIComponent(receipt)}`,
    {
      what: "the Checkout Session",
      secretKey: options.credentials.secretKey,
      query: { expand: ["subscription", "line_items", "payment_intent.latest_charge"] },
      absentOn404: true,
    },
  );

  if (retrieved === undefined) {
    throw new PaymentsVerificationFailedError({
      detail: "Stripe: no Checkout Session exists under the submitted id in this environment.",
    });
  }

  const parsed = StripeCheckoutSession.safeParse(retrieved);
  if (!parsed.success) {
    throw new PaymentsVerificationFailedError({
      detail: `Stripe: the answer is not a Checkout Session — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ")}.`,
    });
  }

  // A retrieve is not an event: Stripe timed it with nothing, so `eventAt` is null and the mapping dates what it
  // found. A live subscription it read is dated now; a frozen one-time snapshot is dated by Stripe's own clock,
  // which is what stops a re-posted session id outranking the refund that followed it. See `objects.ts`.
  const mapped = mapStripeSession(parsed.data, { eventAt: null, now: options.now });
  if (mapped.event === null) {
    // An abandoned session, one still awaiting a bank debit, or one whose subscription does not exist yet. The
    // buyer is told rather than left with a 200 and no entitlement.
    throw new PaymentsVerificationFailedError({
      detail:
        noteText(mapped.note) ??
        "Stripe: that checkout has not completed into a purchase yet. It will project from the webhook when it does.",
    });
  }

  return {
    event: mapped.event,
    providerAccountId: mapped.providerAccountId,
    accountReference: mapped.accountReference,
  };
}
