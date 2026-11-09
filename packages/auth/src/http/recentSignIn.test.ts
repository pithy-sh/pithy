// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { AuthContext } from "@pithy-sh/core/src/http/authContext";
import { describe, expect, test } from "vitest";
import { requireAuth } from "./middleware";
import { authenticatedWithin, recentSignInRequired, requireRecentSignIn } from "./recentSignIn";

const NOW = new Date("2026-11-08T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("authenticatedWithin", () => {
  test("an authentication inside the window passes, and the boundary is inclusive", () => {
    expect(authenticatedWithin(ago(30), NOW, 300)).toBe(true);
    expect(authenticatedWithin(ago(300), NOW, 300)).toBe(true);
  });

  test("one a second past the window does not", () => {
    expect(authenticatedWithin(ago(301), NOW, 300)).toBe(false);
  });

  test("the window is the one given", () => {
    expect(authenticatedWithin(ago(600), NOW, 300)).toBe(false);
    expect(authenticatedWithin(ago(600), NOW, 900)).toBe(true);
  });

  test("absent, unreadable or future is refused, whatever the window", () => {
    expect(authenticatedWithin(null, NOW, 86_400)).toBe(false);
    expect(authenticatedWithin(undefined, NOW, 86_400)).toBe(false);
    expect(authenticatedWithin(new Date("nonsense"), NOW, 86_400)).toBe(false);
    expect(authenticatedWithin("not a date", NOW, 86_400)).toBe(false);
    expect(authenticatedWithin(new Date(NOW.getTime() + 1000), NOW, 86_400)).toBe(false);
  });

  test("ISO text is read, because a raw row hands back a string", () => {
    expect(authenticatedWithin(ago(30).toISOString(), NOW, 300)).toBe(true);
  });
});

describe("recentSignInRequired", () => {
  test("is a 403 with the neutral code and a message every client can show", () => {
    const error = recentSignInRequired();
    expect(error.payload).toMatchObject({
      code: "auth/recent_sign_in_required",
      status: 403,
      message: "Sign in again to continue. Nothing was changed.",
    });
  });
});

describe("requireRecentSignIn", () => {
  const PURPOSE = "things/secret_revealed";

  /** A Hono context stand-in carrying just the seam, the emit hook, and a request. */
  function ctx(auth: AuthContext | null) {
    const emitted: unknown[] = [];
    const c = {
      var: { auth, emit: async (event: unknown) => void emitted.push(event) },
      req: {
        raw: new Request("https://app.example/things/t-1/secret", {
          method: "POST",
          headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "phone/1.0" },
        }),
      },
    } as never;
    return { c, emitted };
  }

  const signedIn = (authenticatedAt: Date | string | null): AuthContext => ({
    userId: "u-1",
    sessionId: "s-1",
    scopes: [],
    locale: null,
    authenticatedAt: authenticatedAt as Date | null,
  });

  async function run(auth: AuthContext | null, maxAgeSeconds = 300) {
    const { c, emitted } = ctx(auth);
    const gate = requireRecentSignIn({ maxAgeSeconds, purpose: PURPOSE }, () => NOW);
    let reached = false;
    let order: string[] = [];
    try {
      await gate(c, async () => {
        reached = true;
      });
    } catch (error) {
      order = [...emitted.map(() => "emitted"), "threw"];
      return { outcome: error instanceof PithyError ? error.payload : "threw", emitted, order };
    }
    return { outcome: reached ? "passed" : "no-next", emitted, order };
  }

  test("a sign-in inside the window reaches the route and records nothing", async () => {
    const { outcome, emitted } = await run(signedIn(ago(299)));
    expect(outcome).toBe("passed");
    expect(emitted).toHaveLength(0);
  });

  test("one older than the window is refused with 403 auth/recent_sign_in_required", async () => {
    const { outcome } = await run(signedIn(ago(301)));
    expect(outcome).toMatchObject({ code: "auth/recent_sign_in_required", status: 403 });
  });

  test("the window is the app's, not the provider-change one", async () => {
    // Twenty minutes is outside the provider-change window and inside this route's hour.
    expect((await run(signedIn(ago(20 * 60)), 3600)).outcome).toBe("passed");
    expect((await run(signedIn(ago(20 * 60)), 60)).outcome).toMatchObject({ code: "auth/recent_sign_in_required" });
  });

  test.each([
    ["absent", null],
    ["unreadable", "not a date"],
    ["in the future", new Date(NOW.getTime() + 60_000)],
  ])("an %s authenticatedAt is refused", async (_label, at) => {
    expect((await run(signedIn(at))).outcome).toMatchObject({ code: "auth/recent_sign_in_required" });
  });

  test("no credential answers exactly what requireAuth() answers", async () => {
    const { c } = ctx(null);
    const expected = await requireAuth()(c, async () => {}).catch((error: unknown) => error);
    const { outcome, emitted } = await run(null);
    expect(expected).toBeInstanceOf(PithyError);
    expect(outcome).toEqual((expected as PithyError).payload);
    expect(outcome).toMatchObject({ code: "auth/invalid_token", status: 401 });
    expect(emitted).toHaveLength(0);
  });

  test("a refusal records auth/recent_sign_in_refused with the purpose and the user, before the throw", async () => {
    const { emitted, order } = await run(signedIn(ago(3600)));
    expect(order).toEqual(["emitted", "threw"]);
    expect(emitted).toEqual([
      expect.objectContaining({
        action: "auth/recent_sign_in_refused",
        outcome: "denied",
        severity: "warning",
        actorType: "user",
        actorId: "u-1",
        sessionId: "s-1",
        metadata: { purpose: PURPOSE },
        ip: "203.0.113.9",
        userAgent: "phone/1.0",
      }),
    ]);
  });

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "maxAgeSeconds %s is refused when the gate is built",
    (maxAgeSeconds) => {
      expect(() => requireRecentSignIn({ maxAgeSeconds, purpose: PURPOSE })).toThrow();
    },
  );

  test.each(["secret_revealed", "Things/secret", "things/", "/secret", "things/secret/revealed", ""])(
    "purpose %j is refused when the gate is built",
    (purpose) => {
      expect(() => requireRecentSignIn({ maxAgeSeconds: 300, purpose })).toThrow();
    },
  );
});
