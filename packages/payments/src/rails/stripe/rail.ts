import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type {
  CheckoutRail,
  CheckoutSessionInput,
  HostedSession,
  PaymentsRailProvider,
  PortalSessionInput,
  RailRequestContext,
  UnboundProviderEvent,
  VerifiedNotification,
  VerifiedPurchase,
  WebhookDelivery,
} from "../contract";
import type { StripeHttpFetch } from "./api";
import { createStripeCheckoutSession } from "./checkout";
import { createStripePortalSession } from "./portal";
import { refreshStripeSubscription } from "./refresh";
import { verifyStripeSession } from "./verify";
import { parseStripeNotification } from "./webhook";

/**
 * The Stripe rail as one provider object — and the only rail that implements both halves of the contract.
 *
 * Apple and Google purchases have already happened inside a store SDK by the time the server hears of them. A
 * Stripe purchase is one Pithy initiates: `/checkout` creates a hosted session and sends the browser to it. That
 * asymmetry is why {@link CheckoutRail} is a separate interface rather than two methods Apple would have to stub,
 * and this is the object that satisfies both.
 *
 * Built per request from credentials the caller resolved through the secrets store, rather than reading them
 * itself. That keeps the rail a pure function of its inputs and keeps the secret read at the point of need.
 *
 * **Hosted only, and that is a decision rather than a stage.** No Payment Element, no card fields, no proration
 * or plan-change logic — Stripe owns the payment page, SCA, tax, and every rule that changes underneath them.
 * Nothing in this module would be a small edit away from owning any of that, which is the point.
 */

/** How the Stripe rail's transport and replay window may be varied. Both exist for the tests. */
export interface StripeRailOptions {
  /** The HTTP seam Stripe's API is reached through. Defaults to the runtime's `fetch`. */
  transport?: StripeHttpFetch;
  /** The signature freshness window, in seconds. Defaults to Stripe's own five minutes. */
  toleranceSeconds?: number;
}

/** The Stripe rail. Verifies a returning Checkout Session, verifies webhooks, and creates hosted sessions. */
export function stripeRail(
  credentials: PaymentsStripeCredentials,
  options: StripeRailOptions = {},
): PaymentsRailProvider & CheckoutRail {
  return {
    rail: "stripe",

    async verify(receipt: string, context: RailRequestContext): Promise<VerifiedPurchase> {
      // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt* the
      // rejection rather than raising it, and workerd then reports the adopted promise as an unhandled rejection
      // even though Hono's `onError` answers the request correctly. A refused session is normal traffic.
      return await verifyStripeSession(receipt, {
        credentials,
        now: context.now,
        transport: options.transport,
      });
    },

    async parseNotification(delivery: WebhookDelivery, context: RailRequestContext): Promise<VerifiedNotification> {
      return await parseStripeNotification(delivery, {
        credentials,
        now: context.now,
        toleranceSeconds: options.toleranceSeconds,
      });
    },

    async refresh(purchase: PaymentsPurchase, context: RailRequestContext): Promise<UnboundProviderEvent | undefined> {
      // `return await`, not `return` — see `verify` above for why the frame must raise rather than adopt.
      return await refreshStripeSubscription(purchase, {
        credentials,
        now: context.now,
        transport: options.transport,
      });
    },

    async createCheckoutSession(input: CheckoutSessionInput): Promise<HostedSession> {
      return await createStripeCheckoutSession(input, { credentials, transport: options.transport });
    },

    async createPortalSession(input: PortalSessionInput): Promise<HostedSession> {
      return await createStripePortalSession(input, { credentials, transport: options.transport });
    },
  };
}
