// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { encodeSubjectReference } from "../../data/subject";
import { PaymentsDiscountInvalidError, PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { CheckoutHandoff, CheckoutSessionInput } from "../contract";
import { type StripeFormObject, type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";
import { STRIPE_METADATA_ACCOUNT_REFERENCE, STRIPE_METADATA_PRICE } from "./objects";

/**
 * Hosted Checkout, and nothing else.
 *
 * Stripe presents the payment page, handles the card, and owns SCA, tax, and every regulatory surface that comes
 * with taking money. Pithy sends a browser there and hears the outcome on a webhook. There is no Payment Element
 * here and no card fields, and nothing computes proration or tax — that half of issue #79's locked decision 2
 * still stands, and it is the difference between a backend kit and a payments processor.
 *
 * **The other half was amended on 2026-08-28: the kit may now *invoke* a plan change**, passing the store's own
 * figures through unmodified — see {@link SubscriptionRail} in `rails/contract.ts` for the line between asking a
 * store what a change costs and answering that question ourselves. **Stripe does not implement it.** Paddle is
 * the only rail that does, so a Stripe subscriber changes plan in the Billing Portal exactly as before, and
 * `providers.test.ts` is where that stops being a claim. The amendment permits the seam; it does not oblige
 * every rail to have one.
 *
 * ## What this call puts on the session, and why each of them
 *
 * **`client_reference_id`, the resolved subject as `encodeSubjectReference` writes it.** A Stripe purchase is only
 * ever heard about through a webhook, and that webhook carries `cus_…` and no Pithy holder. This is the pairing,
 * and it is the reason the `/checkout` route resolves the subject through the configured seam and never from a
 * request body: a client that could name it could attach its purchase to somebody else's account — or, worse,
 * attach somebody else's purchase to its own.
 *
 * **Both halves of the subject, always — `user:ada`, never `ada`.** Nothing keeps an organization id from
 * equalling some user's, so an id alone paired with a kind at the far end would eventually grant one holder's
 * subscription to the other. The bare id is also what this rail stamped before subjects existed, and
 * `decodeSubjectReference` refuses it on purpose: a lenient read would attribute a stranger's renewal to whoever
 * holds that id. So a stamp that is not the encoding orphans its purchase, which is the safe direction and the
 * reason nothing here builds the string by hand.
 *
 * **The same reference in `metadata`, and again in `subscription_data[metadata]`.** Stripe copies subscription
 * metadata onto the subscription it creates, so every later `customer.subscription.*` event carries the pairing
 * too. Without that, Stripe delivering `customer.subscription.created` before `checkout.session.completed` — which
 * it may — would leave the first renewal notification with nobody to project it against.
 *
 * **The price id in `metadata`.** A Checkout Session's `line_items` are expandable, and a webhook payload never
 * expands anything, so the price a session was created for is otherwise unknowable from its own notification.
 *
 * **The customer, when the buyer already has one.** One buyer, one Stripe customer. Left out, every checkout mints
 * a fresh customer and a buyer's second purchase would be invisible from the billing portal their first one made.
 * On a first one-time purchase there is no customer to reuse, so Stripe is asked to create one — payment mode
 * makes none by default, and a one-time buyer would otherwise never enter the account map at all.
 */

/** What creating a session needs beyond the input: the API key, and the transport to reach Stripe through. */
export interface StripeCheckoutOptions {
  /** Stripe's credential block. Only `secretKey` is used here. */
  credentials: PaymentsStripeCredentials;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: StripeHttpFetch;
}

/** A created hosted session, narrowed to the one field a browser needs. */
const StripeHostedSession = z
  .object({
    id: z.string().min(1).describe("The session id. Returned to the browser in the success URL's template token."),
    url: z
      .string()
      .min(1)
      .describe("The hosted page to send the browser to. Absent only for an embedded session, which this is not."),
  })
  .loose()
  .describe("A hosted Stripe session — Checkout or Billing Portal — as much of it as a redirect needs.");

/** Create a hosted Checkout Session for one product, and return where to send the browser. */
export async function createStripeCheckoutSession(
  input: CheckoutSessionInput,
  options: StripeCheckoutOptions,
): Promise<CheckoutHandoff> {
  // Resolved before the session is created, so an unusable code is refused as a *code* rather than
  // surfacing later as a failed checkout. See {@link resolvePromotionCode}.
  const promotionCodeId =
    input.discountCode === undefined ? undefined : await resolvePromotionCode(input.discountCode, options);

  // One encoding, from the one function. See `data/subject.ts` — the value goes out here and comes back
  // through `decodeSubjectReference` on the webhook, and a second spelling anywhere breaks that loop.
  const accountReference = encodeSubjectReference(input.subject);
  const reference = { [STRIPE_METADATA_ACCOUNT_REFERENCE]: accountReference };
  const metadata = { ...reference, [STRIPE_METADATA_PRICE]: input.providerProductId };

  const form: StripeFormObject = {
    mode: input.subscription ? "subscription" : "payment",
    line_items: [{ price: input.providerProductId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // The resolved subject, both halves. Never a value from a request body — see the module doc.
    client_reference_id: accountReference,
    metadata,
    customer: input.providerAccountId ?? undefined,
    // Stripe refuses `customer` and `customer_creation` together, and there is nothing to create when the buyer
    // already has one.
    customer_creation: input.subscription || input.providerAccountId ? undefined : "always",
    // Each is legal only in its own mode, so they are mutually exclusive rather than both set.
    subscription_data: input.subscription ? { metadata: reference } : undefined,
    payment_intent_data: input.subscription ? undefined : { metadata },
    // The code, handed over exactly as the caller typed it. Stripe resolves it to a promotion code and
    // computes the price; nothing here validates it, looks it up, or multiplies anything — the provider is
    // the authority on what is owed, and a second calculation would be a second answer to the one question a
    // customer checks against their statement.
    //
    // `allow_promotion_codes` is deliberately NOT set alongside it: Stripe refuses a session carrying both,
    // and the two are different products anyway — one applies a code this project chose, the other puts a
    // box on Stripe's page for the customer to fill in.
    discounts: promotionCodeId === undefined ? undefined : [{ promotion_code: promotionCodeId }],
  };

  const created = await stripeJson(options.transport ?? stripeHttpFetch, "/checkout/sessions", {
    what: "a Checkout Session",
    secretKey: options.credentials.secretKey,
    form,
  });

  return hostedSession(created, "a Checkout Session");
}

/** Read a created session's URL, or refuse. Shared with the Billing Portal, which answers the same shape. */
export function hostedSession(created: unknown, what: string): CheckoutHandoff & { kind: "redirect" } {
  const parsed = StripeHostedSession.safeParse(created);
  if (!parsed.success) {
    // Stripe created something and did not tell us where to send the browser. Nothing here can recover from that,
    // and a redirect to an absent URL is worse than a refusal the caller can retry.
    throw new PaymentsProviderUnavailableError({
      detail: `Stripe created ${what} with no URL to redirect to.`,
    });
  }
  return { kind: "redirect", url: parsed.data.url };
}

/**
 * Turn the code a customer typed into the promotion code id Stripe's session wants.
 *
 * Stripe's `discounts[].promotion_code` takes a `promo_…` id, not the customer-facing string, so this lookup
 * is unavoidable. It is also where the code's validity is learned, and learning it *here* is what makes the
 * refusal a good one: an unknown, expired or exhausted code is refused before a session exists, as
 * `payments/discount_invalid` naming the code, rather than becoming a checkout that fails in front of the
 * customer with nothing to say but that something went wrong.
 *
 * `active: true` is part of the query rather than a check afterwards, so an expired or exhausted code simply
 * does not come back. Stripe decides what active means — Pithy does not read `expires_at` or count
 * redemptions itself, for the same reason it does not compute the discounted price.
 */
async function resolvePromotionCode(code: string, options: StripeCheckoutOptions): Promise<string> {
  const found = await stripeJson(options.transport ?? stripeHttpFetch, "/promotion_codes", {
    what: `the discount code ${code}`,
    secretKey: options.credentials.secretKey,
    query: { code, active: true, limit: 1 },
  });

  const parsed = StripePromotionCodes.safeParse(found);
  const promotion = parsed.success ? parsed.data.data[0] : undefined;
  if (promotion === undefined) {
    throw new PaymentsDiscountInvalidError({
      message: `"${code}" is not a discount code we can accept.`,
      detail: `Stripe has no active promotion code matching "${code}" — unknown, expired, or fully redeemed.`,
    });
  }
  return promotion.id;
}

/** Stripe's promotion-code list, narrowed to the id a session needs. */
const StripePromotionCodes = z
  .object({ data: z.array(z.object({ id: z.string().min(1) }).loose()) })
  .loose()
  .describe("A Stripe promotion-code list response.");
