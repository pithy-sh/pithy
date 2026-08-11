// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { CheckoutSessionInput, HostedSession } from "../contract";
import { type LemonSqueezyHttpFetch, lemonSqueezyHttpFetch, lemonSqueezyJson } from "./api";
import { LEMON_SQUEEZY_CUSTOM_ACCOUNT, LEMON_SQUEEZY_CUSTOM_ENV } from "./objects";

/**
 * Hosted checkout, and nothing else.
 *
 * Lemon Squeezy presents the payment page, takes the money as **merchant of record**, and owns the sales
 * tax, the VAT registration, the invoice and the dunning. Pithy sends a browser there and hears the outcome
 * on a webhook. That division is the whole reason this rail exists, and there is no card field anywhere in
 * this package.
 *
 * ## What this call stamps, and why each of them
 *
 * **The authenticated purchaser, in `checkout_data.custom`.** A Lemon Squeezy purchase is only ever heard
 * about through a webhook, and that webhook carries a `customer_id` and no Pithy user. This is the pairing,
 * and it is why the `/checkout` route takes the purchaser from `c.var.auth` and never from a request body: a
 * client that could name it could attach its purchase to somebody else's account, or somebody else's
 * purchase to its own.
 *
 * **This deployment's environment, in the same place.** A Lemon Squeezy store is one namespace across every
 * environment — test mode is a flag on an object, not a separate store — so `dev` and `staging` pointed at
 * one store hear each other's webhooks. The stamp is what lets each ignore the other's.
 *
 * **Both keys are snake_case.** Lemon Squeezy normalizes custom keys before echoing them back, so a
 * camelCase key sent is a snake_case key returned, and a reader looking for what it sent finds nothing. The
 * binding silently never happens. Both sides read the same two constants, and a round-trip test pins it.
 *
 * ## What it deliberately does not do
 *
 * No quantity, no discount code, no plan-change or proration logic, and no price. The variant *is* the
 * price — that is Lemon Squeezy's model — and a checkout that could name an amount would be a checkout a
 * client could name an amount on.
 */

/** What creating a checkout needs beyond the input: the credentials, the deployment, and the transport. */
export interface LemonSqueezyCheckoutOptions {
  /** The rail's credentials. `apiKey` creates the checkout; `storeId` says which store it belongs to. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** This deployment's `ENVIRONMENT`, stamped so its own webhooks are recognisable. */
  deployment?: string;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** A created checkout, narrowed to the one field a browser needs. */
const LemonSqueezyCheckout = z
  .object({
    data: z
      .object({
        id: z.string().describe("The checkout's id."),
        attributes: z
          .object({ url: z.string().min(1).describe("The hosted page to send the browser to.") })
          .loose()
          .describe("The checkout's fields."),
      })
      .loose(),
  })
  .describe("A created Lemon Squeezy checkout, as much of it as a redirect needs.");

/** Create a hosted checkout for one product, and return where to send the browser. */
export async function createLemonSqueezyCheckoutSession(
  input: CheckoutSessionInput,
  options: LemonSqueezyCheckoutOptions,
): Promise<HostedSession> {
  const custom: Record<string, string> = { [LEMON_SQUEEZY_CUSTOM_ACCOUNT]: input.userId };
  if (options.deployment !== undefined) custom[LEMON_SQUEEZY_CUSTOM_ENV] = options.deployment;

  const created = await lemonSqueezyJson(options.transport ?? lemonSqueezyHttpFetch, "/checkouts", {
    what: "a checkout",
    apiKey: options.credentials.apiKey,
    body: {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            // The authenticated purchaser, echoed back on every webhook this purchase produces.
            custom,
          },
          product_options: {
            redirect_url: input.successUrl,
          },
          checkout_options: {
            // Lemon Squeezy's own page, unembedded. Pithy owns no payment UI.
            embed: false,
          },
        },
        relationships: {
          store: { data: { type: "stores", id: options.credentials.storeId } },
          variant: { data: { type: "variants", id: input.providerProductId } },
        },
      },
    },
  });

  const parsed = LemonSqueezyCheckout.safeParse(created);
  if (!parsed.success) {
    // Lemon Squeezy created something and did not say where to send the browser. A redirect to an absent
    // URL is worse than a refusal the caller can retry.
    throw new PaymentsProviderUnavailableError({
      detail: "Lemon Squeezy created a checkout with no URL to redirect to.",
    });
  }
  return { url: parsed.data.data.attributes.url };
}
