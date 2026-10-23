// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { MAX_REASON } from "../lifecycle/reason";
import { ReinstateUserBody, SuspendUserBody } from "./schemas";

/**
 * The lifecycle request bodies (#621). The routes read only what these hand back, so a reason the transition
 * would refuse, or an end that is not a timestamp, is a 400 here and never a conflict later.
 */
describe("SuspendUserBody", () => {
  test("takes a reason alone, and leaves the end and notify absent", () => {
    expect(SuspendUserBody.parse({ reason: "Chargeback under review." })).toEqual({
      reason: "Chargeback under review.",
    });
  });

  test("trims the reason, and refuses one that is only whitespace or missing", () => {
    expect(SuspendUserBody.parse({ reason: "  Review.  " }).reason).toBe("Review.");
    expect(SuspendUserBody.safeParse({ reason: "   " }).success).toBe(false);
    expect(SuspendUserBody.safeParse({}).success).toBe(false);
    expect(SuspendUserBody.safeParse({ reason: null }).success).toBe(false);
  });

  test("bounds the reason by the constant the transition enforces", () => {
    expect(SuspendUserBody.safeParse({ reason: "x".repeat(MAX_REASON) }).success).toBe(true);
    expect(SuspendUserBody.safeParse({ reason: "x".repeat(MAX_REASON + 1) }).success).toBe(false);
  });

  test("reads the end as a date, and refuses one that is not a timestamp", () => {
    const parsed = SuspendUserBody.parse({ reason: "x", until: "2026-11-01T00:00:00.000Z" });
    expect(parsed.until?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(SuspendUserBody.safeParse({ reason: "x", until: "next tuesday" }).success).toBe(false);
  });

  test("notify is a boolean, never a string that looks like one", () => {
    expect(SuspendUserBody.parse({ reason: "x", notify: false }).notify).toBe(false);
    expect(SuspendUserBody.safeParse({ reason: "x", notify: "false" }).success).toBe(false);
  });
});

describe("ReinstateUserBody", () => {
  test("takes a reason and an optional notify, and refuses no reason", () => {
    expect(ReinstateUserBody.parse({ reason: " Cleared. ", notify: false })).toEqual({
      reason: "Cleared.",
      notify: false,
    });
    expect(ReinstateUserBody.safeParse({ notify: true }).success).toBe(false);
  });

  test("has no end to take: a reinstatement is now", () => {
    expect(Object.keys(ReinstateUserBody.shape)).toEqual(["reason", "notify"]);
  });
});
