// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { minorUnitDigits, minorUnitsFromScaled } from "../../data/money";
import type { PurchaseEnvironment } from "../../data/purchase";
import { ACCESS_GRANTING_STATUSES, type PurchaseStatus } from "../../data/status";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { UnboundProviderEvent } from "../contract";

/**
 * Stripe's objects, and the mapping from what Stripe calls a thing to what the projection stores.
 *
 * ## The two identifiers, and why they are what they are
 *
 * A subscription row is keyed on the **invoice**, not on the subscription. Stripe keeps one subscription id
 * across every renewal, so keying on it would make one row for the lifetime of a subscription — and a `grants`
 * clause would then credit once ever rather than once per billing period, which is the behaviour issue #79
 * specifies and the behaviour Apple and Google already have. The invoice changes each period, so each period is
 * its own purchase row. The subscription id becomes `originalTransactionId`, the family key, exactly as Play's
 * purchase token does: a renewal's owner resolves through the purchase that started the subscription.
 *
 * A one-time row is keyed on the **payment intent**, not on the Checkout Session. A later `charge.refunded`
 * names the payment intent and knows nothing about the session, so keying on it is what lets a refund land on
 * the purchase it refunds.
 *
 * ## Where a product comes from
 *
 * A subscription carries its price inline. A Checkout Session does **not** — `line_items` is expandable, and a
 * webhook payload never expands anything. So the price id is stamped into the session's metadata when the
 * session is created (`checkout.ts`), and read back here. On the retrieve path the line items *are* expanded,
 * and Stripe's own answer is preferred over our copy.
 *
 * A session that Pithy did not create — a Payment Link built in the dashboard — therefore carries no price we
 * can resolve. That is recorded as a note rather than dropped or guessed, the same bounded gap Play's voided
 * purchases have: authentic, unresolvable here, repairable from the recorded id.
 *
 * ## A completed session is frozen, and that is a security property
 *
 * `payment_status` reads `paid` for ever. It does not change when the charge is refunded, and a retrieve
 * expands nothing about the refund unless asked — so on this path a session alone can only ever say the
 * purchase was paid for once. Two things follow, and both are load-bearing: the retrieve expands
 * `payment_intent.latest_charge` so a refund is *visible* (`verify.ts`), and a snapshot that claims access is
 * dated by Stripe's own clock rather than ours so it cannot outrank the refund that followed it
 * ({@link retrievedAt}). A subscription-mode session is different in kind: Stripe expands the live
 * subscription object, so its state is current and the clock is the honest date.
 *
 * ## Two fields Stripe has moved
 *
 * `current_period_start` and `current_period_end` moved from the subscription onto its items. A webhook endpoint
 * pinned to an older API version still sends the old spelling, and an adopter's endpoint version is not
 * something this package controls — so both are read, item first. This is the same accommodation the Google rail
 * makes for Play Billing's two spellings of a product id.
 */

/** The metadata key carrying the reference this deployment stamped on a purchase it initiated. */
export const STRIPE_METADATA_ACCOUNT_REFERENCE = "pithy_account_reference";

/** The metadata key carrying the price a Checkout Session was created for. */
export const STRIPE_METADATA_PRICE = "pithy_price_id";

/**
 * Stripe's subscription statuses, mapped.
 *
 * Two are worth reading twice. **`trialing` grants** — a trial is access, and `expiresAt` is what ends it.
 * **`past_due` is `in_grace`** — Stripe is still retrying the card and the subscriber normally keeps access
 * through the retry schedule, which is what grace means; `unpaid` is the same subscription once the retries are
 * exhausted, and never grants.
 *
 * `incomplete` is `on_hold` rather than `expired`: the first payment has not completed, so nothing was bought
 * yet, but it still might be. `incomplete_expired` is where that ends when it never does, and it is
 * **`never_paid`** rather than `expired` — no charge ever cleared, so a `grants` clause must not credit it.
 */
const SUBSCRIPTION_STATUSES: Readonly<Record<string, PurchaseStatus>> = {
  trialing: "active",
  active: "active",
  past_due: "in_grace",
  unpaid: "on_hold",
  canceled: "expired",
  incomplete: "on_hold",
  incomplete_expired: "never_paid",
  paused: "paused",
};

/** A Stripe price, as much of it as a purchase row needs. */
const StripePrice = z
  .object({
    id: z.string().min(1).describe("The price id — `price_1Abc`. The SKU the catalog maps, and publishable."),
    currency: z.string().min(1).optional().describe("The price's ISO currency, lower case as Stripe writes it."),
    unit_amount: z
      .number()
      .int()
      .nullish()
      .describe("The amount in the currency's minor unit, or null for a metered or tiered price."),
  })
  .loose()
  .describe("One Stripe price. What a subscription item or a line item is sold at.");

/** One item of a subscription — the price, and the period it currently covers. */
const StripeSubscriptionItem = z
  .object({
    id: z.string().min(1).describe("The subscription item id. Recorded only."),
    price: StripePrice.describe("What this item is priced at. Its id is the SKU the catalog maps."),
    quantity: z.number().int().optional().describe("How many. One unless the price allows more."),
    current_period_start: z
      .number()
      .int()
      .nullish()
      .describe("When the item's paid period began, in seconds. Where Stripe moved the subscription's own field."),
    current_period_end: z
      .number()
      .int()
      .nullish()
      .describe("When the item's paid period ends, in seconds. This is what becomes the purchase's `expiresAt`."),
  })
  .loose()
  .describe("One line of a Stripe subscription.");

export const StripeSubscription = z
  .object({
    id: z.string().min(1).describe("The subscription id — `sub_…`. The family key every renewal shares."),
    customer: z
      .string()
      .min(1)
      .nullish()
      .describe("The Stripe customer — `cus_…`. The identifier a later notification carries instead of a user."),
    status: z.string().min(1).describe("Stripe's own status. Mapped to a normalized one; an unknown one is refused."),
    cancel_at_period_end: z
      .boolean()
      .optional()
      .describe("Whether auto-renew is off. True with a live status is the normalized `canceled`, which grants."),
    latest_invoice: z
      .string()
      .min(1)
      .nullish()
      .describe("The current period's invoice — `in_…`. The transaction identity, so each period is its own row."),
    created: z.number().int().describe("When the subscription was created, in seconds."),
    start_date: z.number().int().nullish().describe("When it began, in seconds. The fallback for `purchasedAt`."),
    canceled_at: z.number().int().nullish().describe("When cancellation was requested, in seconds. Recorded only."),
    ended_at: z.number().int().nullish().describe("When it actually ended, in seconds. Recorded only."),
    current_period_start: z
      .number()
      .int()
      .nullish()
      .describe("The period start, as API versions before Basil reported it on the subscription itself."),
    current_period_end: z
      .number()
      .int()
      .nullish()
      .describe("The period end, as API versions before Basil reported it on the subscription itself."),
    currency: z.string().min(1).nullish().describe("The subscription's currency. The fallback for the price's own."),
    livemode: z
      .boolean()
      .optional()
      .describe("Whether this came from a live key. False is a test-mode object, which is a sandbox purchase."),
    metadata: z
      .record(z.string(), z.string())
      .nullish()
      .describe("Whatever was attached at creation, including the account reference this deployment stamped."),
    items: z
      .object({
        data: z
          .array(StripeSubscriptionItem)
          .min(1)
          .describe("The subscription's items. The first is the product this purchase is projected as."),
      })
      .loose()
      .describe("The subscription's line items."),
  })
  .loose()
  .describe("A Stripe subscription, as much of it as the projection reads.");
export type StripeSubscription = z.infer<typeof StripeSubscription>;

/** One expanded Checkout line item. Present only on a retrieve that asked for it. */
const StripeLineItem = z
  .object({
    id: z.string().min(1).describe("The line item id. Recorded only."),
    price: StripePrice.nullish().describe("What the line was sold at. Its id is the SKU the catalog maps."),
    quantity: z.number().int().nullish().describe("How many were bought."),
  })
  .loose()
  .describe("One line of a Checkout Session, when the caller expanded them.");

export const StripeCharge = z
  .object({
    id: z.string().min(1).describe("The charge id — `ch_…`. Recorded, and named in a note when nothing else is."),
    payment_intent: z
      .string()
      .min(1)
      .nullish()
      .describe("The payment intent this charge settled — the purchase row's key, and the only link back to it."),
    customer: z.string().min(1).nullish().describe("The Stripe customer charged — `cus_…`."),
    amount: z.number().int().nullish().describe("What was charged, in the currency's minor unit."),
    amount_refunded: z.number().int().nullish().describe("How much has been given back. Above zero is a refund."),
    refunded: z.boolean().optional().describe("Whether the charge was refunded in full."),
    currency: z.string().min(1).nullish().describe("The ISO currency, lower case."),
    created: z.number().int().describe("When the charge was made, in seconds. The purchase's own date."),
    livemode: z.boolean().optional().describe("Whether this came from a live key. False is a sandbox purchase."),
    metadata: z
      .record(z.string(), z.string())
      .nullish()
      .describe("What this deployment stamped on the payment intent, when Stripe carried it through."),
  })
  .loose()
  .describe("A Stripe charge, as much of it as a refund needs.");
export type StripeCharge = z.infer<typeof StripeCharge>;

/**
 * A payment intent, as a retrieve that expanded it reports it. Declared before the session because that is
 * where it hangs, and it exists for one reason: the charge underneath it is the only object that says what
 * became of the money.
 */
const StripePaymentIntent = z
  .object({
    id: z.string().min(1).describe("The payment intent id — `pi_…`. A one-time purchase's transaction identity."),
    status: z.string().min(1).nullish().describe("Stripe's own state for the intent. Recorded only."),
    created: z.number().int().nullish().describe("When the intent was created, in seconds."),
    latest_charge: z
      .union([
        z.string().min(1).describe("The charge id, when the caller did not expand it."),
        StripeCharge.describe("The charge itself, expanded — which is what makes a refund visible on a retrieve."),
      ])
      .nullish()
      .describe("The charge that settled this intent, by id or expanded. Expanded, it dates and refutes the sale."),
  })
  .loose()
  .describe("A Stripe payment intent, as much of it as a one-time purchase's state needs.");

export const StripeCheckoutSession = z
  .object({
    id: z.string().min(1).describe("The session id — `cs_…`. What a returning browser carries back."),
    mode: z
      .string()
      .min(1)
      .describe("`payment`, `subscription`, or `setup`. Decides which shape of purchase, if any, this completed."),
    status: z.string().min(1).nullish().describe("`open`, `complete`, or `expired`. Recorded only."),
    payment_status: z
      .string()
      .min(1)
      .nullish()
      .describe("`paid`, `unpaid`, or `no_payment_required`. What decides whether a one-time purchase grants."),
    amount_total: z.number().int().nullish().describe("What was charged, in the currency's minor unit."),
    currency: z.string().min(1).nullish().describe("The ISO currency of `amount_total`, lower case."),
    customer: z.string().min(1).nullish().describe("The Stripe customer the session created or reused — `cus_…`."),
    client_reference_id: z
      .string()
      .min(1)
      .nullish()
      .describe(
        "The reference this deployment set when it created the session — the authenticated purchaser. The only hook from a Stripe purchase back to a Pithy user.",
      ),
    payment_intent: z
      .union([
        z.string().min(1).describe("The payment intent id, as a webhook payload carries it."),
        StripePaymentIntent.describe("The intent itself, when the caller expanded it on a retrieve."),
      ])
      .nullish()
      .describe("The payment intent — `pi_…`. A one-time purchase's transaction identity, and what a refund names."),
    subscription: z
      .union([
        z.string().min(1).describe("The subscription id, as a webhook payload carries it."),
        StripeSubscription.describe("The subscription itself, when the caller expanded it on a retrieve."),
      ])
      .nullish()
      .describe("The subscription this session started, by id or expanded."),
    created: z.number().int().describe("When the session was created, in seconds. A one-time purchase's date."),
    expires_at: z.number().int().nullish().describe("When an unpaid session lapses, in seconds. Recorded only."),
    livemode: z.boolean().optional().describe("Whether this came from a live key. False is a sandbox purchase."),
    metadata: z
      .record(z.string(), z.string())
      .nullish()
      .describe("What this deployment stamped: the account reference, and the price the session was created for."),
    line_items: z
      .object({
        data: z.array(StripeLineItem).describe("The expanded lines. Absent on every webhook payload."),
      })
      .loose()
      .nullish()
      .describe("The session's line items, present only when a retrieve expanded them."),
  })
  .loose()
  .describe("A Stripe Checkout Session, as much of it as the projection reads.");
export type StripeCheckoutSession = z.infer<typeof StripeCheckoutSession>;

export const StripeEvent = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("The event id — `evt_…`. `UNIQUE (rail, providerEventId)` keys on it, so a redelivery is one row."),
    type: z.string().min(1).describe("What happened — `customer.subscription.updated`. Decides which object this is."),
    created: z
      .number()
      .int()
      .describe(
        "Stripe's own timestamp for the event, in seconds. This is the provider event time the monotonic write rule compares — never the object's own `created`, which would make every later event look staler than the first.",
      ),
    livemode: z.boolean().optional().describe("Whether the event came from a live key. Recorded; the object decides."),
    api_version: z.string().min(1).nullish().describe("The API version the payload is shaped by. Recorded only."),
    data: z
      .object({
        object: z
          .record(z.string(), z.unknown())
          .describe("The object the event is about. Parsed against its own schema once the type is known."),
      })
      .loose()
      .describe("The event's payload."),
  })
  .loose()
  .describe("A Stripe event, as delivered to a webhook endpoint.");
export type StripeEvent = z.infer<typeof StripeEvent>;

/**
 * One Stripe object, mapped. The shape maps one-to-one onto a `VerifiedNotification`, so the rail is a
 * signature check and this call.
 */
export interface StripeMappedEvent {
  /** The transaction, or null when the event reports no transaction state. Null is a success. */
  event: UnboundProviderEvent | null;
  /** The Stripe customer the object named, or null. What a later notification is resolved through. */
  providerAccountId: string | null;
  /** The reference this deployment stamped when it created the purchase, or null. */
  accountReference: string | null;
  /** Why there is no event, when that is worth recording on the webhook row. Null when nothing is missing. */
  note: string | null;
}

/** The event types this build acts on. Anything else is authentic and changes nothing. */
const HANDLED_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
]);

/**
 * The normalized status for a Stripe subscription, given whether auto-renew is off.
 *
 * `cancel_at_period_end` is read **only** when the subscription is otherwise live. Stripe leaves the flag set on
 * a subscription it has since ended, so reading it first would resurrect a finished subscription into a
 * granting state.
 */
export function stripeSubscriptionStatus(status: string, cancelAtPeriodEnd: boolean): PurchaseStatus {
  const mapped = SUBSCRIPTION_STATUSES[status];
  if (mapped === undefined) {
    // Stripe could add a status, and the only safe answer to one we have never seen is to project nothing.
    throw new PaymentsVerificationFailedError({
      detail: `Stripe: subscription status "${status}" is not one this build maps. The purchase was left as it stood.`,
    });
  }
  return cancelAtPeriodEnd && mapped === "active" ? "canceled" : mapped;
}

/** One Stripe subscription, normalized. */
export function mapStripeSubscription(subscription: StripeSubscription, eventAt: Date): StripeMappedEvent {
  const item = subscription.items.data[0] as z.infer<typeof StripeSubscriptionItem>;
  const status = stripeSubscriptionStatus(subscription.status, subscription.cancel_at_period_end === true);
  const currency = item.price.currency ?? subscription.currency ?? null;
  const periodEnd = item.current_period_end ?? subscription.current_period_end ?? null;
  const periodStart = item.current_period_start ?? subscription.current_period_start ?? null;

  return {
    event: {
      rail: "stripe",
      // The invoice, not the subscription: each billing period is its own row. See the module doc.
      providerTransactionId: subscription.latest_invoice ?? subscription.id,
      providerProductId: item.price.id,
      status,
      environment: environment(subscription.livemode),
      // The period this row is about, falling back to when the subscription began.
      purchasedAt: seconds(periodStart ?? subscription.start_date ?? subscription.created),
      expiresAt: periodEnd === null ? null : seconds(periodEnd),
      // A Stripe subscription has no refunded state — a refund is an invoice's business, and access is ended by
      // cancelling. So nothing on this path is a revocation, and dating one would be inventing it.
      revokedAt: null,
      originalTransactionId: subscription.id,
      amountMinor: minorUnits(item.price.unit_amount ?? null, currency),
      currency,
      providerEventAt: eventAt,
      payload: subscription as Record<string, unknown>,
    },
    providerAccountId: subscription.customer ?? null,
    accountReference: reference(subscription.metadata),
    note: null,
  };
}

/** What a session mapping needs beyond the object: whose clock timed it, and any status the type overrides. */
export interface StripeSessionOptions {
  /**
   * Stripe's own timestamp for the event that carried this session, or **null on a retrieve** — a retrieve is
   * not an event and Stripe times it with nothing. Null is what makes the mapping derive a date instead of
   * being handed one; see {@link retrievedAt}.
   */
  eventAt: Date | null;
  /** The clock. It dates what a retrieve *found*, and never a snapshot's claim to access. */
  now: Date;
  /** A status the event type knows and the object does not — an async payment that failed. */
  statusOverride?: PurchaseStatus | null;
}

/** One Checkout Session, normalized. Returns no event for the shapes that bought nothing here. */
export function mapStripeSession(session: StripeCheckoutSession, options: StripeSessionOptions): StripeMappedEvent {
  const providerAccountId = session.customer ?? null;
  const accountReference = session.client_reference_id ?? reference(session.metadata);
  const link = { providerAccountId, accountReference, note: null };

  if (session.mode === "subscription") {
    // Expanded on the retrieve path, a bare id on the webhook path. Unexpanded is not a gap: the subscription's
    // own events carry the state, and this session's job was to pair the customer with the purchaser.
    if (typeof session.subscription !== "object" || session.subscription === null) return { event: null, ...link };
    // The clock is honest here, and this is the one asymmetry with a one-time session: Stripe expands the
    // subscription *object*, whose `status` is what it is right now, so a read is the freshest fact anyone holds.
    const mapped = mapStripeSubscription(session.subscription, options.eventAt ?? options.now);
    // The session's reference wins: it is the one this deployment set for this checkout.
    return { ...mapped, providerAccountId: providerAccountId ?? mapped.providerAccountId, accountReference };
  }

  // A `setup` session stores a card and buys nothing. Nothing to project, and nothing missing.
  if (session.mode !== "payment") return { event: null, ...link };

  const priceId = session.line_items?.data[0]?.price?.id ?? session.metadata?.[STRIPE_METADATA_PRICE];
  const intent = session.payment_intent ?? null;
  const transactionId = (typeof intent === "string" ? intent : intent?.id) ?? session.id;
  if (priceId === undefined) {
    return {
      event: null,
      ...link,
      note: `stripe: Checkout Session ${session.id} (payment intent ${transactionId}) names no price — it carries no ${STRIPE_METADATA_PRICE} metadata and no expanded line items, so it was not created by this deployment.`,
    };
  }

  // The charge, when a retrieve expanded it. `payment_status` says `paid` for ever whatever became of the money;
  // the charge is the only object on this path that knows about a refund.
  const charge = typeof intent === "object" && typeof intent?.latest_charge === "object" ? intent.latest_charge : null;
  const refunded = charge !== null && chargeIsRefunded(charge);
  const status = options.statusOverride ?? (refunded ? "refunded" : sessionStatus(session.payment_status ?? null));
  const currency = session.currency ?? null;

  return {
    event: {
      rail: "stripe",
      // The payment intent, not the session: a refund names the payment intent and nothing else.
      providerTransactionId: transactionId,
      providerProductId: priceId,
      status,
      environment: environment(session.livemode),
      purchasedAt: seconds(session.created),
      // A one-time purchase never lapses. That is the whole difference between it and a subscription.
      expiresAt: null,
      // Stripe does not date a refund on the charge. When we found one on a read, now is when we learned of it.
      revokedAt: refunded ? (options.eventAt ?? options.now) : null,
      originalTransactionId: null,
      amountMinor: minorUnits(session.amount_total ?? null, currency),
      currency,
      providerEventAt: options.eventAt ?? retrievedAt(session, charge, status, options.now),
      payload: session as Record<string, unknown>,
    },
    ...link,
  };
}

/**
 * The provider event time for a one-time session **a retrieve found**, where Stripe timed nothing.
 *
 * A completed Checkout Session is a frozen snapshot: `payment_status` reads `paid` for ever, refund or no
 * refund, and Stripe expands nothing about a refund unless asked. Dating that snapshot with our clock is what
 * let a buyer re-post the `cs_…` id from her success URL after a refund had landed — the session names her, so
 * every owner check passes — and outrank the refund under the monotonic write rule, re-granting for good.
 *
 * So the rule splits on what the snapshot claims. **A claim to access is dated by Stripe's own clock**: the
 * charge that moved the money, or failing that the session's creation. Such a date cannot beat a refund that
 * followed it, by construction. **Anything that claims nothing is dated now**, because a status that grants
 * nothing can resurrect nothing, and a refund we found on the read must be able to land on a row the
 * completion webhook already wrote at the same second the charge carries.
 */
function retrievedAt(
  session: StripeCheckoutSession,
  charge: StripeCharge | null,
  status: PurchaseStatus,
  now: Date,
): Date {
  if (!ACCESS_GRANTING_STATUSES.has(status)) return now;
  return seconds(charge?.created ?? session.created);
}

/** One refunded charge, normalized onto the purchase its payment intent bought. */
export function mapStripeCharge(charge: StripeCharge, options: { eventAt: Date }): StripeMappedEvent {
  const link = { providerAccountId: charge.customer ?? null, accountReference: reference(charge.metadata) };

  if (charge.payment_intent === null || charge.payment_intent === undefined) {
    // Nothing identifies which purchase this refunds. A charge with no payment intent predates Payment Intents
    // or was created directly, and neither is a purchase this package made.
    return {
      event: null,
      ...link,
      note: `stripe: charge ${charge.id} names no payment intent, so there is no purchase row it can be matched to.`,
    };
  }

  const priceId = charge.metadata?.[STRIPE_METADATA_PRICE];
  if (priceId === undefined) {
    // The bounded gap, recorded rather than guessed. The purchase row is already keyed on the payment intent, so
    // the reconciliation pass finds it from this note with one query.
    return {
      event: null,
      ...link,
      note: `stripe: charge ${charge.id} carries no ${STRIPE_METADATA_PRICE} metadata, so the refund of payment intent ${charge.payment_intent} could not be projected.`,
    };
  }

  const refunded = chargeIsRefunded(charge);
  const currency = charge.currency ?? null;

  return {
    event: {
      rail: "stripe",
      providerTransactionId: charge.payment_intent,
      providerProductId: priceId,
      status: refunded ? "refunded" : "active",
      environment: environment(charge.livemode),
      purchasedAt: seconds(charge.created),
      expiresAt: null,
      // Stripe dates a refund by the event that reported it; the charge's own `created` is when it was paid.
      revokedAt: refunded ? options.eventAt : null,
      originalTransactionId: null,
      amountMinor: minorUnits(charge.amount ?? null, currency),
      currency,
      providerEventAt: options.eventAt,
      payload: charge as Record<string, unknown>,
    },
    ...link,
    note: null,
  };
}

/**
 * One Stripe event, mapped — the whole of "which event types this build acts on", in one place.
 *
 * An unhandled type produces nothing at all, with no note: `invoice.paid` and its neighbours are authentic and
 * duplicate what the subscription events already report, so throwing would make Stripe retry forever and a note
 * would fill the table with rows nobody acts on. The delivery is still recorded — that is the guard's job — so a
 * reconciliation pass can see everything that arrived.
 */
export function mapStripeEvent(event: StripeEvent): StripeMappedEvent {
  const eventAt = seconds(event.created);
  if (!HANDLED_TYPES.has(event.type)) {
    return { event: null, providerAccountId: null, accountReference: null, note: null };
  }

  if (event.type === "charge.refunded") {
    return mapStripeCharge(parseObject(StripeCharge, event, "a charge"), { eventAt });
  }

  if (event.type.startsWith("customer.subscription.")) {
    return mapStripeSubscription(parseObject(StripeSubscription, event, "a subscription"), eventAt);
  }

  return mapStripeSession(parseObject(StripeCheckoutSession, event, "a Checkout Session"), {
    eventAt,
    now: eventAt,
    // The one type whose meaning is not in the object: Stripe reports a failed asynchronous payment by event
    // type, leaving `payment_status` exactly as it was. `never_paid`, not `expired` — the debit bounced, so no
    // money ever cleared and a `grants` clause must not credit it.
    statusOverride: event.type === "checkout.session.async_payment_failed" ? "never_paid" : null,
  });
}

/**
 * Whether money went back on this charge. A part-refunded purchase is one somebody got money back for: access
 * is not divisible, and the catalog's clawback policy is what decides whether a balance follows.
 *
 * One predicate for both paths — the `charge.refunded` event and the charge a retrieve expanded — because a
 * refund that one path recognised and the other did not is a purchase whose access depends on which delivery
 * arrived first.
 */
function chargeIsRefunded(charge: StripeCharge): boolean {
  return charge.refunded === true || (charge.amount_refunded ?? 0) > 0;
}

/** A one-time session's status, from whether the money actually moved. */
function sessionStatus(paymentStatus: string | null): PurchaseStatus {
  // `unpaid` is a bank debit or a voucher still settling — days, sometimes. It has not been bought yet, but it
  // still might be, which is what `on_hold` says.
  return paymentStatus === "paid" || paymentStatus === "no_payment_required" ? "active" : "on_hold";
}

/** Parse an event's object against the schema its type promises, or refuse the delivery. */
function parseObject<T extends z.ZodType>(schema: T, event: StripeEvent, what: string): z.output<T> {
  const parsed = schema.safeParse(event.data.object);
  if (!parsed.success) {
    // Never echo the object: it is a customer's purchase, and it carries their Stripe identifiers.
    throw new PaymentsVerificationFailedError({
      detail: `Stripe: the object on ${event.type} is not ${what} — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ")}.`,
    });
  }
  return parsed.data as z.output<T>;
}

/** `livemode` is the whole environment decision. Anything but a live object is sandbox. */
function environment(livemode: boolean | undefined): PurchaseEnvironment {
  return livemode === true ? "production" : "sandbox";
}

/** One Stripe timestamp — seconds since the epoch — as a `Date`. */
function seconds(value: number): Date {
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    // An Invalid Date encodes as NaN and loses every comparison the monotonic write rule makes.
    throw new PaymentsVerificationFailedError({ detail: `Stripe: ${value} is not a timestamp in seconds.` });
  }
  return date;
}

/** An amount Stripe reported, in minor units. Stripe already reports minor units; the exponent guards the rest. */
function minorUnits(amount: number | null, currency: string | null): number | null {
  if (currency === null) return null;
  return minorUnitsFromScaled(amount, 10 ** minorUnitDigits(currency), currency);
}

/** The account reference this deployment stamped, or null. */
function reference(metadata: Record<string, string> | null | undefined): string | null {
  return metadata?.[STRIPE_METADATA_ACCOUNT_REFERENCE] ?? null;
}
