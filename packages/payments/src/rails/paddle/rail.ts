// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CreatedDiscount, DiscountTerms, SubscriptionPricing } from "../../data/discount";
import type { PaymentsPurchase } from "../../data/purchase";
import type { RefundRequest, SubscriptionChangeQuote, SubscriptionStanding } from "../../data/subscription";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
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
  RefundRail,
  RefundRequestInput,
  SubscriptionCancelInput,
  SubscriptionChangeInput,
  SubscriptionRail,
  UnboundProviderEvent,
  VerifiedNotification,
  VerifiedPurchase,
  WebhookDelivery,
} from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch } from "./api";
import { createPaddleCheckoutSession } from "./checkout";
import { createPaddleDiscount, listPaddleDiscounts } from "./discounts";
import { PaddleEvent } from "./objects";
import { createPaddlePortalSession } from "./portal";
import { PADDLE_ADJUSTMENTS_INCLUDE, readTransaction } from "./read";
import { readPaddlePricing, refreshPaddlePurchase } from "./refresh";
import { requestPaddleRefunds } from "./refund";
import {
  cancelPaddleSubscription,
  changePaddlePlan,
  keepPaddleSubscription,
  previewPaddleChange,
  readPaddleStanding,
} from "./subscription";
import { verifyPaddleTransaction } from "./verify";
import { parsePaddleNotification, readPaddleEvent } from "./webhook";

/**
 * The Paddle rail as one provider object — the fifth, and the second merchant of record.
 *
 * Like Stripe and Lemon Squeezy this rail *initiates* purchases, so it implements {@link CheckoutRail}.
 * Unlike Lemon Squeezy it also implements `verify`, and that is not a nicety: `dev` is not publicly
 * routable, so a dev checkout's webhooks land at `staging`, and a submitted `txn_…` checked against a
 * proven ownership stamp is what makes local development work at all. See `verify.ts`.
 *
 * It is also the first rail to implement {@link SubscriptionRail} — read a subscription's standing, quote a
 * plan change, make one, cancel, and withdraw a cancellation. That is a third interface rather than three
 * more methods on the shared contract for {@link CheckoutRail}'s reason: an Apple or Google subscription is
 * changed inside the store's own UI, on the device, and a rail forced to declare `changePlan` would declare a
 * method that cannot be written. `subscription.ts` holds the five, and every rule they enforce came out of
 * sandbox recordings rather than the documentation (#465).
 *
 * It implements {@link RefundRail} too, and that is a *sixth* interface rather than a sixth subscription verb.
 * The two abilities are independent in both directions — Play refunds from the server and changes no plan from
 * it, Apple's only refund endpoint is a lookup — and `isSubscriptionRail` ANDs its methods, so widening it
 * would have de-narrowed every rail already shipping the five. `refund.ts` holds it.
 *
 * Built per request from credentials the caller resolved through the secrets store, rather than reading
 * them itself. That keeps the rail a pure function of its inputs and keeps the secret read at the point of
 * need.
 *
 * **Merchant of record.** Paddle is the seller on the customer's statement. It calculates and remits sales
 * tax and VAT worldwide, issues the invoices, runs dunning, and absorbs the chargebacks. The one place
 * that shows in this package is that a refund can arrive with no local write preceding it — Paddle issues
 * them on its own account.
 */

/** How the Paddle rail is varied. */
export interface PaddleRailOptions {
  /** Which Paddle account this deployment sells through — sandbox or production. */
  environment: PaddleEnvironment;
  /** The publishable client token a browser initializes Paddle.js with. */
  clientToken: string;
  /** Whether checkout opens as an overlay, inline, or on Paddle's own hosted page. */
  checkout: "overlay" | "inline" | "hosted";
  /** How many seconds either side of now a delivery may be dated. Undefined uses the rail's 300. */
  freshnessSeconds?: number;
  /**
   * The currency this project's Paddle catalog prices in, when the project declared one.
   *
   * Only used to refuse a fixed discount in another currency before it reaches Paddle — see
   * `discounts.ts` for why that refusal has to happen at creation rather than at redemption.
   */
  storeCurrency?: string;
  /** The HTTP seam Paddle's API is reached through. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/** The Paddle rail. */
export function paddleRail(
  credentials: PaymentsPaddleCredentials,
  options: PaddleRailOptions,
): PaymentsRailProvider & CheckoutRail & DiscountRail & PricingRail & SubscriptionRail & RefundRail {
  const transport = options.transport ?? paddleHttpFetch;
  const base = { credentials, environment: options.environment, transport };

  return {
    rail: "paddle",

    async verify(receipt: string, context: RailRequestContext): Promise<VerifiedPurchase> {
      // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt*
      // the rejection rather than raising it, and workerd then reports the adopted promise as an unhandled
      // rejection even though Hono's `onError` answers the request correctly.
      return await verifyPaddleTransaction(receipt, { ...base, deployment: context.deployment, now: context.now });
    },

    async parseNotification(delivery: WebhookDelivery, context: RailRequestContext): Promise<VerifiedNotification> {
      return await parsePaddleNotification(delivery, {
        credentials,
        environment: options.environment,
        now: context.now,
        deployment: context.deployment,
        freshnessSeconds: options.freshnessSeconds,
        // An adjustment says how much came off and never what the original was, so "full refund" is a
        // comparison the parser cannot make without this read. The rail owns the transport, so the rail
        // supplies it — and it is the one read that asks for `include=adjustments`, which is the one read
        // that needs the key to carry `adjustment.read`.
        readTransaction: (id) => readTransaction(id, base, PADDLE_ADJUSTMENTS_INCLUDE),
      });
    },

    async replay(
      payload: Record<string, unknown>,
      context: RailRequestContext,
    ): Promise<VerifiedNotification | undefined> {
      // The recorded body is a Paddle event as the stream and the webhook both deliver it, so the map is the
      // same one both paths already use. The signature is not re-checked and could not be: it covers a header
      // this table never stored, and the row's authenticity was established when it was written.
      const parsed = PaddleEvent.safeParse(payload);
      if (!parsed.success) return undefined;
      return await readPaddleEvent(parsed.data, {
        credentials,
        environment: options.environment,
        now: context.now,
        deployment: context.deployment,
        readTransaction: (id) => readTransaction(id, base, PADDLE_ADJUSTMENTS_INCLUDE),
      });
    },

    async refresh(purchase: PaymentsPurchase, context: RailRequestContext): Promise<UnboundProviderEvent | undefined> {
      return await refreshPaddlePurchase(purchase, { ...base, now: context.now });
    },

    async createCheckoutSession(input: CheckoutSessionInput, context: RailRequestContext): Promise<CheckoutHandoff> {
      return await createPaddleCheckoutSession(input, {
        credentials,
        environment: options.environment,
        clientToken: options.clientToken,
        checkout: options.checkout,
        deployment: context.deployment,
        transport,
      });
    },

    async createPortalSession(input: PortalSessionInput): Promise<PortalHandoff> {
      return await createPaddlePortalSession(input, { credentials, environment: options.environment, transport });
    },

    async readPricing(
      purchase: PaymentsPurchase,
      context: RailRequestContext,
    ): Promise<SubscriptionPricing | undefined> {
      return await readPaddlePricing(purchase, { ...base, now: context.now });
    },

    async listDiscounts(): Promise<readonly ListedDiscount[]> {
      return await listPaddleDiscounts({
        credentials,
        environment: options.environment,
        storeCurrency: options.storeCurrency,
        transport,
      });
    },

    async createDiscount(terms: DiscountTerms): Promise<CreatedDiscount> {
      return await createPaddleDiscount(terms, {
        credentials,
        environment: options.environment,
        storeCurrency: options.storeCurrency,
        transport,
      });
    },

    async readStanding(purchase: PaymentsPurchase): Promise<SubscriptionStanding | undefined> {
      return await readPaddleStanding(purchase, base);
    },

    async previewChange(input: SubscriptionChangeInput, context: RailRequestContext): Promise<SubscriptionChangeQuote> {
      // The one method here that reads the context's locale: its answer is the only one carrying money a
      // person reads. See `RailRequestContext.locale`.
      return await previewPaddleChange(input, base, context.locale);
    },

    async changePlan(input: SubscriptionChangeInput): Promise<SubscriptionStanding> {
      return await changePaddlePlan(input, base);
    },

    async cancelSubscription(input: SubscriptionCancelInput): Promise<SubscriptionStanding> {
      return await cancelPaddleSubscription(input, base);
    },

    async keepSubscription(purchase: PaymentsPurchase): Promise<SubscriptionStanding> {
      return await keepPaddleSubscription(purchase, base);
    },

    async requestRefunds(input: RefundRequestInput): Promise<RefundRequest> {
      return await requestPaddleRefunds(input, base);
    },
  };
}
