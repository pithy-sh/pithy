// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ACCESS_GRANTING_STATUSES, grantingStatuses, PurchaseStatus, statusGrantsAccess } from "./status";

/**
 * The status set is the normalization boundary: every rail's own vocabulary maps into these nine, and
 * nothing downstream sees a store-specific state. Which of them grant access is policy, and it is the
 * kind of policy that is wrong in production for months, so each branch has its own named test.
 */
describe("PurchaseStatus", () => {
  test("is the nine normalized states, and nothing else", () => {
    expect(PurchaseStatus.options).toEqual([
      "active",
      "in_grace",
      "on_hold",
      "canceled",
      "expired",
      "never_paid",
      "refunded",
      "revoked",
      "paused",
    ]);
  });

  test("`expired` and `never_paid` are two different endings, and the difference is the money", () => {
    // `expired` is a period we were paid for, ended. `never_paid` is a purchase that terminated before any
    // money cleared. Neither grants access, and only one of them credits a `grants` clause — which is why
    // they cannot share a member. See `grants/apply.ts`.
    expect(PurchaseStatus.options).toContain("expired");
    expect(PurchaseStatus.options).toContain("never_paid");
  });
});

describe("statusGrantsAccess", () => {
  test("active grants", () => {
    expect(statusGrantsAccess("active", true)).toBe(true);
    expect(statusGrantsAccess("active", false)).toBe(true);
  });

  test("canceled still grants — turning off auto-renew is not losing access mid-period", () => {
    // The subtle one, and the one an implementation gets wrong. `canceled` means "will not renew", not
    // "is over": the period the user already paid for runs to its end, and `expiresAt` is what ends it.
    expect(statusGrantsAccess("canceled", true)).toBe(true);
    expect(statusGrantsAccess("canceled", false)).toBe(true);
  });

  test("in_grace grants only while the project says grace grants access", () => {
    expect(statusGrantsAccess("in_grace", true)).toBe(true);
    expect(statusGrantsAccess("in_grace", false)).toBe(false);
  });

  test("on_hold never grants, whatever the grace setting — grace is already exhausted by then", () => {
    expect(statusGrantsAccess("on_hold", true)).toBe(false);
    expect(statusGrantsAccess("on_hold", false)).toBe(false);
  });

  test("never_paid never grants — a purchase that took no money never bought anything", () => {
    expect(statusGrantsAccess("never_paid", true)).toBe(false);
    expect(statusGrantsAccess("never_paid", false)).toBe(false);
  });

  test("expired, never_paid, refunded, revoked, and paused never grant", () => {
    for (const status of ["expired", "never_paid", "refunded", "revoked", "paused"] as const) {
      expect(statusGrantsAccess(status, true), status).toBe(false);
      expect(statusGrantsAccess(status, false), status).toBe(false);
    }
  });

  test("the candidate set is the three statuses a purchase can grant from", () => {
    // The set is what the projection's SQL filters on; the predicate then narrows `in_grace` by config.
    // Both must agree, so the set is asserted rather than left as an implementation detail.
    expect([...ACCESS_GRANTING_STATUSES].sort()).toEqual(["active", "canceled", "in_grace"]);
  });

  test("every status is decided — no member of the enum falls through the predicate", () => {
    for (const status of PurchaseStatus.options) {
      expect(typeof statusGrantsAccess(status, true), status).toBe("boolean");
    }
  });
});

describe("grantingStatuses", () => {
  test("narrows the candidate set by the grace policy, which is what the projection filters on", () => {
    expect(grantingStatuses(true).sort()).toEqual(["active", "canceled", "in_grace"]);
    expect(grantingStatuses(false).sort()).toEqual(["active", "canceled"]);
  });

  test("agrees with the predicate for every status, so the SQL filter and the gate cannot drift", () => {
    for (const grace of [true, false]) {
      const granting = new Set(grantingStatuses(grace));
      for (const status of PurchaseStatus.options) {
        expect(granting.has(status), `${status} @ grace=${grace}`).toBe(statusGrantsAccess(status, grace));
      }
    }
  });
});
