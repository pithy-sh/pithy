// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PortalHandoff, PortalSessionInput } from "../contract";
import { stripeHttpFetch, stripeJson } from "./api";
import { hostedSession, type StripeCheckoutOptions } from "./checkout";

/**
 * The Billing Portal: Stripe's own page for managing a subscription, and the whole of Pithy's plan-management
 * surface.
 *
 * Two parameters go out — which customer, and where to send them afterwards — and that is deliberate. Everything
 * a subscriber may do in the portal (cancel, switch plan, update a card, download invoices) is configured in
 * Stripe's dashboard, per environment, by the adopter. A parameter here that decided any of it would be Pithy
 * owning plan changes and proration, which locked decision 2 says it never does. It also means store rules and
 * dunning copy stay Stripe's to keep current rather than ours to age.
 *
 * The customer is resolved from the provider-account map, never from a request. That map is written from
 * `client_reference_id` when a checkout completes, so the caller can only ever reach their own billing.
 *
 * The failure every adopter meets once is a Billing Portal with no configuration: Stripe answers 400 until one is
 * created in the dashboard. `api.ts` maps that to `payments/rail_not_configured`, which reads to a caller as "not
 * available here" — true — and carries Stripe's own sentence in `detail` for whoever can fix it.
 */

/** Create a hosted Billing Portal session for one customer, and return where to send the browser. */
export async function createStripePortalSession(
  input: PortalSessionInput,
  options: StripeCheckoutOptions,
): Promise<PortalHandoff> {
  const created = await stripeJson(options.transport ?? stripeHttpFetch, "/billing_portal/sessions", {
    what: "a Billing Portal session",
    secretKey: options.credentials.secretKey,
    form: { customer: input.providerAccountId, return_url: input.returnUrl },
  });

  return hostedSession(created, "a Billing Portal session");
}
