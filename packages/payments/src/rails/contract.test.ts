// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DiscountTerms } from "../data/discount";
import type { PaymentsPurchase } from "../data/purchase";
import { decodeSubjectReference, encodeSubjectReference } from "../data/subject";
import { SubscriptionChangeQuote, SubscriptionStanding } from "../data/subscription";
import { ProviderEvent } from "../projection/event";
import {
  type CheckoutRail,
  type DiscountRail,
  isCheckoutRail,
  isDiscountRail,
  isRefundRail,
  isSubscriptionRail,
  noteText,
  type PaymentsRailProvider,
  type RefundRail,
  type SubscriptionCancelInput,
  type SubscriptionChangeInput,
  type SubscriptionRail,
  type UnboundProviderEvent,
  type VerifiedNotification,
} from "./contract";

/**
 * The contract is mostly types, and types are checked by `tsc`. What is worth asserting at runtime is the
 * one place the types meet the database: an `UnboundProviderEvent` plus a subject must be exactly what the
 * projection writer accepts. If those two drift, every rail compiles and every projection fails.
 */

const MINIMAL: UnboundProviderEvent = {
  rail: "apple",
  providerTransactionId: "2000000731004811",
  providerProductId: "com.acme.pro.monthly",
  status: "active",
  environment: "production",
  purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
  providerEventAt: new Date("2026-01-01T00:00:00.000Z"),
  payload: { notificationType: "DID_RENEW" },
};

describe("UnboundProviderEvent", () => {
  test("plus a subject is a legal projection input, with the optional fields defaulting to null", () => {
    const event = ProviderEvent.parse({ ...MINIMAL, subjectType: "user", subjectId: "ada" });
    expect(event.subjectType).toBe("user");
    expect(event.subjectId).toBe("ada");
    // The rails leave these out when the store did not report them; the schema decides they are null rather
    // than each rail deciding separately.
    expect(event.expiresAt).toBeNull();
    expect(event.revokedAt).toBeNull();
    expect(event.originalTransactionId).toBeNull();
    expect(event.amountMinor).toBeNull();
    expect(event.currency).toBeNull();
  });

  test("an organization is as legal an owner as a person, and the pair says which", () => {
    // Both halves travel together, so nothing downstream has to consult config to read the row it was handed.
    const event = ProviderEvent.parse({ ...MINIMAL, subjectType: "organization", subjectId: "acme" });
    expect(event.subjectType).toBe("organization");
    expect(event.subjectId).toBe("acme");
  });

  test("half an owner is not an owner", () => {
    // The pair is the identity. An id with no kind would be matched against whichever kind the reader assumed,
    // and nothing keeps an organization id from equalling some user's.
    expect(ProviderEvent.safeParse({ ...MINIMAL, subjectId: "ada" }).success).toBe(false);
    expect(ProviderEvent.safeParse({ ...MINIMAL, subjectType: "user" }).success).toBe(false);
    // And there is no default: an unnamed kind is never a user.
    expect(ProviderEvent.safeParse({ ...MINIMAL, subjectType: "person", subjectId: "ada" }).success).toBe(false);
  });

  test("a fully-populated event round-trips through the schema unchanged", () => {
    const full = {
      ...MINIMAL,
      subjectType: "user" as const,
      subjectId: "ada",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
      revokedAt: null,
      // Null because this event is not paused. A resume date beside a live subscription is the one thing
      // the field may never carry — see `data/pause.ts`.
      resumesAt: null,
      originalTransactionId: "2000000617339002",
      amountMinor: 499,
      currency: "USD",
      // Every rail but Lemon Squeezy leaves this out, and the schema decides it is a charge rather than
      // each rail restating it. Named here because a round-trip must hand back exactly what went in.
      role: "charge" as const,
    };
    expect(ProviderEvent.parse(full)).toEqual(full);
  });

  test("carries no owner of its own — a rail cannot name one", () => {
    // The type-level guarantee, asserted structurally: whatever a rail returns, neither half of the subject is
    // there, so the route is the only place an owner is decided.
    expect(Object.keys(MINIMAL)).not.toContain("subjectType");
    expect(Object.keys(MINIMAL)).not.toContain("subjectId");
    // And the field the pair replaced is gone rather than tolerated beside it.
    expect(Object.keys(MINIMAL)).not.toContain("userId");
  });

  test("a notification with no state change is still a complete result", () => {
    const notification: VerifiedNotification = {
      providerEventId: "8e1d6b73-4f20-4c89-a05e-3b7c9d1f2a64",
      payload: { notificationType: "TEST" },
      event: null,
      providerAccountId: null,
    };
    // Null `event` is a success. The caller records the row and answers 200 rather than making the store
    // retry a notification that will never mean anything.
    expect(notification.event).toBeNull();
    // And it needs no explanation: a test notification is exactly what it looks like.
    expect(notification.note).toBeUndefined();
  });

  test("a notification that could not be resolved says why, so the row is repairable", () => {
    // The other shape of a null event: authentic, about a real purchase, and not projectable. Play's
    // voided-purchase notification names no product, so the reason belongs on the webhook row rather than being
    // swallowed as a delivery that changed nothing.
    const notification: VerifiedNotification = {
      providerEventId: "6714080000000001",
      payload: { voidedPurchaseNotification: { orderId: "GPA.3311-8452-9910-77304" } },
      event: null,
      providerAccountId: null,
      note: { stated: "google: purchase voided (order GPA.3311-8452-9910-77304)." },
    };
    expect(noteText(notification.note)).toContain("GPA.3311-8452-9910-77304");
  });

  test("an account reference travels beside the store's own identifier, never as an owner", () => {
    // The pairing a rail with no client-submission path depends on. Both halves are on the notification and
    // neither names a subject: the route is still the only place an owner is decided, and it decides by
    // decoding this reference, writing the link, and then resolving through it.
    const notification: VerifiedNotification = {
      providerEventId: "evt_stripeSessionSubscription",
      payload: { type: "checkout.session.completed" },
      event: null,
      providerAccountId: "cus_PithyAda",
      accountReference: encodeSubjectReference({ subjectType: "user", subjectId: "ada" }),
    };
    expect(Object.keys(notification)).not.toContain("subjectType");
    expect(Object.keys(notification)).not.toContain("subjectId");
    expect(notification.accountReference).toBe("user:ada");
  });

  test("an account reference is an encoded subject, so an organization's purchase comes back as one", () => {
    // What crosses to a store and back is the pair, not an id. Without the kind, an organization's renewal
    // would return a bare id and be attributed to whichever kind the reader assumed.
    const reference = encodeSubjectReference({ subjectType: "organization", subjectId: "acme" });
    expect(reference).toBe("organization:acme");
    expect(decodeSubjectReference(reference)).toEqual({ subjectType: "organization", subjectId: "acme" });
  });

  test("a bare id does not decode to a user — the reference fails closed", () => {
    // The pre-subject shape, which every older client sent and any store may echo back. Reading it as a user
    // would attribute a stranger's purchase to whoever holds that id, so it decodes to nothing and the route
    // records the event as an orphan. Undefined is the safe answer here; a guess is not.
    expect(decodeSubjectReference("ada")).toBeUndefined();
    expect(decodeSubjectReference("")).toBeUndefined();
    // Nor does an unknown kind, which is the same mistake wearing a separator.
    expect(decodeSubjectReference("person:ada")).toBeUndefined();
  });
});

/**
 * A rail that only hears about purchases — the shared contract and nothing else. Shared by every guard's
 * tests, because "what a rail that declares only the minimum answers" is the same question each time.
 */
const LISTENER: PaymentsRailProvider = {
  rail: "apple",
  verify: async () => ({ event: MINIMAL, providerAccountId: null }),
  parseNotification: async () => ({ providerEventId: "e", payload: {}, event: null, providerAccountId: null }),
  refresh: async () => undefined,
};

describe("isCheckoutRail", () => {
  const listener = LISTENER;

  test("a rail that only hears about purchases is not a checkout rail", () => {
    // The point of the split: Apple never has to declare a session method to satisfy the shared contract.
    expect(isCheckoutRail(listener)).toBe(false);
  });

  test("a rail that also initiates them is", () => {
    const initiator: PaymentsRailProvider & CheckoutRail = {
      ...listener,
      rail: "stripe",
      createCheckoutSession: async () => ({ kind: "redirect" as const, url: "https://checkout.example/session" }),
      createPortalSession: async () => ({ url: "https://billing.example/session" }),
    };
    expect(isCheckoutRail(initiator)).toBe(true);
  });

  test("half an implementation is not a checkout rail", () => {
    const half = {
      ...listener,
      createCheckoutSession: async () => ({ kind: "redirect" as const, url: "x" }),
    } as PaymentsRailProvider;
    expect(isCheckoutRail(half)).toBe(false);
  });
});

/**
 * The guard that gave the bug its name, and no longer has it.
 *
 * `isDiscountRail` probed `createDiscount` alone while {@link DiscountRail} declared two methods, so a rail
 * that could mint and not list narrowed into a type promising both. `GET {base}/admin/discounts` then passed
 * its guard and called a method that was not there — a `TypeError` inside a handler, which is a 500 on a
 * management pane rather than the `rail_not_configured` the same route gives for a rail that plainly cannot.
 * Nothing reached it: all three hosted rails declare both. It was a defect waiting for the fourth.
 *
 * Fixed by ANDing both, which is {@link isCheckoutRail}'s rule — and the two omissions are asserted
 * separately, because a guard that ANDs one of two passes whichever half it happens to probe.
 */
describe("isDiscountRail", () => {
  /** The smallest terms a rail could have minted from — a percentage, once, so no billing interval is owed. */
  const TERMS: DiscountTerms = {
    amount: { kind: "percent", percent: 20 },
    duration: { kind: "once" },
  };
  const minting: DiscountRail = {
    createDiscount: async () => ({ code: "WELCOME", providerDiscountId: "di_1", terms: TERMS }),
    listDiscounts: async () => [],
  };

  test("a rail that neither mints nor lists is not a discount rail", () => {
    expect(isDiscountRail(LISTENER)).toBe(false);
  });

  test("a rail that declares both is", () => {
    expect(isDiscountRail({ ...LISTENER, ...minting })).toBe(true);
  });

  test("one of two is not — for either one", () => {
    for (const method of Object.keys(minting)) {
      const partial: Record<string, unknown> = { ...LISTENER, ...minting };
      delete partial[method];
      expect(isDiscountRail(partial as unknown as PaymentsRailProvider), `omitted ${method}`).toBe(false);
    }
    // And the loop is only a proof if it ran twice.
    expect(Object.keys(minting)).toHaveLength(2);
  });

  test("minting without listing is refused, which is the shape the bug actually let through", () => {
    // Named separately from the loop above because it is the reachable one: a rail is written to create
    // first, so `createDiscount` alone is what a half-finished rail looks like on the day it is committed.
    const mintsOnly: Record<string, unknown> = { ...LISTENER, ...minting };
    delete mintsOnly.listDiscounts;
    expect(isDiscountRail(mintsOnly as unknown as PaymentsRailProvider)).toBe(false);
  });
});

/**
 * A stored subscription row, as the projection last wrote it — the only thing in this package that names a
 * subscription at a store. Every subscription verb takes one of these, and the tests below assert that no
 * verb offers a second way to say which subscription is meant.
 */
const PURCHASE: PaymentsPurchase = {
  id: "11111111-1111-4111-8111-111111111111",
  subjectType: "user",
  subjectId: "ada",
  rail: "paddle",
  role: "charge",
  providerTransactionId: "txn_01kzvyzPithyTestNotAReal",
  productId: "team_monthly",
  providerProductId: "pri_01kzvyz9khsdy36z10wb8bgmq4",
  type: "subscription",
  status: "active",
  environment: "sandbox",
  purchasedAt: new Date("2026-08-15T11:42:21.789Z"),
  expiresAt: new Date("2026-09-15T11:42:21.789Z"),
  revokedAt: null,
  resumesAt: null,
  originalTransactionId: null,
  amountMinor: 11000,
  currency: "usd",
  providerEventAt: new Date("2026-08-15T11:42:21.789Z"),
  payload: {},
  createdAt: new Date("2026-08-15T11:42:21.789Z"),
  updatedAt: new Date("2026-08-15T11:42:21.789Z"),
};

/**
 * The recorded deferred downgrade, normalized — Paddle sandbox, 2026-08-28 (#465). Parsed rather than cast,
 * so the return type the interface declares is asserted to accept the shape a real preview produces.
 */
const QUOTE = SubscriptionChangeQuote.parse({
  settlesToday: { outcome: "nothing" },
  nextInvoice: {
    settlement: { outcome: "credit", amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } },
    at: "2026-09-15T11:42:21.789736Z",
  },
  recurring: {
    amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" },
    startsAt: "2026-09-15T11:42:21.789736Z",
  },
});

/**
 * The recorded standing after `cancel(next_billing_period)` — `active`, `next_billed_at` null, and a cancel
 * scheduled. The shape that makes "Team until 15 Sep, then ends" writable, and the reason a write verb
 * answers a standing rather than nothing.
 */
const STANDING = SubscriptionStanding.parse({
  status: "active",
  currency: "usd",
  currentPeriodEndsAt: "2026-09-15T11:42:21.789736Z",
  nextBilledAt: null,
  scheduledChange: { action: "cancel", effectiveAt: "2026-09-15T11:42:21.789736Z", resumesAt: null },
});

describe("isSubscriptionRail", () => {
  const managed: SubscriptionRail = {
    readStanding: async () => STANDING,
    previewChange: async () => QUOTE,
    changePlan: async () => STANDING,
    cancelSubscription: async () => STANDING,
    keepSubscription: async () => STANDING,
  };

  test("a rail that only hears about purchases cannot manage a subscription", () => {
    // Apple and Google have no equivalent: a StoreKit subscription is changed inside the store's own UI.
    expect(isSubscriptionRail(LISTENER)).toBe(false);
  });

  test("a rail that declares all five is one", () => {
    expect(isSubscriptionRail({ ...LISTENER, ...managed })).toBe(true);
  });

  test("four of five is not — for every one of the five", () => {
    // The isDiscountRail bug, refused method by method. A guard probing one verb calls the other four on a
    // rail that never declared them, and the first thing a caller learns is a TypeError mid-cancellation.
    // Every omission is asserted rather than one, because a guard that ANDs four of five passes a single case.
    for (const method of Object.keys(managed)) {
      const partial: Record<string, unknown> = { ...LISTENER, ...managed };
      delete partial[method];
      expect(isSubscriptionRail(partial as unknown as PaymentsRailProvider), `omitted ${method}`).toBe(false);
    }
    // And the loop is only a proof if it ran five times.
    expect(Object.keys(managed)).toHaveLength(5);
  });

  test("the read is not optional — a rail that can cancel must be able to say what it canceled", () => {
    // The half that creates the support ticket: a scheduled cancellation leaves `status` at `active` and
    // blanks `next_billed_at`, so a rail that writes without reading leaves a customer told they will be
    // billed again. Stated as a guard case rather than as prose, so it fails rather than ages.
    const writesOnly: Record<string, unknown> = { ...LISTENER, ...managed };
    delete writesOnly.readStanding;
    expect(isSubscriptionRail(writesOnly as unknown as PaymentsRailProvider)).toBe(false);
  });

  test("the quote is not optional — a rail that can charge must be able to say what it will charge", () => {
    // Consent is the other half. A change verb with no preview is a confirmation screen with no figure on it.
    const unquoted: Record<string, unknown> = { ...LISTENER, ...managed };
    delete unquoted.previewChange;
    expect(isSubscriptionRail(unquoted as unknown as PaymentsRailProvider)).toBe(false);
  });
});

describe("the subscription inputs", () => {
  const change: SubscriptionChangeInput = { purchase: PURCHASE, providerProductId: "pri_01kzvyz9e21z9vbhd7xqq3csyh" };
  const cancel: SubscriptionCancelInput = { purchase: PURCHASE, timing: "at_period_end" };

  test("no subscription id crosses into a rail — the purchase row is the whole reference", () => {
    // The vulnerability this closes is the one `PortalSessionInput.subscriptionIds` names: a field naming a
    // subscription is a field a caller points at somebody else's, and this capability has no members table
    // to check the claim against. The row comes from this deployment's own database, already owned.
    for (const input of [change, cancel]) {
      expect(Object.keys(input)).not.toContain("subscriptionId");
      expect(Object.keys(input)).not.toContain("providerSubscriptionId");
      expect(Object.keys(input)).not.toContain("subscriptionIds");
      expect(Object.keys(input)).toContain("purchase");
    }
  });

  test("one price, never a list", () => {
    // Paddle's update replaces the items array — omit an item and it is removed — so an array here would be
    // a delete verb wearing an update verb's name. Building the complete list is the rail's obligation.
    expect(typeof change.providerProductId).toBe("string");
    expect(Array.isArray(change.providerProductId)).toBe(false);
    expect(Object.keys(change)).not.toContain("items");
    expect(Object.keys(change)).not.toContain("providerProductIds");
    expect(Object.keys(change)).not.toContain("quantity");
  });

  test("no billing enum anywhere — the rail picks the mode from the direction", () => {
    // A modeled proration mode is a field, a field is a thing a client can set, and the value a client would
    // eventually set is Paddle's `do_not_bill`: a free upgrade. It is unreachable because there is nowhere to
    // write it. `on_payment_failure` is always `prevent_change` for the same reason.
    for (const input of [change, cancel]) {
      for (const forbidden of ["prorationBillingMode", "proration", "prorate", "billingMode", "onPaymentFailure"]) {
        expect(Object.keys(input)).not.toContain(forbidden);
      }
    }
  });

  test("canceling is timed in the customer's terms, never in the store's", () => {
    // `next_billing_period` reads as "cancel next month" and means "stop renewing, keep what was paid for".
    // `at_period_end` says that, and Paddle's own spelling does not parse.
    expect(cancel.timing).toBe("at_period_end");
  });
});

describe("isRefundRail", () => {
  const refunds: RefundRail = { requestRefunds: async () => ({ outcomes: [] }) };

  const managed: SubscriptionRail = {
    readStanding: async () => STANDING,
    previewChange: async () => QUOTE,
    changePlan: async () => STANDING,
    cancelSubscription: async () => STANDING,
    keepSubscription: async () => STANDING,
  };

  test("a rail that only hears about purchases cannot refund at its store", () => {
    expect(isRefundRail(LISTENER)).toBe(false);
  });

  test("a rail that declares it is one", () => {
    expect(isRefundRail({ ...LISTENER, ...refunds })).toBe(true);
  });

  test("refunding and managing a subscription are independent abilities, in both directions", () => {
    // The whole argument for a second interface rather than a sixth method. Google Play refunds from the
    // server and changes no plan from it; Apple's only refund endpoint is a lookup. An interface demanding
    // both is one neither of them can satisfy, so each is asked separately.
    expect(isRefundRail({ ...LISTENER, ...managed })).toBe(false);
    expect(isSubscriptionRail({ ...LISTENER, ...refunds })).toBe(false);
    expect(isRefundRail({ ...LISTENER, ...managed, ...refunds })).toBe(true);
    expect(isSubscriptionRail({ ...LISTENER, ...managed, ...refunds })).toBe(true);
  });

  test("adding the refund verb to SubscriptionRail would have de-narrowed every rail that has the five", () => {
    // Stated as a case rather than as prose, because it is the cost the separation avoids and it is
    // invisible once the decision is made. `isSubscriptionRail` ANDs its methods, so a sixth would make a
    // rail shipping the five stop being a subscription rail — `rail_not_configured` on a cancellation,
    // from a release that changed nothing about canceling.
    expect(isSubscriptionRail({ ...LISTENER, ...managed })).toBe(true);
    expect(Object.keys(managed)).toHaveLength(5);
  });

  test("the guard probes the one method there is, so it ANDs all of them by arithmetic", () => {
    // True today and only today. A second method added to RefundRail and not to this guard is the
    // isDiscountRail bug arriving again, so the count is pinned rather than assumed.
    const partial: Record<string, unknown> = { ...LISTENER, ...refunds };
    delete partial.requestRefunds;
    expect(isRefundRail(partial as unknown as PaymentsRailProvider)).toBe(false);
    expect(Object.keys(refunds)).toHaveLength(1);
  });
});
