// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { MAX_REASON } from "../lifecycle/reason";
import {
  DeleteAccountBody,
  DeleteUserBody,
  ExportUserQuery,
  ReinstateUserBody,
  RestoreUserBody,
  SuspendUserBody,
} from "./schemas";

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

describe("DeleteUserBody (#622)", () => {
  test("no mode is soft: the window is the default, and nothing defaults to an erasure", () => {
    expect(DeleteUserBody.parse({ reason: "Asked by email." })).toEqual({ mode: "soft", reason: "Asked by email." });
  });

  test("hard is reached only by naming it exactly", () => {
    expect(DeleteUserBody.parse({ reason: "x", mode: "hard" }).mode).toBe("hard");
    // A typo is a 400, never the default and never the other mode. Each of these would otherwise be a guess
    // about which of two very different things the operator meant.
    for (const mode of ["Hard", "HARD", "hrad", "hard ", "purge", "immediate", true, 1, null, ""]) {
      expect(DeleteUserBody.safeParse({ reason: "x", mode }).success, String(mode)).toBe(false);
    }
  });

  test("a reason is required, trimmed and bounded, as the other lifecycle bodies require one", () => {
    expect(DeleteUserBody.safeParse({ mode: "soft" }).success).toBe(false);
    expect(DeleteUserBody.safeParse({ reason: "   " }).success).toBe(false);
    expect(DeleteUserBody.safeParse({ reason: "x".repeat(MAX_REASON + 1) }).success).toBe(false);
    expect(DeleteUserBody.parse({ reason: " Closed. " }).reason).toBe("Closed.");
  });

  test("notify is an optional boolean", () => {
    expect(DeleteUserBody.parse({ reason: "x", notify: false }).notify).toBe(false);
    expect(DeleteUserBody.safeParse({ reason: "x", notify: "no" }).success).toBe(false);
  });
});

describe("RestoreUserBody (#622)", () => {
  test("takes a reason and nothing else, and refuses none", () => {
    expect(RestoreUserBody.parse({ reason: " Changed their mind. " })).toEqual({ reason: "Changed their mind." });
    expect(RestoreUserBody.safeParse({}).success).toBe(false);
  });
});

describe("ExportUserQuery (#622)", () => {
  test("a disclosure says why, like every other lifecycle call", () => {
    expect(ExportUserQuery.parse({ reason: "Access request 4411." })).toEqual({ reason: "Access request 4411." });
    expect(ExportUserQuery.safeParse({}).success).toBe(false);
    expect(ExportUserQuery.safeParse({ reason: "" }).success).toBe(false);
  });
});

describe("DeleteAccountBody (#622)", () => {
  test("requires the confirmation, and only the literal true", () => {
    expect(DeleteAccountBody.parse({ confirm: true })).toEqual({ confirm: true });
    for (const confirm of [undefined, false, "true", 1, "yes", null]) {
      expect(DeleteAccountBody.safeParse({ confirm }).success, String(confirm)).toBe(false);
    }
  });

  test("names no account: whatever else the body says, the subject is the session's own", () => {
    expect(DeleteAccountBody.parse({ confirm: true, userId: "somebody-else" })).toEqual({ confirm: true });
  });
});
