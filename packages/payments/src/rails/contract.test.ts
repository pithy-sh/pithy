import { describe, expect, test } from "vitest";
import { ProviderEvent } from "../projection/event";
import {
  type CheckoutRail,
  isCheckoutRail,
  type PaymentsRailProvider,
  type UnboundProviderEvent,
  type VerifiedNotification,
} from "./contract";

/**
 * The contract is mostly types, and types are checked by `tsc`. What is worth asserting at runtime is the
 * one place the types meet the database: an `UnboundProviderEvent` plus a `userId` must be exactly what the
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
  test("plus a userId is a legal projection input, with the optional fields defaulting to null", () => {
    const event = ProviderEvent.parse({ ...MINIMAL, userId: "user-1" });
    expect(event.userId).toBe("user-1");
    // The rails leave these out when the store did not report them; the schema decides they are null rather
    // than each rail deciding separately.
    expect(event.expiresAt).toBeNull();
    expect(event.revokedAt).toBeNull();
    expect(event.originalTransactionId).toBeNull();
    expect(event.amountMinor).toBeNull();
    expect(event.currency).toBeNull();
  });

  test("a fully-populated event round-trips through the schema unchanged", () => {
    const full = {
      ...MINIMAL,
      userId: "user-1",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
      revokedAt: null,
      originalTransactionId: "2000000617339002",
      amountMinor: 499,
      currency: "USD",
    };
    expect(ProviderEvent.parse(full)).toEqual(full);
  });

  test("carries no userId of its own — a rail cannot name an owner", () => {
    // The type-level guarantee, asserted structurally: whatever a rail returns, the field is absent, so the
    // route is the only place an owner is decided.
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
      note: "google: purchase voided (order GPA.3311-8452-9910-77304).",
    };
    expect(notification.note).toContain("GPA.3311-8452-9910-77304");
  });

  test("an account reference travels beside the store's own identifier, never as a userId", () => {
    // The pairing a rail with no client-submission path depends on. Both halves are on the notification and
    // neither is a `userId`: the route is still the only place an owner is decided, and it decides by writing
    // the link and then resolving through it.
    const notification: VerifiedNotification = {
      providerEventId: "evt_stripeSessionSubscription",
      payload: { type: "checkout.session.completed" },
      event: null,
      providerAccountId: "cus_PithyAda",
      accountReference: "ada",
    };
    expect(Object.keys(notification)).not.toContain("userId");
    expect(notification.accountReference).toBe("ada");
  });
});

describe("isCheckoutRail", () => {
  const listener: PaymentsRailProvider = {
    rail: "apple",
    verify: async () => ({ event: MINIMAL, providerAccountId: null }),
    parseNotification: async () => ({ providerEventId: "e", payload: {}, event: null, providerAccountId: null }),
    refresh: async () => undefined,
  };

  test("a rail that only hears about purchases is not a checkout rail", () => {
    // The point of the split: Apple never has to declare a session method to satisfy the shared contract.
    expect(isCheckoutRail(listener)).toBe(false);
  });

  test("a rail that also initiates them is", () => {
    const initiator: PaymentsRailProvider & CheckoutRail = {
      ...listener,
      rail: "stripe",
      createCheckoutSession: async () => ({ url: "https://checkout.example/session" }),
      createPortalSession: async () => ({ url: "https://billing.example/session" }),
    };
    expect(isCheckoutRail(initiator)).toBe(true);
  });

  test("half an implementation is not a checkout rail", () => {
    const half = { ...listener, createCheckoutSession: async () => ({ url: "x" }) } as PaymentsRailProvider;
    expect(isCheckoutRail(half)).toBe(false);
  });
});
