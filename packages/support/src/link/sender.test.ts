// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, test } from "vitest";
import { resolveSenderContext } from "./sender";

/**
 * What a support console is told about a sender, and — more importantly — what it is not told.
 *
 * The linkage is the capability's headline feature and its sharpest edge. `From:` is an
 * unauthenticated claim, so the panel it drives has to distinguish *matched* from *verified*: a name
 * beside an address is a guess an operator can sanity-check, while an itemised purchase history is
 * what somebody decides to issue a refund or reset an account on. These tests pin that split.
 *
 * `@pithy-sh/auth` and `@pithy-sh/payments` are reached by guarded dynamic import and are not
 * installed as runtime dependencies here, so every lookup below fails closed to "no account" — which
 * is exactly the third property worth pinning: absent siblings degrade, they do not throw.
 */

/** A D1 stand-in. Never reached: the dynamic imports fail first in this environment. */
const d1 = {} as D1Database;

const NOW = new Date("2026-07-01T00:00:00.000Z");

describe("resolveSenderContext", () => {
  test("an unverified sender still reports the verdict, never a silent absence", async () => {
    const context = await resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: false });
    expect(context.authenticated).toBe(false);
  });

  test("an unverified sender is never given purchases or entitlements", async () => {
    // The half that matters. Whatever the match resolved to, the billing history an operator would
    // act on is withheld until the sender is proved — presenting a real customer's on a thread that
    // merely claims to be them is the account-takeover path this whole seam exists to close.
    const context = await resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: false });
    expect(context.purchases).toEqual([]);
    expect(context.entitlements).toEqual([]);
  });

  test("an unverified sender is never told the account verified its own address", async () => {
    // `emailVerified` describes the account, but rendered beside an unverified sender it reads as
    // "this sender is verified" — the exact confusion the split is for.
    const context = await resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: false });
    expect(context.emailVerified).toBeUndefined();
  });

  test("a malformed address resolves to nothing rather than throwing", async () => {
    const context = await resolveSenderContext(d1, "not-an-address", NOW, { authenticated: true });
    expect(context).toEqual({ authenticated: true, userId: null, purchases: [], entitlements: [] });
  });

  test("absent auth and payments packages degrade to no context, never an error", async () => {
    // Both are optional and reached by guarded dynamic import. A support inbox in a project with no
    // accounts and no payments is a perfectly reasonable thing to run.
    await expect(resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: true })).resolves.toEqual({
      authenticated: true,
      userId: null,
      purchases: [],
      entitlements: [],
    });
  });
});
