// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  ACCOUNT_DELETION_INTENT,
  ACCOUNT_DELETION_INTENT_HEADER,
  admitsDeletionSignIn,
  noteRefusal,
  noticedRefusal,
  suspendedHolder,
} from "./enforce";
import { lifecycleRefusal } from "./state";

/** The per-request memory of a refusal, and of whose credential it was (#622). */
describe("the refusal a request carries", () => {
  const HOLDER = { userId: "u1", sessionId: "s1" };
  const suspended = lifecycleRefusal("u1", { state: "suspended", until: null }, "Review.");
  const deleted = lifecycleRefusal("u1", { state: "deleted", purgeAfter: null }, null);

  test("is remembered per request, and forgotten by every other", () => {
    const request = {};
    if (!suspended) throw new Error("expected a refusal");
    noteRefusal(request, suspended, HOLDER);
    expect(noticedRefusal(request)).toBe(suspended);
    expect(noticedRefusal({})).toBeUndefined();
  });

  test("names the holder of a suspended account's credential, and only that one", () => {
    if (!suspended || !deleted) throw new Error("expected refusals");
    const a = {};
    noteRefusal(a, suspended, HOLDER);
    expect(suspendedHolder(a)).toEqual(HOLDER);

    // A deleted account has nothing left to delete; a check that could not be made established nobody.
    const b = {};
    noteRefusal(b, deleted, HOLDER);
    expect(suspendedHolder(b)).toBeUndefined();
    const c = {};
    noteRefusal(c, new InternalError({ message: "could not check" }), HOLDER);
    expect(suspendedHolder(c)).toBeUndefined();

    // And a refusal noted with no holder names none.
    const d = {};
    noteRefusal(d, suspended);
    expect(suspendedHolder(d)).toBeUndefined();
    expect(suspendedHolder({})).toBeUndefined();
  });
});

/** The one sign-in a suspended account may complete: one that asks for nothing but deleting itself (#622). */
describe("a sign-in that asks only to delete the account", () => {
  const suspended = lifecycleRefusal("u1", { state: "suspended", until: null }, "Review.");
  const deleted = lifecycleRefusal("u1", { state: "deleted", purgeAfter: null }, null);
  const asking = new Headers({ [ACCOUNT_DELETION_INTENT_HEADER]: ACCOUNT_DELETION_INTENT });

  test("admits a suspended account that names the intent", () => {
    if (!suspended) throw new Error("expected a refusal");
    expect(admitsDeletionSignIn(suspended, asking)).toBe(true);
    expect(admitsDeletionSignIn(suspended, new Headers({ [ACCOUNT_DELETION_INTENT_HEADER]: " Delete-Account " }))).toBe(
      true,
    );
  });

  test("admits nothing else: no intent, another intent, a deleted account, or a check that failed", () => {
    if (!suspended || !deleted) throw new Error("expected refusals");
    expect(admitsDeletionSignIn(suspended, undefined)).toBe(false);
    expect(admitsDeletionSignIn(suspended, new Headers())).toBe(false);
    expect(admitsDeletionSignIn(suspended, new Headers({ [ACCOUNT_DELETION_INTENT_HEADER]: "sign-in" }))).toBe(false);
    expect(admitsDeletionSignIn(deleted, asking)).toBe(false);
    expect(admitsDeletionSignIn(new InternalError({ message: "could not check" }), asking)).toBe(false);
  });
});
