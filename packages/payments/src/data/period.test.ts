// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { knownPeriodStart } from "./period";

const purchasedAt = new Date("2026-01-01T00:00:00.000Z");

describe("knownPeriodStart", () => {
  test("a per-period row's own purchase date, on the rails that write one per period", () => {
    expect(knownPeriodStart({ rail: "stripe", purchasedAt, payload: {} })).toEqual(purchasedAt);
    expect(knownPeriodStart({ rail: "apple", purchasedAt, payload: {} })).toEqual(purchasedAt);
  });

  test("Paddle's current billing period, from the stored subscription — never its creation date", () => {
    const payload = { current_billing_period: { starts_at: "2026-10-05T09:00:00.000000Z", ends_at: "x" } };
    expect(knownPeriodStart({ rail: "paddle", purchasedAt, payload })?.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(knownPeriodStart({ rail: "paddle", purchasedAt, payload: {} })).toBeUndefined();
    expect(
      knownPeriodStart({ rail: "paddle", purchasedAt, payload: { current_billing_period: { starts_at: "soon" } } }),
    ).toBeUndefined();
  });

  test("nothing for the rails whose rows state no period start, so a caller falls back rather than guesses", () => {
    expect(knownPeriodStart({ rail: "google", purchasedAt, payload: {} })).toBeUndefined();
    expect(knownPeriodStart({ rail: "lemonSqueezy", purchasedAt, payload: {} })).toBeUndefined();
  });
});
