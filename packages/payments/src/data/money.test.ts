// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { minorUnitDigits, minorUnitsFromScaled } from "./money";

/**
 * The conversion nobody notices until an amount is wrong by a factor of a hundred. Every rail reports a
 * price in its own scale — Apple in thousandths of the currency unit, Google in millionths, Stripe already
 * in minor units — and `amountMinor` stores minor units. So the scale and the currency's exponent both
 * matter, and the currencies where the exponent is not 2 are exactly where a naive divide goes wrong.
 */
describe("minorUnitDigits", () => {
  test("two digits for the ordinary case", () => {
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("EUR")).toBe(2);
  });

  test("zero digits for the currencies that have no subunit", () => {
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("KRW")).toBe(0);
    expect(minorUnitDigits("CLP")).toBe(0);
  });

  test("three digits for the currencies whose subunit is a thousandth", () => {
    expect(minorUnitDigits("KWD")).toBe(3);
    expect(minorUnitDigits("BHD")).toBe(3);
  });

  test("is case-insensitive — a rail may report `usd` or `USD`", () => {
    expect(minorUnitDigits("jpy")).toBe(0);
  });

  test("falls back to two digits for a code it does not know", () => {
    // A new or unlisted code must not throw on a webhook path. Two is right for the overwhelming
    // majority, and a wrong exponent on an unknown code is a reporting inaccuracy, not a broken purchase.
    expect(minorUnitDigits("XTS")).toBe(2);
  });
});

describe("minorUnitsFromScaled", () => {
  test("Apple's milliunits become cents", () => {
    // $4.99 arrives as 4990 thousandths.
    expect(minorUnitsFromScaled(4990, 1000, "USD")).toBe(499);
  });

  test("Google's micros become cents", () => {
    // $4.99 arrives as 4_990_000 millionths.
    expect(minorUnitsFromScaled(4_990_000, 1_000_000, "USD")).toBe(499);
  });

  test("a zero-decimal currency keeps its whole units", () => {
    // ¥500 arrives as 500000 thousandths, and ¥500 is 500 minor units — not 50000.
    expect(minorUnitsFromScaled(500_000, 1000, "JPY")).toBe(500);
  });

  test("a three-decimal currency keeps its thousandths", () => {
    // 2.500 KWD arrives as 2500 thousandths, and the minor unit is the thousandth.
    expect(minorUnitsFromScaled(2500, 1000, "KWD")).toBe(2500);
  });

  test("rounds rather than truncates", () => {
    // 1005 thousandths of a dollar is 100.5 cents. Truncating would lose a cent on every such price.
    expect(minorUnitsFromScaled(1005, 1000, "USD")).toBe(101);
  });

  test("zero is zero, and a free product is not null", () => {
    expect(minorUnitsFromScaled(0, 1000, "USD")).toBe(0);
  });

  test("null in, null out — a rail that reported no price reports none", () => {
    expect(minorUnitsFromScaled(null, 1000, "USD")).toBeNull();
    expect(minorUnitsFromScaled(4990, 1000, null)).toBeNull();
  });

  test("a negative scaled amount is null, not a negative row", () => {
    // The purchases table refuses a negative `amountMinor` by CHECK constraint, so a rail reporting one
    // would abort the whole projection batch. Dropping the amount keeps the purchase projectable.
    expect(minorUnitsFromScaled(-100, 1000, "USD")).toBeNull();
  });

  test("a non-finite amount is null", () => {
    expect(minorUnitsFromScaled(Number.NaN, 1000, "USD")).toBeNull();
    expect(minorUnitsFromScaled(Number.POSITIVE_INFINITY, 1000, "USD")).toBeNull();
  });
});
