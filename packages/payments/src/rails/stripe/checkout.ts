// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { CheckoutSessionInput, HostedSession } from "../contract";
import { type StripeFormObject, type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";
import { STRIPE_METADATA_ACCOUNT_REFERENCE, STRIPE_METADATA_PRICE } from "./objects";

/**
 * Hosted Checkout, and nothing else.
 *
 * Stripe presents the payment page, handles the card, and owns SCA, tax, and every regulatory surface that comes
 * with taking money. Pithy sends a browser there and hears the outcome on a webhook. There is no Payment Element
 * here, no card fields, no plan-change logic and no proration — that is issue #79's locked decision 2, and it is
 * also the difference between a backend kit and a payments processor.
 *
 * ## What this call puts on the session, and why each of them
 *
 * **`client_reference_id`, from the authenticated caller.** A Stripe purchase is only ever heard about through a
 * webhook, and that webhook carries `cus_…` and no Pithy user. This is the pairing, and it is the reason the
 * `/checkout` route takes the purchaser from `c.var.auth` and never from a request body: a client that could name
 * it could attach its purchase to somebody else's account — or, worse, attach somebody else's purchase to its own.
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
): Promise<HostedSession> {
  const reference = { [STRIPE_METADATA_ACCOUNT_REFERENCE]: input.userId };
  const metadata = { ...reference, [STRIPE_METADATA_PRICE]: input.providerProductId };

  const form: StripeFormObject = {
    mode: input.subscription ? "subscription" : "payment",
    line_items: [{ price: input.providerProductId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // The authenticated purchaser. Never a value from a request body — see the module doc.
    client_reference_id: input.userId,
    metadata,
    customer: input.providerAccountId ?? undefined,
    // Stripe refuses `customer` and `customer_creation` together, and there is nothing to create when the buyer
    // already has one.
    customer_creation: input.subscription || input.providerAccountId ? undefined : "always",
    // Each is legal only in its own mode, so they are mutually exclusive rather than both set.
    subscription_data: input.subscription ? { metadata: reference } : undefined,
    payment_intent_data: input.subscription ? undefined : { metadata },
  };

  const created = await stripeJson(options.transport ?? stripeHttpFetch, "/checkout/sessions", {
    what: "a Checkout Session",
    secretKey: options.credentials.secretKey,
    form,
  });

  return hostedSession(created, "a Checkout Session");
}

/** Read a created session's URL, or refuse. Shared with the Billing Portal, which answers the same shape. */
export function hostedSession(created: unknown, what: string): HostedSession {
  const parsed = StripeHostedSession.safeParse(created);
  if (!parsed.success) {
    // Stripe created something and did not tell us where to send the browser. Nothing here can recover from that,
    // and a redirect to an absent URL is worse than a refusal the caller can retry.
    throw new PaymentsProviderUnavailableError({
      detail: `Stripe created ${what} with no URL to redirect to.`,
    });
  }
  return { url: parsed.data.url };
}
