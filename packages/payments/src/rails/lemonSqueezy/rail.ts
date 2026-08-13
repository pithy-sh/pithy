// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CreatedDiscount, DiscountTerms, SubscriptionPricing } from "../../data/discount";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type {
  CheckoutHandoff,
  CheckoutRail,
  CheckoutSessionInput,
  DiscountRail,
  ListedDiscount,
  PaymentsRailProvider,
  PortalHandoff,
  PortalSessionInput,
  PricingRail,
  RailRequestContext,
  UnboundProviderEvent,
  VerifiedNotification,
  VerifiedPurchase,
  WebhookDelivery,
} from "../contract";
import type { LemonSqueezyHttpFetch } from "./api";
import { createLemonSqueezyCheckoutSession } from "./checkout";
import { createLemonSqueezyDiscount, listLemonSqueezyDiscounts } from "./discounts";
import { createLemonSqueezyPortalSession } from "./portal";
import { readLemonSqueezyPricing } from "./pricing";
import { refreshLemonSqueezyPurchase } from "./refresh";
import { verifyLemonSqueezyOrder } from "./verify";
import { parseLemonSqueezyNotification } from "./webhook";

/**
 * The Lemon Squeezy rail as one provider object — the second to implement both halves of the contract.
 *
 * Like Stripe, this rail *initiates* purchases: `/checkout` creates a hosted checkout and sends the browser
 * to it, so it implements {@link CheckoutRail} as well as {@link PaymentsRailProvider}. Unlike Stripe, it
 * refuses `verify` outright — there is no client-submittable receipt here that could be trusted, and
 * `verify.ts` explains at length why the obvious candidates are not one.
 *
 * Built per request from credentials the caller resolved through the secrets store, rather than reading
 * them itself. That keeps the rail a pure function of its inputs and keeps the secret read at the point of
 * need.
 *
 * **Hosted only, and merchant of record.** Lemon Squeezy owns the payment page, the sales tax, the VAT
 * registration, the invoice, the dunning and the chargebacks. That is the entire reason an adopter reaches
 * for this rail over Stripe, and nothing in this module is a small edit away from taking any of it back.
 */

/** How the Lemon Squeezy rail's transport is varied. One seam, for the tests and for the reconciliation pass. */
export interface LemonSqueezyRailOptions {
  /** The HTTP seam Lemon Squeezy's API is reached through. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
  /**
   * Whether a variant is sold as a subscription, answered from the adopter's catalog.
   *
   * Supplied by `resolveRailProvider`, which has the config. It decides whether an `order_created` is a
   * one-off sale or the container a subscription arrived in — the second of which is not its own payment.
   */
  sellsSubscription?: (variantId: string) => boolean;
  /**
   * The currency this store prices in, when the project declared one.
   *
   * Only used to refuse a fixed discount in another currency before it reaches the store — see
   * `discounts.ts` for why that refusal has to happen at creation rather than at redemption.
   */
  storeCurrency?: string;
}

/** The Lemon Squeezy rail. Parses webhooks, re-reads purchases, and creates hosted checkouts and portal links. */
export function lemonSqueezyRail(
  credentials: PaymentsLemonSqueezyCredentials,
  options: LemonSqueezyRailOptions = {},
): PaymentsRailProvider & CheckoutRail & DiscountRail & PricingRail {
  return {
    rail: "lemonSqueezy",

    async verify(receipt: string): Promise<VerifiedPurchase> {
      // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt*
      // the rejection rather than raising it, and workerd then reports the adopted promise as an unhandled
      // rejection even though Hono's `onError` answers the request correctly.
      return await verifyLemonSqueezyOrder(receipt);
    },

    async parseNotification(delivery: WebhookDelivery, context: RailRequestContext): Promise<VerifiedNotification> {
      return await parseLemonSqueezyNotification(delivery, {
        credentials,
        deployment: context.deployment,
        transport: options.transport,
        sellsSubscription: options.sellsSubscription,
      });
    },

    async refresh(purchase: PaymentsPurchase, context: RailRequestContext): Promise<UnboundProviderEvent | undefined> {
      // `return await`, not `return` — see `verify` above for why the frame must raise rather than adopt.
      return await refreshLemonSqueezyPurchase(purchase, {
        credentials,
        now: context.now,
        transport: options.transport,
      });
    },

    async createCheckoutSession(input: CheckoutSessionInput, context: RailRequestContext): Promise<CheckoutHandoff> {
      return await createLemonSqueezyCheckoutSession(input, {
        credentials,
        deployment: context.deployment,
        transport: options.transport,
      });
    },

    async createPortalSession(input: PortalSessionInput): Promise<PortalHandoff> {
      return await createLemonSqueezyPortalSession(input, { credentials, transport: options.transport });
    },

    async readPricing(
      purchase: PaymentsPurchase,
      _context: RailRequestContext,
    ): Promise<SubscriptionPricing | undefined> {
      return await readLemonSqueezyPricing(purchase, { credentials, transport: options.transport });
    },

    async listDiscounts(): Promise<readonly ListedDiscount[]> {
      return await listLemonSqueezyDiscounts({
        credentials,
        storeCurrency: options.storeCurrency,
        transport: options.transport,
      });
    },

    async createDiscount(terms: DiscountTerms): Promise<CreatedDiscount> {
      return await createLemonSqueezyDiscount(terms, {
        credentials,
        storeCurrency: options.storeCurrency,
        transport: options.transport,
      });
    },
  };
}
