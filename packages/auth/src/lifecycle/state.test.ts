// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { clientError } from "@pithy-sh/core/src/error/client";
import { describe, expect, test } from "vitest";
import { accountStanding, LifecycleColumns, lifecycleRefusal } from "./state";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offset: number): Date => new Date(NOW.getTime() + offset);

describe("accountStanding", () => {
  test("an account with nothing set is active", () => {
    expect(accountStanding({}, NOW)).toEqual({ state: "active" });
    expect(
      accountStanding({ suspendedAt: null, suspendedUntil: null, deletedAt: null, purgeAfter: null }, NOW),
    ).toEqual({ state: "active" });
  });

  test("a suspension with no end is in force", () => {
    expect(accountStanding({ suspendedAt: at(-HOUR) }, NOW)).toEqual({ state: "suspended", until: null });
  });

  test("a suspension whose end is still ahead is in force, and says when it ends", () => {
    expect(accountStanding({ suspendedAt: at(-HOUR), suspendedUntil: at(HOUR) }, NOW)).toEqual({
      state: "suspended",
      until: at(HOUR),
    });
  });

  test("a suspension whose end has passed is not a suspension, with no write needed to expire it", () => {
    expect(accountStanding({ suspendedAt: at(-2 * HOUR), suspendedUntil: at(-HOUR) }, NOW)).toEqual({
      state: "active",
    });
    // The end is exclusive: at the instant it names, the suspension is over.
    expect(accountStanding({ suspendedAt: at(-HOUR), suspendedUntil: NOW }, NOW)).toEqual({ state: "active" });
  });

  test("a deleted account is deleted, and outranks a suspension it was already under", () => {
    // Deleting a suspended account must not let the suspension's expiry reopen it.
    expect(
      accountStanding({ suspendedAt: at(-HOUR), suspendedUntil: at(-1), deletedAt: at(-1), purgeAfter: at(HOUR) }, NOW),
    ).toEqual({ state: "deleted", purgeAfter: at(HOUR) });
    expect(accountStanding({ deletedAt: at(-1) }, NOW)).toEqual({ state: "deleted", purgeAfter: null });
  });

  test("a deleted account past its purge date is still deleted — only the purge ends that state", () => {
    expect(accountStanding({ deletedAt: at(-48 * HOUR), purgeAfter: at(-HOUR) }, NOW)).toEqual({
      state: "deleted",
      purgeAfter: at(-HOUR),
    });
  });
});

describe("LifecycleColumns — the state off a session's user object", () => {
  test("decodes the ms-epoch numbers Better Auth hands back as stored", () => {
    const parsed = LifecycleColumns.parse({ suspendedAt: NOW.getTime(), suspendedUntil: null, extra: "ignored" });
    expect(parsed.suspendedAt?.getTime()).toBe(NOW.getTime());
    expect(parsed.suspendedUntil).toBeNull();
    expect(parsed.deletedAt).toBeUndefined();
  });

  test("a user object from before the columns existed reads as active", () => {
    expect(accountStanding(LifecycleColumns.parse({ id: "u1", email: "a@b.test" }), NOW)).toEqual({ state: "active" });
  });
});

describe("lifecycleRefusal", () => {
  test("an active account is not refused", () => {
    expect(lifecycleRefusal("u1", { state: "active" }, null)).toBeNull();
  });

  test("a suspension refuses with auth/account_suspended 403, the reason as the message", () => {
    const refusal = lifecycleRefusal("u1", { state: "suspended", until: null }, "Chargeback under review.");
    expect(refusal?.payload).toMatchObject({
      code: "auth/account_suspended",
      status: 403,
      message: "Chargeback under review.",
    });
    expect(refusal?.payload.params).toBeUndefined();
  });

  test("a suspension with an end carries it in params, as ISO-8601", () => {
    const refusal = lifecycleRefusal("u1", { state: "suspended", until: at(HOUR) }, "Cooling off.");
    expect(refusal?.payload.params).toEqual({ suspendedUntil: at(HOUR).toISOString() });
  });

  test("a suspension nobody gave a reason for still says what happened", () => {
    const refusal = lifecycleRefusal("u1", { state: "suspended", until: null }, null);
    expect(refusal?.payload.message).toBe("This account is suspended.");
  });

  test("a deletion refuses with auth/account_deleted 403, and says until when it can be restored", () => {
    const refusal = lifecycleRefusal("u1", { state: "deleted", purgeAfter: at(HOUR) }, null);
    expect(refusal?.payload).toMatchObject({ code: "auth/account_deleted", status: 403 });
    expect(refusal?.payload.params).toEqual({ purgeAfter: at(HOUR).toISOString() });
  });

  test("what crosses to a client is the state and the reason — never who did it, or the account id", () => {
    for (const refusal of [
      lifecycleRefusal("user-8d1f", { state: "suspended", until: at(HOUR) }, "Chargeback under review."),
      lifecycleRefusal("user-8d1f", { state: "deleted", purgeAfter: at(HOUR) }, null),
    ]) {
      if (!refusal) throw new Error("expected a refusal");
      expect(refusal.payload.detail).toContain("user-8d1f");
      const wire = JSON.stringify(clientError(refusal.payload));
      expect(wire).not.toContain("user-8d1f");
      expect(Object.keys(clientError(refusal.payload)).sort()).toEqual(["code", "message", "params", "status"]);
    }
  });
});
