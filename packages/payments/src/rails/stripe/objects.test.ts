import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import chargeRefunded from "./fixtures/event-charge-refunded.json" with { type: "json" };
import invoicePaid from "./fixtures/event-invoice-paid.json" with { type: "json" };
import sessionPayment from "./fixtures/event-session-completed-payment.json" with { type: "json" };
import sessionSubscription from "./fixtures/event-session-completed-subscription.json" with { type: "json" };
import subscriptionCanceled from "./fixtures/event-subscription-canceled.json" with { type: "json" };
import subscriptionCreated from "./fixtures/event-subscription-created.json" with { type: "json" };
import subscriptionDeleted from "./fixtures/event-subscription-deleted.json" with { type: "json" };
import {
  mapStripeCharge,
  mapStripeEvent,
  mapStripeSession,
  mapStripeSubscription,
  STRIPE_METADATA_ACCOUNT_REFERENCE,
  STRIPE_METADATA_PRICE,
  StripeCharge,
  StripeCheckoutSession,
  StripeEvent,
  StripeSubscription,
  stripeSubscriptionStatus,
} from "./objects";

/** The event's own `created`, which is the provider event time the monotonic write rule compares. */
const EVENT_AT = new Date("2026-01-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-02-01T00:00:00.000Z");

/** JSON imports are shared and frozen; a case that bends a nested field works on its own copy. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const event = (fixture: unknown) => StripeEvent.parse(clone(fixture));
const subscription = (overrides: Record<string, unknown> = {}) =>
  StripeSubscription.parse({ ...clone(subscriptionCreated).data.object, ...overrides });
const session = (fixture: unknown = sessionPayment, overrides: Record<string, unknown> = {}) =>
  StripeCheckoutSession.parse({ ...(clone(fixture) as { data: { object: object } }).data.object, ...overrides });
const charge = (overrides: Record<string, unknown> = {}) =>
  StripeCharge.parse({ ...clone(chargeRefunded).data.object, ...overrides });

/** The refusal a mapping produced. Fails the test when it did not refuse. */
function refusal(run: () => unknown): PithyError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("stripeSubscriptionStatus", () => {
  test("maps every status Stripe has", () => {
    const mapped = Object.fromEntries(
      ["trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"].map(
        (status) => [status, stripeSubscriptionStatus(status, false)],
      ),
    );
    expect(mapped).toEqual({
      // A trial grants: the subscriber has access, and `expiresAt` is what ends it.
      trialing: "active",
      active: "active",
      // Stripe is retrying the card and access is normally kept — that is what grace means.
      past_due: "in_grace",
      // Retries exhausted. Never grants.
      unpaid: "on_hold",
      canceled: "expired",
      // The first payment never completed, so nothing was ever bought.
      incomplete: "on_hold",
      // And it never will: the window closed with no charge, so this is `never_paid`, not `expired`. The
      // difference is what stops a `grants` clause crediting a subscription nobody paid for.
      incomplete_expired: "never_paid",
      paused: "paused",
    });
  });

  test("auto-renew turned off is `canceled`, which still grants", () => {
    // The mapping most easily got wrong. Stripe keeps `status: active` and sets `cancel_at_period_end`; the
    // normalized `canceled` means exactly that — the next period was declined, this one was paid for.
    expect(stripeSubscriptionStatus("active", true)).toBe("canceled");
    expect(stripeSubscriptionStatus("trialing", true)).toBe("canceled");
  });

  test("a subscription already over stays over, whatever cancel_at_period_end says", () => {
    // `cancel_at_period_end` remains true on a subscription Stripe has since ended, so reading it first would
    // resurrect a finished subscription into a granting state.
    expect(stripeSubscriptionStatus("canceled", true)).toBe("expired");
    expect(stripeSubscriptionStatus("unpaid", true)).toBe("on_hold");
  });

  test("a status Stripe adds later is refused, never guessed", () => {
    // Guessing `active` grants on a state that might mean the opposite; guessing `expired` revokes a paying
    // subscriber. Refusing leaves the row as it stands and the delivery recorded.
    expect(refusal(() => stripeSubscriptionStatus("quantum_superposition", false)).payload.code).toBe(
      "payments/verification_failed",
    );
  });
});

describe("mapStripeSubscription", () => {
  test("keys the row on the invoice, and the family on the subscription", () => {
    // The invoice changes every billing period, so each period is its own purchase row — which is what makes a
    // `grants` clause fire per period, as it does for an Apple or Google renewal. The subscription id is the
    // family key, so a renewal's owner resolves through the purchase that started it.
    const mapped = mapStripeSubscription(subscription(), EVENT_AT);
    expect(mapped.event).toMatchObject({
      rail: "stripe",
      providerTransactionId: "in_1PithyAdaJan",
      originalTransactionId: "sub_1PithyAdaPro",
      providerProductId: "price_1Abc",
      status: "active",
      environment: "production",
      expiresAt: PERIOD_END,
      revokedAt: null,
      amountMinor: 999,
      currency: "usd",
      providerEventAt: EVENT_AT,
    });
    expect(mapped.providerAccountId).toBe("cus_PithyAda");
    expect(mapped.accountReference).toBe("ada");
    expect(mapped.note).toBeNull();
  });

  test("falls back to the subscription id when there is no invoice yet", () => {
    // A subscription can exist before its first invoice does. Keying it on the subscription is right — there is
    // no transaction to key it on — and the first invoice replaces the row on the same monotonic rule.
    expect(mapStripeSubscription(subscription({ latest_invoice: null }), EVENT_AT).event?.providerTransactionId).toBe(
      "sub_1PithyAdaPro",
    );
  });

  test("reads the period from the item, and from the subscription when an older API version sent it there", () => {
    // Stripe moved `current_period_end` from the subscription onto its items. A webhook endpoint pinned to an
    // older version still sends the old spelling, and both are the same fact.
    const legacy = subscription({
      current_period_start: 1767225600,
      current_period_end: 1769904000,
      items: { object: "list", data: [{ id: "si_1", object: "subscription_item", price: { id: "price_1Abc" } }] },
    });
    expect(mapStripeSubscription(legacy, EVENT_AT).event).toMatchObject({
      expiresAt: PERIOD_END,
      purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  test("a subscription with no period at all has no expiry", () => {
    const undated = subscription({
      items: { object: "list", data: [{ id: "si_1", object: "subscription_item", price: { id: "price_1Abc" } }] },
    });
    expect(mapStripeSubscription(undated, EVENT_AT).event?.expiresAt).toBeNull();
  });

  test("test mode is sandbox, so a test subscription never grants in production", () => {
    // Stripe's `livemode` is the whole environment decision, and this is the most common in-app-purchase defect
    // there is. A test-mode key produces `livemode: false` on every object it touches.
    expect(mapStripeSubscription(subscription({ livemode: false }), EVENT_AT).event?.environment).toBe("sandbox");
  });

  test("carries the whole subscription as the stored payload", () => {
    expect(mapStripeSubscription(subscription(), EVENT_AT).event?.payload).toMatchObject({ id: "sub_1PithyAdaPro" });
  });

  test("reports no price rather than a wrong one when Stripe sent no amount", () => {
    // A metered or tiered price has no `unit_amount`. Null is the honest answer and the columns are nullable for
    // exactly this; a zero would read as a free subscription in a revenue query.
    const metered = subscription({
      items: {
        object: "list",
        data: [
          {
            id: "si_1",
            object: "subscription_item",
            current_period_end: 1769904000,
            price: { id: "price_1Abc", currency: "usd" },
          },
        ],
      },
    });
    expect(mapStripeSubscription(metered, EVENT_AT).event).toMatchObject({ amountMinor: null, currency: "usd" });
  });

  test("converts through the currency's own exponent", () => {
    // ¥500 is 500 minor units, not 50000. Stripe reports minor units already, and the conversion is where a
    // zero-decimal currency would otherwise be multiplied by a hundred.
    const yen = subscription({
      currency: "jpy",
      items: {
        object: "list",
        data: [
          {
            id: "si_1",
            object: "subscription_item",
            current_period_end: 1769904000,
            price: { id: "price_1Abc", currency: "jpy", unit_amount: 500 },
          },
        ],
      },
    });
    expect(mapStripeSubscription(yen, EVENT_AT).event).toMatchObject({ amountMinor: 500, currency: "jpy" });
  });
});

describe("mapStripeSession", () => {
  test("a paid one-time session is keyed on its payment intent", () => {
    // The payment intent, not the session: a later `charge.refunded` names the payment intent and nothing else,
    // so keying the row on it is what makes the refund land on the purchase it refunds.
    const mapped = mapStripeSession(session(), { eventAt: EVENT_AT, now: EVENT_AT });
    expect(mapped.event).toMatchObject({
      rail: "stripe",
      providerTransactionId: "pi_1PithyCoins",
      providerProductId: "price_1Coins",
      status: "active",
      // A one-time purchase never lapses. That is the whole difference from a subscription.
      expiresAt: null,
      originalTransactionId: null,
      amountMinor: 499,
      currency: "usd",
    });
    expect(mapped.providerAccountId).toBe("cus_PithyAda");
    expect(mapped.accountReference).toBe("ada");
  });

  test("prefers an expanded line item's price over the one we stamped", () => {
    // On a retrieve we can expand line items, so the price comes from Stripe rather than from our own metadata.
    // Metadata is the webhook path's only option — a session payload carries no line items.
    const expanded = session(sessionPayment, {
      line_items: { object: "list", data: [{ id: "li_1", price: { id: "price_fromStripe" } }] },
    });
    expect(mapStripeSession(expanded, { eventAt: EVENT_AT, now: EVENT_AT }).event?.providerProductId).toBe(
      "price_fromStripe",
    );
  });

  test("an unpaid async session is on_hold, not active", () => {
    // A bank debit completes days later. Granting on `completed` would hand out a product before the money moved.
    expect(
      mapStripeSession(session(sessionPayment, { payment_status: "unpaid" }), { eventAt: EVENT_AT, now: EVENT_AT })
        .event,
    ).toMatchObject({ status: "on_hold" });
  });

  test("a session needing no payment grants", () => {
    expect(
      mapStripeSession(session(sessionPayment, { payment_status: "no_payment_required" }), {
        eventAt: EVENT_AT,
        now: EVENT_AT,
      }).event,
    ).toMatchObject({ status: "active" });
  });

  test("an override wins, which is how a failed async payment is recorded", () => {
    const mapped = mapStripeSession(session(sessionPayment, { payment_status: "unpaid" }), {
      eventAt: EVENT_AT,
      now: EVENT_AT,
      statusOverride: "never_paid",
    });
    expect(mapped.event?.status).toBe("never_paid");
  });

  test("a one-time session with no price anywhere is recorded with its reason", () => {
    // A session created outside Pithy — a dashboard Payment Link — carries neither our metadata nor line items.
    // Authentic, unresolvable, and repairable from the recorded note rather than dropped.
    const bare = session(sessionPayment, { metadata: {} });
    const mapped = mapStripeSession(bare, { eventAt: EVENT_AT, now: EVENT_AT });
    expect(mapped.event).toBeNull();
    expect(mapped.note).toContain("pi_1PithyCoins");
    expect(mapped.note).toContain(STRIPE_METADATA_PRICE);
    // The link fields still travel: the session named a customer and a reference, and both are worth binding.
    expect(mapped.providerAccountId).toBe("cus_PithyAda");
    expect(mapped.accountReference).toBe("ada");
  });

  test("a subscription-mode session reports the link and no transaction", () => {
    // The subscription events carry the state; this session's job is to pair `cus_…` with the user we sent to
    // Checkout. No note, because nothing is missing — this is the normal flow.
    const mapped = mapStripeSession(session(sessionSubscription), { eventAt: EVENT_AT, now: EVENT_AT });
    expect(mapped.event).toBeNull();
    expect(mapped.note).toBeNull();
    expect(mapped.providerAccountId).toBe("cus_PithyAda");
    expect(mapped.accountReference).toBe("ada");
  });

  test("a subscription-mode session with the subscription expanded projects it", () => {
    // The client-submission path: one retrieve with `expand[]=subscription` gives the buyer their entitlement
    // without waiting for a webhook.
    const expanded = session(sessionSubscription, { subscription: clone(subscriptionCreated).data.object });
    const mapped = mapStripeSession(expanded, { eventAt: EVENT_AT, now: EVENT_AT });
    expect(mapped.event).toMatchObject({ providerTransactionId: "in_1PithyAdaJan", status: "active" });
    // The reference on the session wins: it is the one this deployment set for this checkout.
    expect(mapped.accountReference).toBe("ada");
  });

  test("a subscription-mode retrieve is dated by the clock, because the expanded subscription is live state", () => {
    // The asymmetry with a one-time session is deliberate. Stripe expands the subscription object itself, and
    // its `status` is what it is right now — so the read is the freshest fact anyone holds, and dating it older
    // would make a submission lose to a notification it is genuinely newer than. A Checkout Session is frozen.
    const expanded = session(sessionSubscription, { subscription: clone(subscriptionCreated).data.object });
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(mapStripeSession(expanded, { eventAt: null, now }).event?.providerEventAt).toEqual(now);
  });

  test("a setup-mode session buys nothing and says nothing", () => {
    const mapped = mapStripeSession(session(sessionPayment, { mode: "setup", payment_intent: null }), {
      eventAt: EVENT_AT,
      now: EVENT_AT,
    });
    expect(mapped.event).toBeNull();
    expect(mapped.note).toBeNull();
  });

  test("falls back to our metadata for the reference when Stripe carried no client_reference_id", () => {
    // Stripe drops `client_reference_id` from some flows; the metadata copy is stamped by the same call.
    const mapped = mapStripeSession(session(sessionPayment, { client_reference_id: null }), {
      eventAt: EVENT_AT,
      now: EVENT_AT,
    });
    expect(mapped.accountReference).toBe("ada");
  });

  test("a retrieve dates the snapshot by Stripe's clock, so it cannot outrank a refund it predates", () => {
    // A completed Checkout Session is immutable: `payment_status` reads `paid` for ever, refund or no refund.
    // Dating it with our clock is what let a re-posted `cs_…` id beat the refund that had already landed and
    // re-grant the purchase permanently. There is no event on a retrieve, so the purchase's own time dates it.
    const mapped = mapStripeSession(session(), { eventAt: null, now: new Date("2026-06-01T00:00:00.000Z") });
    expect(mapped.event).toMatchObject({ status: "active", providerEventAt: EVENT_AT });
  });

  test("a retrieve prefers the charge's own time, which is when the money actually moved", () => {
    // A delayed payment method settles days after the session was created, and the charge is the only object
    // that dates it. Reading the session's `created` alone would date the payment before it happened.
    const settled = session(sessionPayment, {
      payment_intent: {
        id: "pi_1PithyCoins",
        object: "payment_intent",
        created: 1767830400,
        latest_charge: { id: "ch_1PithyCoins", object: "charge", created: 1767830400, refunded: false },
      },
    });
    const mapped = mapStripeSession(settled, { eventAt: null, now: new Date("2026-06-01T00:00:00.000Z") });
    expect(mapped.event).toMatchObject({
      providerTransactionId: "pi_1PithyCoins",
      status: "active",
      providerEventAt: new Date("2026-01-08T00:00:00.000Z"),
    });
  });

  test("a retrieve reads the refund off the expanded charge — the session itself never mentions one", () => {
    // The half that makes the answer correct rather than merely stale-proof: `payment_status` is refund-blind,
    // so a refund whose `charge.refunded` delivery was lost would read as `active` from this path for ever.
    const refunded = session(sessionPayment, {
      payment_intent: {
        id: "pi_1PithyCoins",
        object: "payment_intent",
        created: 1767225600,
        latest_charge: clone(chargeRefunded).data.object,
      },
    });
    const now = new Date("2026-06-01T00:00:00.000Z");
    const mapped = mapStripeSession(refunded, { eventAt: null, now });
    expect(mapped.event).toMatchObject({
      providerTransactionId: "pi_1PithyCoins",
      status: "refunded",
      // News of a revocation is dated when we learned it. It can resurrect nothing, and dating it at the charge
      // would let the monotonic rule discard the repair.
      revokedAt: now,
      providerEventAt: now,
    });
  });

  test("a partial refund on the expanded charge is a refund here too", () => {
    const partial = session(sessionPayment, {
      payment_intent: {
        id: "pi_1PithyCoins",
        object: "payment_intent",
        latest_charge: { id: "ch_1PithyCoins", object: "charge", created: 1767225600, amount_refunded: 100 },
      },
    });
    expect(mapStripeSession(partial, { eventAt: null, now: EVENT_AT }).event?.status).toBe("refunded");
  });

  test("an expanded payment intent with nothing refunded still grants, and still keys on the intent", () => {
    const paid = session(sessionPayment, {
      payment_intent: {
        id: "pi_1PithyCoins",
        object: "payment_intent",
        latest_charge: { id: "ch_1PithyCoins", object: "charge", created: 1767225600, refunded: false },
      },
    });
    expect(mapStripeSession(paid, { eventAt: EVENT_AT, now: EVENT_AT }).event).toMatchObject({
      providerTransactionId: "pi_1PithyCoins",
      status: "active",
      revokedAt: null,
    });
  });

  test("a webhook's own event time still dates the row, however the session is expanded", () => {
    // Stripe timed that delivery, so there is nothing to derive. Deriving one anyway would date every async
    // payment at the session that opened it, and the second delivery would lose to the first.
    const mapped = mapStripeSession(session(), { eventAt: PERIOD_END, now: EVENT_AT });
    expect(mapped.event?.providerEventAt).toEqual(PERIOD_END);
  });

  test("a session with no customer at all still projects", () => {
    // `customer_creation` is a Stripe setting, and a one-time session can complete without one. The row is owned
    // through the reference instead.
    const mapped = mapStripeSession(session(sessionPayment, { customer: null }), { eventAt: EVENT_AT, now: EVENT_AT });
    expect(mapped.providerAccountId).toBeNull();
    expect(mapped.event?.providerTransactionId).toBe("pi_1PithyCoins");
  });
});

describe("mapStripeCharge", () => {
  test("a refunded charge revokes the purchase its payment intent bought", () => {
    const mapped = mapStripeCharge(charge(), { eventAt: EVENT_AT });
    expect(mapped.event).toMatchObject({
      providerTransactionId: "pi_1PithyCoins",
      providerProductId: "price_1Coins",
      status: "refunded",
      // Stripe dates the refund by the event; the charge's own `created` is when it was paid.
      revokedAt: EVENT_AT,
      purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
      amountMinor: 499,
    });
    expect(mapped.accountReference).toBe("ada");
  });

  test("a partial refund is a refund", () => {
    // Access is not divisible. A part-refunded purchase is one somebody got money back for, and the clawback
    // policy decides what that means for a balance.
    expect(
      mapStripeCharge(charge({ refunded: false, amount_refunded: 100 }), { eventAt: EVENT_AT }).event,
    ).toMatchObject({ status: "refunded" });
  });

  test("a charge with nothing refunded is not a refund", () => {
    expect(mapStripeCharge(charge({ refunded: false, amount_refunded: 0 }), { eventAt: EVENT_AT }).event).toMatchObject(
      {
        status: "active",
        revokedAt: null,
      },
    );
  });

  test("a charge with no payment intent is recorded with its reason", () => {
    // Nothing identifies which purchase it refunds, so there is nothing to project and nothing to guess.
    const mapped = mapStripeCharge(charge({ payment_intent: null }), { eventAt: EVENT_AT });
    expect(mapped.event).toBeNull();
    expect(mapped.note).toContain("ch_1PithyCoins");
  });

  test("a charge with no price in its metadata is recorded with the id that repairs it", () => {
    // The bounded gap. The purchase row is already keyed on the payment intent, so the reconciliation pass reads
    // the note, finds the row, and projects the refund with one query.
    const mapped = mapStripeCharge(charge({ metadata: {} }), { eventAt: EVENT_AT });
    expect(mapped.event).toBeNull();
    expect(mapped.note).toContain("pi_1PithyCoins");
  });
});

describe("mapStripeEvent", () => {
  test("dispatches the event types this build handles", () => {
    const cases: [unknown, string | null, string | null][] = [
      [subscriptionCreated, "in_1PithyAdaJan", "active"],
      [subscriptionCanceled, "in_1PithyAdaJan", "canceled"],
      [subscriptionDeleted, "in_1PithyAdaJan", "expired"],
      [sessionPayment, "pi_1PithyCoins", "active"],
      [chargeRefunded, "pi_1PithyCoins", "refunded"],
      [sessionSubscription, null, null],
    ];
    for (const [fixture, transactionId, status] of cases) {
      const mapped = mapStripeEvent(event(fixture));
      expect(mapped.event?.providerTransactionId ?? null, String(transactionId)).toBe(transactionId);
      expect(mapped.event?.status ?? null).toBe(status);
    }
  });

  test("a failed asynchronous payment is `never_paid`, not `expired`", () => {
    // Stripe reports this one by event type and leaves `payment_status` exactly as it was. `expired` would say a
    // period we were paid for has ended, and a `grants` clause credits on that — so a bank debit that bounced
    // would hand out the coin pack it never paid for, with no refund ever to claw it back.
    const failed = { ...event(sessionPayment), type: "checkout.session.async_payment_failed" };
    expect(mapStripeEvent(failed).event?.status).toBe("never_paid");
  });

  test("takes the provider event time from the event, not from the object", () => {
    // Stripe's own clock, per delivery. The object's `created` is when the subscription began, which would make
    // every later event look staler than the first one and lose to it under the monotonic rule.
    expect(mapStripeEvent(event(subscriptionDeleted)).event?.providerEventAt).toEqual(
      new Date("2026-02-01T00:00:00.000Z"),
    );
  });

  test("an event type this build does not handle changes nothing and says nothing", () => {
    // `invoice.paid` is authentic and duplicates what the subscription events already report. Throwing on it
    // would make Stripe retry a delivery forever; a note would fill the table with rows nobody acts on.
    expect(mapStripeEvent(event(invoicePaid))).toEqual({
      event: null,
      providerAccountId: null,
      accountReference: null,
      note: null,
    });
  });

  test("an event whose object is not the shape its type promises is refused", () => {
    // Authentic bytes whose contents we cannot read. The guard turns this into a 401 rather than projecting a
    // half-parsed subscription.
    const broken = event(subscriptionCreated);
    expect(
      refusal(() => mapStripeEvent({ ...broken, data: { object: { id: "sub_1", object: "subscription" } } })).payload
        .code,
    ).toBe("payments/verification_failed");
  });

  test("the metadata keys are constants, so the writer and the reader cannot drift", () => {
    expect(STRIPE_METADATA_ACCOUNT_REFERENCE).toBe("pithy_account_reference");
    expect(STRIPE_METADATA_PRICE).toBe("pithy_price_id");
  });
});
