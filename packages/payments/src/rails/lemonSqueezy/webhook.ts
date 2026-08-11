// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { UnboundProviderEvent, VerifiedNotification, WebhookDelivery } from "../contract";
import { type LemonSqueezyHttpFetch, lemonSqueezyHttpFetch } from "./api";
import {
  accountReferenceOf,
  fencedOut,
  invoiceEvent,
  LemonSqueezyOrder,
  LemonSqueezySubscription,
  LemonSqueezySubscriptionInvoice,
  LemonSqueezyWebhook,
  namespacedId,
  orderEvent,
  subscriptionEvent,
} from "./objects";
import { readSubscription } from "./read";
import { verifyLemonSqueezySignature } from "./signature";

/**
 * Verify and read one Lemon Squeezy delivery.
 *
 * ## The event id, and where replay protection lives
 *
 * Lemon Squeezy does not put an event id in the body. It sends one in `X-Event-Name` and a delivery id in
 * `X-Signature`'s sibling headers only sometimes, so the id this rail reports is composed from what is
 * always present: the event name and the object it is about. That is stable across redeliveries of the same
 * event — which is the whole property `UNIQUE (rail, providerEventId)` needs — and different for two
 * genuinely different events about one object.
 *
 * It is deliberately *not* unique per delivery attempt. A redelivery must collide, because colliding is how
 * the guard recognizes it and answers 200 without reprojecting.
 *
 * ## Why an invoice event costs a round-trip
 *
 * A Lemon Squeezy subscription invoice carries no `variant_id`, and `providerProductId` is mandatory — the
 * writer resolves the catalog product from it and refuses without one. So an invoice-domain delivery reads
 * its subscription to learn which variant it bills. That is the Google rail's shape exactly, and it is why
 * `payments/provider_unavailable` passes through the webhook guard unchanged: an outage at Lemon Squeezy
 * must make the store redeliver, not make the operator hunt for a rotated signing key.
 *
 * Subscription-domain and order-domain deliveries carry everything they need and cost nothing.
 */

/** What the parser needs: the credentials, the deployment doing the asking, and the transport. */
export interface ParseLemonSqueezyNotificationOptions {
  /** The rail's credentials — the signing secret is read from here and never logged. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** This deployment's `ENVIRONMENT`, for the shared-store fence. */
  deployment?: string;
  /** The transport the subscription read goes through. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** The header Lemon Squeezy names the event in. Used only to compose the event id. */
const EVENT_NAME_HEADER = "x-event-name";

/** Every subscription-domain event: the standing changed, and no money moved. */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]);

/** Every invoice-domain event: money moved, and the standing is not in the payload. */
const INVOICE_EVENTS: ReadonlySet<string> = new Set([
  "subscription_payment_success",
  "subscription_payment_failed",
  "subscription_payment_recovered",
  "subscription_payment_refunded",
]);

/** Every order-domain event: a one-off, where money and state are the same object. */
const ORDER_EVENTS: ReadonlySet<string> = new Set(["order_created", "order_refunded"]);

/** Nothing at all was learned, but the delivery was authentic. The four-field null tuple every rail returns. */
function nothing(webhook: LemonSqueezyWebhook, providerEventId: string): VerifiedNotification {
  return {
    providerEventId,
    payload: { ...webhook },
    event: null,
    providerAccountId: null,
    accountReference: null,
    // Null, and it matters: a note routes the route into an audit warning, and a delivery that is simply
    // not ours — or an event type shipped after this package — is not a thing to warn an operator about.
    note: null,
  };
}

/** Verify a delivery's signature and read what it says. */
export async function parseLemonSqueezyNotification(
  delivery: WebhookDelivery,
  options: ParseLemonSqueezyNotificationOptions,
): Promise<VerifiedNotification> {
  await verifyLemonSqueezySignature(
    delivery.body,
    delivery.headers.get("x-signature"),
    options.credentials.webhookSecret,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(delivery.body) as unknown;
  } catch (cause) {
    throw new PaymentsVerificationFailedError({ detail: "Lemon Squeezy: the delivery body is not JSON." }, { cause });
  }

  const envelope = LemonSqueezyWebhook.safeParse(parsed);
  if (!envelope.success) {
    throw new PaymentsVerificationFailedError({
      detail: "Lemon Squeezy: the delivery is not a webhook envelope — no meta.event_name, or no data object.",
    });
  }
  const webhook = envelope.data;

  const name = delivery.headers.get(EVENT_NAME_HEADER) ?? webhook.meta.event_name;
  const providerEventId = `${name}:${webhook.data.id}`;

  // Another deployment's buyer, on the store we share with it. Authentic, recorded, and none of our business.
  if (fencedOut(webhook, options.deployment)) return nothing(webhook, providerEventId);

  if (SUBSCRIPTION_EVENTS.has(name)) return subscriptionNotification(webhook, providerEventId);
  if (INVOICE_EVENTS.has(name)) return await invoiceNotification(webhook, providerEventId, name, options);
  if (ORDER_EVENTS.has(name)) return orderNotification(webhook, providerEventId);

  // A type Lemon Squeezy shipped after this package did — a licence key, an affiliate payout. Authentic,
  // recorded, and projecting nothing. Never a throw: the store would redeliver it forever.
  return nothing(webhook, providerEventId);
}

/** A subscription-domain delivery: one state row, no round-trip. */
function subscriptionNotification(webhook: LemonSqueezyWebhook, providerEventId: string): VerifiedNotification {
  const subscription = LemonSqueezySubscription.parse(webhook.data.attributes);
  return {
    providerEventId,
    payload: { ...webhook },
    event: subscriptionEvent(webhook.data.id, subscription),
    providerAccountId: subscription.customer_id === undefined ? null : String(subscription.customer_id),
    accountReference: accountReferenceOf(webhook),
  };
}

/** An order-domain delivery: one row, money and state together. */
function orderNotification(webhook: LemonSqueezyWebhook, providerEventId: string): VerifiedNotification {
  const order = LemonSqueezyOrder.parse(webhook.data.attributes);
  return {
    providerEventId,
    payload: { ...webhook },
    event: orderEvent(webhook.data.id, order),
    providerAccountId: order.customer_id === undefined ? null : String(order.customer_id),
    accountReference: accountReferenceOf(webhook),
  };
}

/**
 * An invoice-domain delivery: one money row, and on a refund a second event revoking access.
 *
 * The subscription read is needed anyway — the invoice carries no variant — so the refund's state event
 * costs no extra call beyond the one the variant already required.
 */
async function invoiceNotification(
  webhook: LemonSqueezyWebhook,
  providerEventId: string,
  name: string,
  options: ParseLemonSqueezyNotificationOptions,
): Promise<VerifiedNotification> {
  const invoice = LemonSqueezySubscriptionInvoice.parse(webhook.data.attributes);
  const subscriptionId = String(invoice.subscription_id);
  const subscription = await readSubscription(subscriptionId, {
    credentials: options.credentials,
    transport: options.transport ?? lemonSqueezyHttpFetch,
  });

  // The store no longer knows the subscription this invoice bills. Authentic, unprojectable, and worth an
  // operator's attention — so this is the one place on this rail that does set a note.
  if (subscription === undefined) {
    return {
      providerEventId,
      payload: { ...webhook },
      event: null,
      providerAccountId: invoice.customer_id === undefined ? null : String(invoice.customer_id),
      accountReference: accountReferenceOf(webhook),
      note: `Lemon Squeezy no longer knows subscription ${subscriptionId}, which invoice ${webhook.data.id} bills.`,
    };
  }

  const event = invoiceEvent(webhook.data.id, invoice, String(subscription.variant_id ?? ""));

  return {
    providerEventId,
    payload: { ...webhook },
    event,
    providerAccountId: invoice.customer_id === undefined ? null : String(invoice.customer_id),
    accountReference: accountReferenceOf(webhook),
    stateEvent: name === "subscription_payment_refunded" ? revocation(subscriptionId, subscription, event) : null,
  };
}

/**
 * The state event a refund implies: access stops, now.
 *
 * Deliberately **not** the subscription's current status. Lemon Squeezy is a merchant of record and refunds
 * on its own — for a chargeback, a tax dispute, or its own support decision — and it does not necessarily
 * cancel the subscription when it does, so reading its status back would frequently say `active` and leave a
 * refunded buyer holding the feature. The money went back; the access goes with it.
 *
 * `revoked` rather than `refunded` because the two say different things about this row: the *invoice* was
 * refunded, and the subscription's standing was revoked as a consequence. Neither status grants, and
 * `revoked` on a `state` row never claws back — that is the money row's job, on the row that credited.
 */
function revocation(
  subscriptionId: string,
  subscription: ReturnType<typeof LemonSqueezySubscription.parse>,
  invoice: UnboundProviderEvent,
): UnboundProviderEvent {
  return {
    ...subscriptionEvent(subscriptionId, subscription),
    providerTransactionId: namespacedId("subscription", subscriptionId),
    status: "revoked",
    revokedAt: invoice.providerEventAt,
    expiresAt: invoice.providerEventAt,
    // The refund's own clock, not the subscription's. The subscription object was last touched before the
    // refund happened, so its `updated_at` would be older than the row it is trying to move and the
    // monotonic rule would discard the revocation entirely.
    providerEventAt: invoice.providerEventAt,
  };
}
