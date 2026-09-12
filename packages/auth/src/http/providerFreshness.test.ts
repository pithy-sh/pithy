// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { AuthContext } from "@pithy-sh/core/src/http/authContext";
import { describe, expect, test } from "vitest";
import {
  authenticationIsFresh,
  PROVIDER_CHANGE_FRESH_AGE_SECONDS,
  requireFreshAuthentication,
} from "./providerFreshness";

const NOW = new Date("2026-09-11T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("authenticationIsFresh", () => {
  test("an authentication moments ago is fresh", () => {
    expect(authenticationIsFresh(ago(30), NOW)).toBe(true);
  });

  test("one older than the window is not", () => {
    expect(authenticationIsFresh(ago(PROVIDER_CHANGE_FRESH_AGE_SECONDS + 1), NOW)).toBe(false);
  });

  test("the boundary is inclusive", () => {
    expect(authenticationIsFresh(ago(PROVIDER_CHANGE_FRESH_AGE_SECONDS), NOW)).toBe(true);
  });

  test("absent or unreadable is not fresh — the gate fails closed", () => {
    // A session row written before the column exists is the realistic case, and "I cannot tell" must not
    // read as "recently". It costs that session one re-authentication, once.
    expect(authenticationIsFresh(null, NOW)).toBe(false);
    expect(authenticationIsFresh(undefined, NOW)).toBe(false);
    expect(authenticationIsFresh(new Date("nonsense"), NOW)).toBe(false);
  });

  test("a future timestamp is not fresh either", () => {
    // A window checked on one side only passes any future value forever.
    expect(authenticationIsFresh(new Date(NOW.getTime() + 60_000), NOW)).toBe(false);
  });

  test("ISO text is read, because a raw row hands back a string", () => {
    expect(authenticationIsFresh(ago(30).toISOString(), NOW)).toBe(true);
  });

  test("the window is far shorter than a session's life, or it would gate nothing", () => {
    // The whole point is that a credential valid for days cannot silently attach a provider.
    expect(PROVIDER_CHANGE_FRESH_AGE_SECONDS).toBeLessThanOrEqual(60 * 60);
  });
});

describe("requireFreshAuthentication", () => {
  /** A Hono context stand-in carrying just the seam, the emit hook, and a request. */
  function ctx(auth: AuthContext | null) {
    const emitted: unknown[] = [];
    const c = {
      var: { auth, emit: async (event: unknown) => void emitted.push(event) },
      req: { raw: new Request("https://app.example/auth/link-social", { method: "POST" }) },
    } as never;
    return { c, emitted };
  }

  const signedIn = (authenticatedAt: Date | null): AuthContext => ({
    userId: "u-1",
    sessionId: "s-1",
    scopes: [],
    locale: null,
    authenticatedAt,
  });

  async function run(auth: AuthContext | null) {
    const { c, emitted } = ctx(auth);
    const gate = requireFreshAuthentication("link", () => NOW);
    let reached = false;
    try {
      await gate(c, async () => {
        reached = true;
      });
    } catch (error) {
      return { outcome: error instanceof PithyError ? error.payload.code : "threw", emitted };
    }
    return { outcome: reached ? "passed" : "no-next", emitted };
  }

  test("an authentication moments ago reaches the route", async () => {
    // The assertion that matters. An earlier shape of this gate read a field nothing populated and so
    // refused every caller — which reads as "linking is broken" and invites deleting the gate.
    expect((await run(signedIn(ago(30)))).outcome).toBe("passed");
  });

  test("a stale authentication is refused with its own code", async () => {
    expect((await run(signedIn(ago(PROVIDER_CHANGE_FRESH_AGE_SECONDS + 60)))).outcome).toBe("auth/session_not_fresh");
  });

  test("no credential at all is 401, not the freshness 403", async () => {
    // A caller holding nothing cannot tell "not signed in" from "signed in too long ago", and the two
    // have different remedies. `requireAuth()` answers an absent credential the same way.
    expect((await run(null)).outcome).toBe("auth/invalid_token");
  });

  test("a session predating the column is refused — absent is not recent", async () => {
    expect((await run(signedIn(null))).outcome).toBe("auth/session_not_fresh");
  });

  test("the refusal is recorded before it is thrown", async () => {
    // One is somebody who left a tab open; a run of them against one user id is the incident, and without
    // the row there is nothing to count.
    const { emitted } = await run(signedIn(ago(PROVIDER_CHANGE_FRESH_AGE_SECONDS + 60)));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      action: "auth/session_not_fresh",
      outcome: "denied",
      actorType: "user",
      actorId: "u-1",
      sessionId: "s-1",
      metadata: { change: "link" },
    });
  });

  test("a passing request records nothing", async () => {
    expect((await run(signedIn(ago(30)))).emitted).toHaveLength(0);
  });
});

describe("both directions are gated", () => {
  /** The same stand-in, for whichever direction a case is about. */
  function ctx(authenticatedAt: Date | null) {
    const emitted: { metadata?: unknown }[] = [];
    const c = {
      var: {
        auth: { userId: "u-1", sessionId: "s-1", scopes: [], locale: null, authenticatedAt },
        emit: async (event: { metadata?: unknown }) => void emitted.push(event),
      },
      req: { raw: new Request("https://app.example/auth/x", { method: "POST" }) },
    } as never;
    return { c, emitted };
  }

  test("unlinking is refused on a stale credential too, and says which direction it was", async () => {
    // `allowUnlinkingAll: true` means an attacker inside the window can strip *every* provider from an
    // account. Better Auth guards this endpoint itself, but against `session.createdAt` — which a
    // `/token/rotate` resets, and which is therefore the signal #558 exists to replace.
    const { c, emitted } = ctx(new Date(Date.now() - 2 * 60 * 60 * 1000));
    const gate = requireFreshAuthentication("unlink");
    await expect(gate(c, async () => {})).rejects.toMatchObject({ payload: { code: "auth/session_not_fresh" } });
    expect(emitted[0]?.metadata).toEqual({ change: "unlink" });
  });

  test("a recent authentication unlinks without ceremony", async () => {
    const { c, emitted } = ctx(new Date());
    let reached = false;
    await requireFreshAuthentication("unlink")(c, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});
