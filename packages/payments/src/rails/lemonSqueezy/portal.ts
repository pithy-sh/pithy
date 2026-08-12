// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { HostedSession, PortalSessionInput } from "../contract";
import { type LemonSqueezyHttpFetch, lemonSqueezyHttpFetch, lemonSqueezyJson } from "./api";

/**
 * The customer portal — where a Lemon Squeezy subscriber changes a card or cancels, under Lemon Squeezy's
 * own rules.
 *
 * ## Why this is a read and not a create
 *
 * Stripe mints a Billing Portal *session* per caller. Lemon Squeezy does not: the portal link is an
 * attribute of the customer object, already signed and already expiring, and reading the customer is how you
 * get it. So this asks for the customer the provider-account map resolved and returns the link it carries.
 *
 * That is why there is no `returnUrl` here. Lemon Squeezy's portal takes no return parameter — the
 * subscriber closes the tab — and {@link PortalSessionInput.returnUrl} is optional precisely so this rail
 * can decline it in the type rather than accept one and silently drop it. A project running this rail alone
 * is never asked to configure a URL that nothing would use.
 *
 * ## The caller never names the customer
 *
 * `providerAccountId` comes from the provider-account map, keyed on the authenticated caller — never from a
 * request body. The `/portal` route takes no body at all, which is the request contract that makes this
 * safe: a `customer` field there would let anyone read anyone's billing portal, and the link is a bearer
 * credential for that account's subscription.
 */

/** What creating a portal link needs: the credentials, and the transport. */
export interface LemonSqueezyPortalOptions {
  /** The rail's credentials. Only `apiKey` is used here. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** A customer, narrowed to the portal link it carries. */
const LemonSqueezyCustomer = z.object({
  data: z
    .object({
      attributes: z
        .object({
          urls: z
            .object({
              customer_portal: z
                .string()
                .min(1)
                .describe("The signed, expiring portal link. A bearer credential for this account's billing."),
            })
            .loose()
            .describe("The customer's links."),
        })
        .loose(),
    })
    .loose(),
});

/** The portal link for one customer. */
export async function createLemonSqueezyPortalSession(
  input: PortalSessionInput,
  options: LemonSqueezyPortalOptions,
): Promise<HostedSession> {
  const customer = await lemonSqueezyJson(
    options.transport ?? lemonSqueezyHttpFetch,
    `/customers/${encodeURIComponent(input.providerAccountId)}`,
    { what: "a customer portal link", apiKey: options.credentials.apiKey },
  );

  const parsed = LemonSqueezyCustomer.safeParse(customer);
  if (!parsed.success) {
    // A customer with no portal link is a customer Lemon Squeezy will not let us manage. Nothing here
    // recovers from that, and sending a browser nowhere is worse than a refusal.
    throw new PaymentsProviderUnavailableError({
      detail: `Lemon Squeezy returned customer ${input.providerAccountId} with no customer_portal link.`,
    });
  }
  return { url: parsed.data.data.attributes.urls.customer_portal };
}
