// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { decodeSubjectReference, encodeSubjectReference } from "../data/subject";
import { ProviderEvent } from "../projection/event";
import {
  type CheckoutRail,
  isCheckoutRail,
  noteText,
  type PaymentsRailProvider,
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
