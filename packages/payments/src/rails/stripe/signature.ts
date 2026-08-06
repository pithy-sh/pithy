// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  checkSignedWebhook,
  parseSignedWebhookHeader,
  type SignedWebhookHeader,
  type SignedWebhookRefusal,
} from "@pithy-sh/core/src/http/signedWebhook";
import { PaymentsVerificationFailedError } from "../../error/errors";

/**
 * Stripe's authenticity proof: an HMAC over the exact received bytes, dated, in one header.
 *
 * `Stripe-Signature: t=1768435200,v1=5257a8…` — the timestamp the delivery claims, then one hex HMAC-SHA256 per
 * active signing secret, each computed over `<timestamp>.<body>` and keyed with the endpoint's `whsec_…`.
 *
 * ## Why the scheme itself is not here
 *
 * It is `@pithy-sh/core`'s `signed-webhook` primitive, and this module is one of its callers. Stripe's format is
 * the one every other sender copied, so the kit implements it once — the freshness window in both directions, the
 * timestamp inside the signed payload, `crypto.subtle.verify` instead of a hand-written compare, every listed
 * signature tried, and a cap on how many. Each of those is a security property with a reason written down beside
 * it, and a second copy here would be a second set of reasons to keep in step: a parser fix landing in one and
 * not the other, with money on the side that missed it.
 *
 * What stays is what is Stripe's: the header name, the accepted scheme key, the tolerance, and the wording of a
 * refusal.
 *
 * ## Why the window matters to this rail in particular
 *
 * A captured `customer.subscription.updated` replayed months later is a state claim about a subscription that has
 * since lapsed. The projection's monotonic rule would correctly ignore it *only because* the stored event time is
 * newer — and relying on that would make the window a happy accident of another rule. Five minutes is Stripe's own
 * default and is generous against delivery latency and clock skew.
 *
 * Freshness is not uniqueness. Inside the window a captured delivery replays as often as it is sent, which is what
 * the guard's `UNIQUE (rail, providerEventId)` insert is for.
 *
 * ## What a refusal says
 *
 * `payments/verification_failed`, with the reason in `detail` and nothing else. Never the secret, never the body,
 * never the signature: `detail` reaches an operator's log, and the webhook guard maps this to
 * `payments/webhook_unverified` (401) before anything reaches the sender — a forger learns only that it failed.
 * That code is this rail's contract with its guard, which is why verification goes through the primitive's
 * reporting seam rather than its throwing one.
 */

/** The header Stripe puts its proof in. Lower case, because that is how Hono presents a header name. */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** How far a delivery's own timestamp may be from now. Stripe's default, and generous against clock skew. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The one signature scheme this build accepts. `v0` is Stripe's thin-event variant and proves nothing here. */
const ACCEPTED_SCHEME = "v1";

/** The timestamp key Stripe writes. The primitive's default, named here so this file states its own format. */
const TIMESTAMP_KEY = "t";

/**
 * A parsed `Stripe-Signature` header: when the delivery says it was signed, and with what. The primitive's
 * shape under this rail's name — the format is Stripe's, the parser is the kit's.
 */
export type StripeSignatureHeader = SignedWebhookHeader;

/** What verification needs beyond the bytes: the clock, and how wide the freshness window is. */
export interface VerifyStripeSignatureOptions {
  /** The clock. Injected so the replay window is deterministic in tests rather than wall-clock dependent. */
  now: Date;
  /** The freshness window, in seconds. Defaults to {@link STRIPE_SIGNATURE_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
}

/**
 * Read a `Stripe-Signature` header, or `undefined` when it is not one.
 *
 * Undefined rather than a throw for every unreadable shape, because the caller turns them all into one refusal:
 * distinguishing "no `t`" from "no `v1`" would describe our parser to a sender, and neither is actionable by
 * anyone but an operator reading the endpoint's configuration.
 *
 * Unknown schemes are dropped rather than refused. Stripe already sends `v0` alongside `v1` for thin Connect
 * events and may add another after this package shipped, and a delivery whose `v1` is good is authentic whatever
 * else it carries. A header carrying *only* unknown schemes has proved nothing, so it yields undefined.
 */
export function parseStripeSignatureHeader(header: string): StripeSignatureHeader | undefined {
  return parseSignedWebhookHeader(header, TIMESTAMP_KEY, ACCEPTED_SCHEME);
}

/**
 * Verify one delivery's `Stripe-Signature`. Resolves when Stripe signed these exact bytes inside the window, and
 * throws `payments/verification_failed` otherwise.
 */
export async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  options: VerifyStripeSignatureOptions,
): Promise<void> {
  const refusal = await checkSignedWebhook(body, header, {
    header: STRIPE_SIGNATURE_HEADER,
    timestampKey: TIMESTAMP_KEY,
    signatureKey: ACCEPTED_SCHEME,
    secret,
    toleranceSeconds: options.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS,
    now: options.now,
  });
  if (refusal === undefined) return;
  throw new PaymentsVerificationFailedError({ detail: stripeRefusal(refusal) });
}

/**
 * This rail's wording for the primitive's three refusals.
 *
 * Prefixed `Stripe:` because a payments Worker composes several rails and `detail` is what an operator reads to
 * find out which one refused. The strings say what failed and what to check, and nothing the delivery carried.
 */
function stripeRefusal(refusal: SignedWebhookRefusal): string {
  switch (refusal.reason) {
    case "unreadable":
      return "Stripe: the delivery carries no readable Stripe-Signature header with a t= timestamp and a v1= HMAC.";
    case "stale":
      return `Stripe: the delivery is dated ${refusal.skew}s from now, outside the ${refusal.tolerance}s tolerance. Check this Worker's clock, or a replayed delivery.`;
    case "unmatched":
      return "Stripe: no signature in the Stripe-Signature header matches these bytes under the configured signing secret. Check that the secret belongs to this endpoint and this environment.";
  }
}
