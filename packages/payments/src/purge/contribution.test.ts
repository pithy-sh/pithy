// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { redactPurchase } from "./contribution";

/**
 * `redactPurchase` (#814): a Google Play purchase row is exported without its purchase token. Its family key is
 * always dropped, and its transaction id is kept only when it is the order id the provider reported —
 * `latestOrderId` on a subscription, `orderId` on a one-time purchase.
 */

const google = (providerTransactionId: string, payload: unknown) => ({
  id: "p-1",
  rail: "google",
  providerTransactionId,
  originalTransactionId: "token-abc",
  payload,
});

describe("redactPurchase", () => {
  test("hands a row on any other rail back unchanged", () => {
    const row = {
      id: "p-1",
      rail: "stripe",
      providerTransactionId: "pi_123",
      originalTransactionId: "sub_123",
      payload: { orderId: "other" },
    };
    expect(redactPurchase(row)).toBe(row);
  });

  test("keeps a subscription's transaction id when it is the latestOrderId", () => {
    expect(redactPurchase(google("GPA.1111", { latestOrderId: "GPA.1111" }))).toEqual({
      ...google("GPA.1111", { latestOrderId: "GPA.1111" }),
      originalTransactionId: null,
    });
  });

  test("keeps a one-time purchase's transaction id when it is the orderId", () => {
    const redacted = redactPurchase(google("GPA.2222", { orderId: "GPA.2222", purchaseState: 0 }));
    expect(redacted.providerTransactionId).toBe("GPA.2222");
    expect(redacted.originalTransactionId).toBeNull();
  });

  test("nulls a transaction id that is not the reported order id — the purchase token", () => {
    expect(redactPurchase(google("token-abc", { latestOrderId: "GPA.1111" })).providerTransactionId).toBeNull();
    expect(redactPurchase(google("token-abc", { orderId: "GPA.2222" })).providerTransactionId).toBeNull();
  });

  test.each([
    ["no order id", {}],
    ["an empty order id", { orderId: "" }],
    ["an empty latestOrderId", { latestOrderId: "" }],
    ["a non-string order id", { orderId: 2222 }],
    ["a non-string latestOrderId", { latestOrderId: { id: "token-abc" } }],
    ["no payload", null],
    ["a payload that is not an object", "token-abc"],
  ])("nulls the transaction id with %s", (_, payload) => {
    const redacted = redactPurchase(google("token-abc", payload));
    expect(redacted.providerTransactionId).toBeNull();
    expect(redacted.originalTransactionId).toBeNull();
  });

  test("always drops a Play row's family key, and leaves its other columns", () => {
    const redacted = redactPurchase(google("GPA.1111", { latestOrderId: "GPA.1111" }));
    expect(redacted.originalTransactionId).toBeNull();
    expect(redacted).toMatchObject({ id: "p-1", rail: "google", payload: { latestOrderId: "GPA.1111" } });
  });
});
