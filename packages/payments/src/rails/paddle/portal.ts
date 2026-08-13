// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { PortalHandoff, PortalSessionInput, PortalSubscriptionLinks } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";

/**
 * The customer portal — where a Paddle subscriber changes a card or cancels, under Paddle's own rules.
 *
 * ## The links are 24-hour bearer credentials, not the single-use tokens the issue describes
 *
 * `POST /customers/{ctm_…}/portal-sessions` returns `urls.general.overview` plus, per subscription,
 * `cancel_subscription` and `update_subscription_payment_method`. The issue calls those "single-use,
 * short-lived". Live, the overview URL carries `token=pga_<JWT>` whose `iat` and `exp` are 86400 seconds
 * apart, with scopes including `customer.subscription.update`, `customer.customer.update` and
 * `customer.transaction.create`. It is a day of control over that customer's billing.
 *
 * So "never cached or persisted" has to mean more than not writing them to a table: never logged, never
 * in an audit payload, and never a redirect target something downstream could read out of a `Referer`.
 * Nothing in this module returns them anywhere but to the caller, and the route emits an audit row naming
 * the customer and not one URL.
 *
 * ## The caller never names the customer, and never names a subscription
 *
 * `providerAccountId` comes from the provider-account map, keyed on the authenticated caller.
 * `subscriptionIds` comes from that caller's own purchase rows. The `/portal` route takes no body at all,
 * which is the request contract that makes this safe: either field there would let anyone mint
 * authenticated cancel links against somebody else's subscription.
 *
 * ## There is no return URL, and config refuses one
 *
 * Paddle's portal takes no return parameter. {@link PortalSessionInput.returnUrl} is optional precisely so
 * a rail can decline it in the type rather than accept one and silently drop it, and `paddle.portalReturnUrl`
 * is refused by config rather than accepted and ignored — a URL an adopter wrote that nothing reads is a
 * lie in a file they trust.
 */

/** What creating a portal session needs: the credentials, the account, and the transport. */
export interface PaddlePortalOptions {
  /** The rail's credentials. Only `apiKey` is used here, and it needs `customer_portal_session.write`. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to reach. */
  environment: PaddleEnvironment;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/**
 * Paddle asks for at most 25 subscription ids. More than that is not a shape this rail produces — one
 * caller with 26 live subscriptions is not a case worth failing a portal open over — so the list is
 * truncated with the newest kept rather than the request being refused.
 */
const MAX_PORTAL_SUBSCRIPTIONS = 25;

/** A created portal session, narrowed to the URLs it carries. */
const PaddlePortalSession = z
  .object({
    urls: z
      .object({
        general: z
          .object({ overview: z.string().min(1).describe("The portal's overview page for this customer.") })
          .loose()
          .describe("The account-wide links."),
        subscriptions: z
          .array(
            z
              .object({
                id: z.string().min(1).describe("The subscription these links act on."),
                cancel_subscription: z.string().min(1).describe("Where this subscription is cancelled."),
                update_subscription_payment_method: z
                  .string()
                  .min(1)
                  .describe("Where this subscription's payment method is changed."),
              })
              .loose(),
          )
          .optional()
          .describe("Per-subscription deep links, one entry per id asked for."),
      })
      .loose(),
  })
  .loose()
  .describe("A Paddle customer portal session — an overview page, and the deep links asked for.");

/** Create a portal session for one customer, and return where they manage their billing. */
export async function createPaddlePortalSession(
  input: PortalSessionInput,
  options: PaddlePortalOptions,
): Promise<PortalHandoff> {
  const ids = (input.subscriptionIds ?? []).slice(0, MAX_PORTAL_SUBSCRIPTIONS);

  const answer = await paddleJson(
    options.transport ?? paddleHttpFetch,
    `/customers/${encodeURIComponent(input.providerAccountId)}/portal-sessions`,
    {
      what: "a customer portal session",
      apiKey: options.credentials.apiKey,
      environment: options.environment,
      // An empty body rather than no body: this is a POST that creates a session, and Paddle answers the
      // account-wide overview with no `subscription_ids` at all.
      body: ids.length === 0 ? {} : { subscription_ids: ids },
    },
  );

  const parsed = PaddlePortalSession.safeParse(answer?.data);
  if (!parsed.success) {
    // Paddle created a session and did not say where to send the browser. A redirect to an absent URL is
    // worse than a refusal the caller can retry. This is also what an API key missing
    // `customer_portal_session.write` looks like from here — `pithy doctor` names that permission.
    throw new PaymentsProviderUnavailableError({
      detail: `Paddle returned a portal session for customer ${input.providerAccountId} with no authenticated URLs. Check that the API key carries \`customer_portal_session.write\`.`,
    });
  }

  const subscriptions: PortalSubscriptionLinks[] = (parsed.data.urls.subscriptions ?? []).map((entry) => ({
    subscriptionId: entry.id,
    cancel: entry.cancel_subscription,
    updatePaymentMethod: entry.update_subscription_payment_method,
  }));

  return {
    url: parsed.data.urls.general.overview,
    // Omitted rather than empty, so a screen's `subscriptions === undefined` reads as "this rail does not
    // do deep links" and an empty array reads as "it does, and this caller has none".
    ...(ids.length === 0 ? {} : { subscriptions }),
  };
}
