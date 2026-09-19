// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { SupportConfig } from "../config/config";
import { senderPeers } from "./peers";
import {
  resolveSenderContext,
  resolveSubmitterAccount,
  resolveSubmitterContext,
  type SenderPeers,
  submitterAddress,
} from "./sender";

/**
 * What a support console is told about a sender, and — more importantly — what it is not told.
 *
 * The linkage is the capability's headline feature and its sharpest edge. `From:` is an
 * unauthenticated claim, so the panel it drives has to distinguish *matched* from *verified*: a name
 * beside an address is a guess an operator can sanity-check, while an itemized purchase history is
 * what somebody decides to issue a refund or reset an account on. These tests pin that split.
 *
 * `@pithy-sh/auth` and `@pithy-sh/payments` reach this module from the composition (#645), and every
 * lookup below is handed neither, so each fails closed to "no account" — which is exactly the third
 * property worth pinning: absent siblings degrade, they do not throw.
 */

/** A D1 stand-in. Never reached: with no peer composed, nothing asks it anything. */
const d1 = {} as D1Database;

const NOW = new Date("2026-07-01T00:00:00.000Z");

/** A composition with neither auth nor payments in it. */
const NO_PEERS: SenderPeers = {};

describe("resolveSenderContext", () => {
  test("an unverified sender still reports the verdict, never a silent absence", async () => {
    const context = await resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: false }, NO_PEERS);
    expect(context.authenticated).toBe(false);
  });

  test("an unverified sender is never given purchases or entitlements", async () => {
    // The half that matters. Whatever the match resolved to, the billing history an operator would
    // act on is withheld until the sender is proved — presenting a real customer's on a thread that
    // merely claims to be them is the account-takeover path this whole seam exists to close.
    const context = await resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: false }, NO_PEERS);
    expect(context.purchases).toEqual([]);
    expect(context.entitlements).toEqual([]);
  });

  test("an unverified sender is never told the account verified its own address", async () => {
    // `emailVerified` describes the account, but rendered beside an unverified sender it reads as
    // "this sender is verified" — the exact confusion the split is for.
    const context = await resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: false }, NO_PEERS);
    expect(context.emailVerified).toBeUndefined();
  });

  test("a malformed address resolves to nothing rather than throwing", async () => {
    const context = await resolveSenderContext(d1, "not-an-address", NOW, { authenticated: true }, NO_PEERS);
    expect(context).toEqual({ authenticated: true, userId: null, purchases: [], entitlements: [] });
  });

  test("absent auth and payments packages degrade to no context, never an error", async () => {
    // Both are optional and reached through the composition. A support inbox in a project with no
    // accounts and no payments is a perfectly reasonable thing to run.
    await expect(resolveSenderContext(d1, "ada@example.com", NOW, { authenticated: true }, NO_PEERS)).resolves.toEqual({
      authenticated: true,
      userId: null,
      purchases: [],
      entitlements: [],
    });
  });
});

describe("submitterAddress", () => {
  /**
   * The reply address for an app thread, and the reason it is its own function: this value becomes the
   * thread's `fromAddress` and `sendReply` enqueues an operator's answer to it, so an address that is
   * not deliverable is a report nobody can answer rather than a cosmetic defect.
   */
  test("a normal account address comes back normalized", () => {
    expect(submitterAddress("Ada@Example.COM")).toBe("ada@example.com");
    expect(submitterAddress("  ada@example.com  ")).toBe("ada@example.com");
  });

  test("an address the parser refuses is null, never a lowercased version of itself", () => {
    // The regression this shape exists to prevent. A `normalizeAddress` fallback would return
    // `dev@localhost` and `a b@example.com` here — addresses the capability's own parser had just
    // rejected — and an operator's reply would be enqueued to one of them.
    for (const refused of ["dev@localhost", "a b@example.com", "not-an-address", "@example.com", "ada@"]) {
      expect(submitterAddress(refused), refused).toBeNull();
    }
  });

  test("an absent or empty address is null rather than a throw", () => {
    // Better Auth's `email` is not nullable, but this runs against whatever is in the adopter's own
    // table — and a missing address must degrade the same way a missing row does.
    expect(submitterAddress(undefined)).toBeNull();
    expect(submitterAddress(null)).toBeNull();
    expect(submitterAddress("")).toBeNull();
  });
});

describe("the submitter lookups degrade with auth absent", () => {
  test("no account resolves, and nothing throws", async () => {
    // No auth composed, as for every other lookup here. The caller turns this null into a hard
    // fault — a session proved the id, so failing to read it is a fault in the deployment rather than
    // a supported state — but that decision belongs to the caller, not to this function.
    await expect(resolveSubmitterAccount(d1, "user-ada", NO_PEERS)).resolves.toBeNull();
  });

  test("the context still reports the proven link, with the derived halves empty", async () => {
    // The link is the session's own user id and needs nothing looked up, so it survives an absent
    // auth package — while purchases and entitlements, which do need one, come back empty rather than
    // throwing. `authenticated` stays true: it describes how the caller arrived, not what resolved.
    await expect(resolveSubmitterContext(d1, "user-ada", NOW, NO_PEERS)).resolves.toEqual({
      authenticated: true,
      userId: "user-ada",
      purchases: [],
      entitlements: [],
    });
  });
});

describe("senderPeers", () => {
  /**
   * How the link gets its siblings at all: `support()`'s `compose` hook reads each one's surface off the
   * composed capabilities, never an import (#645). Stand-ins here, because what is being proved is the
   * finding; the surfaces are the real ones wherever a Worker composes `auth()` and `payments()`.
   *
   * And what it refuses (#645 review): a composed peer from before its surface, which read as absent and linked
   * nobody; and the in-app channel, on by default, in a Worker with no auth to key a submission to.
   */
  const AUTH = { authDatabase: () => undefined };
  const PAYMENTS = { paymentsDatabase: () => undefined, resolveEntitlements: () => undefined };
  const cap = (name: string, extra: Record<string, unknown> = {}) => ({ name, requiredBindings: [], ...extra });
  const auth = (extra: Record<string, unknown> = { authPeer: AUTH }) => cap("auth", { authConfig: {}, ...extra });
  const payments = (extra: Record<string, unknown> = { paymentsPeer: PAYMENTS }) =>
    cap("payments", { paymentsConfig: {}, ...extra });
  const IN_APP = SupportConfig.parse({});
  const MAIL_ONLY = SupportConfig.parse({ submission: { enabled: false } });

  /** What a composition was refused with, or undefined when it composed. */
  function refused(run: () => unknown): { message: string; action?: string } | undefined {
    try {
      run();
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      return (error as PithyError).payload;
    }
  }

  test("finds each composed sibling's surface", () => {
    const found = senderPeers([auth(), payments()], IN_APP);
    expect(found.auth).toBe(AUTH);
    expect(found.payments).toBe(PAYMENTS);
  });

  test("a mail-only inbox without them is an empty set, not a failure", () => {
    expect(senderPeers([cap("support"), cap("email")], MAIL_ONLY)).toEqual({});
  });

  test("the in-app channel with no auth in this Worker is refused, naming auth, the channel and both fixes", () => {
    const said = refused(() => senderPeers([cap("support"), cap("email")], IN_APP));
    expect(said?.message).toBe("The in-app support channel is on, and no auth is composed in this Worker.");
    expect(said?.action).toContain("Add `auth(...)` to this Worker's capabilities");
    expect(said?.action).toContain("`submission: { enabled: false }`");
  });

  test("an auth too old to carry its surface is refused, even for a mail-only inbox", () => {
    const said = refused(() => senderPeers([auth({})], MAIL_ONLY));
    expect(said?.message).toBe(
      "Support links a sender to an account through @pithy-sh/auth, and the composed one is too old to be reached.",
    );
    expect(said?.action).toBe("Upgrade @pithy-sh/auth to the version this @pithy-sh/support peers.");
  });

  test("a payments too old to carry its surface is refused", () => {
    expect(refused(() => senderPeers([auth(), payments({})], IN_APP))?.message).toBe(
      "Support shows what a sender bought through @pithy-sh/payments, and the composed one is too old to be reached.",
    );
  });

  test("a capability merely named auth, without auth's config, is not auth", () => {
    // An adopter's own `defineCapability({ name: "auth" })`: not the kit's, so not a peer, old or new.
    expect(senderPeers([cap("auth")], MAIL_ONLY)).toEqual({});
  });
});
