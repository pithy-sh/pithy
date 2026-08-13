// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurchaseEnvironment } from "../../data/purchase";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { UnboundProviderEvent, VerifiedNotification, WebhookDelivery } from "../contract";
import type { PaddleEnvironment } from "./api";
import {
  accountReferenceOf,
  at,
  fencedOut,
  minorAmount,
  PaddleAdjustment,
  PaddleEvent,
  PaddleSubscription,
  PaddleTransaction,
  subscriptionEvent,
  transactionEvent,
} from "./objects";
import { PADDLE_SIGNATURE_HEADER, verifyPaddleSignature } from "./signature";

/**
 * Verify and read one Paddle delivery, and the event map that decides what it projects.
 *
 * ## The event id is Paddle's own, and it is the key both paths share
 *
 * `evt_…`, straight off the envelope and inside the signed bytes. `UNIQUE (rail, providerEventId)` in the
 * webhook guard is what makes a redelivery recognized rather than reprocessed, and Paddle retries — three
 * times over fifteen minutes in sandbox, sixty times over three days live, confirmed in the docs.
 *
 * It is deliberately the same id the **events sweep** reads. Paddle's `/events` stream carries `event_id`
 * and no `notification_id`, so the id a swept event reports and the id its webhook reported are the same
 * string — which is what makes the sweep a repair rather than a second source of duplicate rows.
 *
 * A **replay** through Paddle's own replay endpoint creates a new *notification* against the same
 * `event_id`, so it collides here too, which is correct: it is the same event.
 *
 * ## Recording is not projecting
 *
 * Every authentic delivery is recorded, whatever it is. What differs is what it projects, and the answer
 * for most event types is nothing. An event type Paddle ships after this package did is authentic,
 * recorded, projects nothing, and returns 200 — never a throw, because Paddle would redeliver it for
 * three days.
 *
 * ## Adjustments, and why this rail is different
 *
 * As merchant of record Paddle issues refunds on its own account — for a chargeback, a tax dispute, or
 * its own support decision. A refund therefore arrives **unsolicited**, with no local write preceding it.
 * Every other rail in this package but Lemon Squeezy only ever sees refunds it initiated.
 *
 * A full refund revokes; a **partial** one records a note and revokes nothing, because a customer who got
 * half their money back has not lost what they bought. That comparison is against the transaction's own
 * grand total, which the adjustment does not carry — so a partial refund costs one read of the
 * transaction, and a read that fails is `payments/provider_unavailable`, which the guard passes through
 * so Paddle redelivers rather than the operator hunting for a rotated key.
 */

/** What the parser needs: the credentials, the deployment asking, the account, and the freshness window. */
export interface ParsePaddleNotificationOptions {
  /** The rail's credentials. The signing secret is read from here and never logged. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account this deployment sells through. Decides every purchase's `environment`. */
  environment: PaddleEnvironment;
  /** The clock, for the signature's freshness window. */
  now: Date;
  /** This deployment's `ENVIRONMENT`, for the shared-sandbox fence. */
  deployment?: string;
  /** How many seconds either side of `now` a delivery may be dated. Undefined uses the rail's default. */
  freshnessSeconds?: number;
  /**
   * The transaction this adjustment adjusts, or `undefined` when Paddle no longer knows it.
   *
   * Supplied by the rail, which owns the transport. It exists because an adjustment says how much came
   * off and never what the original was, and "full refund" is a comparison against the original.
   */
  readTransaction?: (transactionId: string) => Promise<PaddleTransaction | undefined>;
}

/**
 * Which environment a purchase belongs to.
 *
 * The **account**, not a field on the payload. Paddle Billing partitions sandbox from live by account —
 * separate host, separate key, separate destinations — so there is nothing in a delivery that could
 * contradict this, and the issue's `data.mode` does not exist (on a discount, `mode` means
 * `standard`/`custom`). A sandbox-configured deployment therefore never writes a production row, and the
 * projection writer's own environment check does the rest.
 */
function environmentOf(account: PaddleEnvironment): PurchaseEnvironment {
  return account === "production" ? "production" : "sandbox";
}

/** Every transaction-domain event this build maps, and whether it says anything about money. */
const TRANSACTION_EVENTS: ReadonlySet<string> = new Set([
  "transaction.paid",
  "transaction.completed",
  "transaction.payment_failed",
  "transaction.past_due",
  "transaction.canceled",
  "transaction.updated",
  "transaction.revised",
  "transaction.billed",
]);

/**
 * Transaction events that project nothing at all, however well-formed.
 *
 * `transaction.created` and `transaction.ready` describe a transaction that exists and has taken no
 * money. Projecting one would write an `on_hold` row for every abandoned checkout — noise the reconcile
 * pass then re-reads forever.
 */
const TRANSACTION_EVENTS_WITHOUT_STATE: ReadonlySet<string> = new Set(["transaction.created", "transaction.ready"]);

/** Every subscription-domain event: the standing changed, and no money moved. */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.resumed",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.canceled",
  "subscription.updated",
  "subscription.imported",
]);

/** Every adjustment-domain event: money going back, on Paddle's own initiative. */
const ADJUSTMENT_EVENTS: ReadonlySet<string> = new Set(["adjustment.created", "adjustment.updated"]);

/**
 * The adjustment actions that revoke an entitlement when approved, and the ones that do not.
 *
 * `chargeback_warning` and its **reverse** are both here as stated rows rather than as an omission — the
 * live `action` enum carries `chargeback_warning_reverse`, which the issue's table does not name. A
 * warning is a notice that a dispute has been opened, not a decision, so neither moves anything. A
 * `credit` against a balance is not a revocation either.
 */
const REVOKING_ACTIONS: ReadonlySet<string> = new Set(["refund", "chargeback"]);

/** The adjustment actions that restore what a revocation took. */
const RESTORING_ACTIONS: ReadonlySet<string> = new Set(["chargeback_reverse"]);

/** Nothing at all was learned, but the delivery was authentic. */
function nothing(event: PaddleEvent, note?: string): VerifiedNotification {
  return {
    providerEventId: event.event_id,
    payload: { ...event },
    event: null,
    providerAccountId: null,
    accountReference: null,
    // Null unless a caller supplied one: a note routes the route into an audit warning, and a delivery
    // that is simply not ours — or an event type shipped after this package — is not worth warning about.
    note: note ?? null,
  };
}

/** Verify a delivery's signature and read what it says. */
export async function parsePaddleNotification(
  delivery: WebhookDelivery,
  options: ParsePaddleNotificationOptions,
): Promise<VerifiedNotification> {
  await verifyPaddleSignature(delivery.body, delivery.headers.get(PADDLE_SIGNATURE_HEADER), {
    secret: options.credentials.webhookSecret,
    now: options.now,
    toleranceSeconds: options.freshnessSeconds,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(delivery.body) as unknown;
  } catch (cause) {
    throw new PaymentsVerificationFailedError({ detail: "Paddle: the delivery body is not JSON." }, { cause });
  }

  const envelope = PaddleEvent.safeParse(parsed);
  if (!envelope.success) {
    throw new PaymentsVerificationFailedError({
      detail: "Paddle: the delivery is not an event envelope — no event_id, event_type, occurred_at, or data.",
    });
  }
  return await readPaddleEvent(envelope.data, options);
}

/**
 * Read one authentic event — the whole map, shared by the webhook path and the events sweep.
 *
 * Shared deliberately. A sweep that projected through a second code path would be a second answer to
 * "what does this event mean", and the two would drift the first time a status was added.
 */
export async function readPaddleEvent(
  event: PaddleEvent,
  options: ParsePaddleNotificationOptions,
): Promise<VerifiedNotification> {
  const occurredAt = at(event.occurred_at, "an event's occurred_at");
  const environment = environmentOf(options.environment);
  const type = event.event_type;

  if (TRANSACTION_EVENTS_WITHOUT_STATE.has(type)) {
    // Authentic, recorded, and no money has moved. Deliberately checked before the fence: it projects
    // nothing either way, and both answers are the same row.
    return nothing(event);
  }

  if (TRANSACTION_EVENTS.has(type)) return await transactionNotification(event, occurredAt, environment, options);
  if (SUBSCRIPTION_EVENTS.has(type)) return await subscriptionNotification(event, occurredAt, environment, options);
  if (ADJUSTMENT_EVENTS.has(type)) return await adjustmentNotification(event, occurredAt, environment, options);

  // `customer.*`, `address.*`, `business.*`, `payment_method.*`, `price.*`, `product.*`, `discount.*`, and
  // a type Paddle ships after this package did. Authentic, recorded, projecting nothing. Never a throw:
  // Paddle would redeliver it for three days.
  return nothing(event);
}

/** A transaction-domain delivery: one money row. */
async function transactionNotification(
  event: PaddleEvent,
  occurredAt: Date,
  environment: PurchaseEnvironment,
  options: ParsePaddleNotificationOptions,
): Promise<VerifiedNotification> {
  const transaction = PaddleTransaction.parse(event.data);

  // Another deployment's buyer, on the sandbox we share with it. Authentic, recorded, none of our
  // business — no row, no entitlement, no audit warning, and a 200.
  if (fencedOut(transaction.custom_data, options.deployment)) return nothing(event);

  return {
    providerEventId: event.event_id,
    payload: { ...event },
    event: transactionEvent(transaction, occurredAt, environment),
    providerAccountId: transaction.customer_id ?? null,
    accountReference: await accountReferenceOf(
      transaction.custom_data,
      options.deployment,
      options.credentials.webhookSecret,
    ),
  };
}

/** A subscription-domain delivery: one state row. */
async function subscriptionNotification(
  event: PaddleEvent,
  occurredAt: Date,
  environment: PurchaseEnvironment,
  options: ParsePaddleNotificationOptions,
): Promise<VerifiedNotification> {
  const subscription = PaddleSubscription.parse(event.data);
  if (fencedOut(subscription.custom_data, options.deployment)) return nothing(event);

  return {
    providerEventId: event.event_id,
    payload: { ...event },
    event: subscriptionEvent(subscription, occurredAt, environment),
    providerAccountId: subscription.customer_id ?? null,
    // Paddle copies `custom_data` from the transaction that created the subscription onto the
    // subscription, so every later event in this domain carries the stamp too.
    accountReference: await accountReferenceOf(
      subscription.custom_data,
      options.deployment,
      options.credentials.webhookSecret,
    ),
  };
}

/**
 * An adjustment-domain delivery — a refund, a credit, or a chargeback.
 *
 * **The fence here is ownership of the row, not a stamp.** An adjustment carries no `custom_data` of
 * ours: Paddle raises it against a transaction, and the transaction is what this deployment either holds
 * or does not. So the transaction is read back, and one it cannot read is one this deployment has no
 * business acting on — recorded with a note, projecting nothing, on exactly the same path.
 */
async function adjustmentNotification(
  event: PaddleEvent,
  occurredAt: Date,
  environment: PurchaseEnvironment,
  options: ParsePaddleNotificationOptions,
): Promise<VerifiedNotification> {
  const adjustment = PaddleAdjustment.parse(event.data);

  // Only an approved adjustment acts. `pending_approval`, `rejected` and `reversed` are all authentic
  // statements that nothing has happened to the money yet, or that it will not.
  if (adjustment.status !== "approved") return nothing(event);

  const revoking = REVOKING_ACTIONS.has(adjustment.action);
  const restoring = RESTORING_ACTIONS.has(adjustment.action);
  // `credit`, `credit_reverse`, `chargeback_warning`, `chargeback_warning_reverse` — and any action
  // Paddle adds later. A credit against a balance is not a revocation, and a warning is not a decision.
  if (!revoking && !restoring) return nothing(event);

  const transaction = await options.readTransaction?.(adjustment.transaction_id);
  if (transaction === undefined) {
    // Either Paddle no longer knows the transaction, or it belongs to another deployment on this shared
    // sandbox. Authentic, unprojectable, and worth an operator's attention — so this is one of the two
    // places on this rail that sets a note.
    return nothing(
      event,
      `Paddle adjustment ${adjustment.id} names transaction ${adjustment.transaction_id}, which this deployment cannot read.`,
    );
  }
  if (fencedOut(transaction.custom_data, options.deployment)) return nothing(event);

  const base = transactionEvent(transaction, occurredAt, environment);

  if (restoring) {
    // A later `occurred_at` than the revocation it undoes, so the monotonic write rule lets it win.
    return projected(event, { ...base, revokedAt: null }, transaction.customer_id ?? null);
  }

  const total = minorAmount(transaction.details?.totals?.grand_total);
  const adjusted = minorAmount(adjustment.totals?.total);
  const full = total !== null && adjusted !== null && adjusted >= total;

  if (!full) {
    // A partial refund does not revoke. The entitlement stands, and the row says why.
    //
    // `total === null` lands here too, and deliberately: an amount this build could not read is not
    // evidence of a full refund, and revoking on an unreadable figure would take an entitlement away on
    // a guess. The note makes it repairable.
    return nothing(
      event,
      `Paddle adjustment ${adjustment.id} (${adjustment.action}) covers ${adjusted ?? "an unreadable amount"} of transaction ${adjustment.transaction_id}'s ${total ?? "unreadable"} total. Recorded; the entitlement stands.`,
    );
  }

  return projected(
    event,
    { ...base, status: "refunded", revokedAt: occurredAt, expiresAt: occurredAt },
    transaction.customer_id ?? null,
    // A refunded subscription period must also stop granting, and the money row cannot do it: the two are
    // different rows keyed on different ids, and `refunded` on a `txn_…` says nothing about `sub_…`. One
    // event without the other leaves a refunded subscriber holding the feature — the exact case the Lemon
    // Squeezy rail documents. `revoked` rather than `refunded`, because the *transaction* was refunded and
    // the subscription's standing was revoked as a consequence; a `state` row never claws back either way.
    revocationOf(base, occurredAt),
  );
}

/** The state event a full refund of a subscription's transaction implies, or null for a one-off. */
function revocationOf(charge: UnboundProviderEvent, occurredAt: Date): UnboundProviderEvent | null {
  const subscriptionId = charge.originalTransactionId;
  if (subscriptionId === null || subscriptionId === undefined) return null;
  return {
    ...charge,
    providerTransactionId: subscriptionId,
    originalTransactionId: subscriptionId,
    role: "state",
    status: "revoked",
    revokedAt: occurredAt,
    expiresAt: occurredAt,
    amountMinor: null,
    currency: null,
    // The refund's own clock, not the subscription's. The subscription object was last touched before the
    // refund happened, so its timestamp would be older than the row it is trying to move and the monotonic
    // rule would discard the revocation entirely.
    providerEventAt: occurredAt,
  };
}

/** One projected notification, with the reference read off the transaction that carried the stamp. */
function projected(
  event: PaddleEvent,
  projection: UnboundProviderEvent,
  customerId: string | null,
  stateEvent: UnboundProviderEvent | null = null,
): VerifiedNotification {
  return {
    providerEventId: event.event_id,
    payload: { ...event },
    event: projection,
    providerAccountId: customerId,
    // Deliberately not resolved here. An adjustment's owner is the row it adjusts, which this deployment
    // already holds and already bound; re-deriving it would be a second answer to a settled question.
    accountReference: null,
    stateEvent,
  };
}
