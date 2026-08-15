// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AuthFetch,
  getSession,
  sendMagicLink,
  sendOtp,
  signInWithOtp,
  signOut,
  startSocialSignIn,
} from "../client/api";
import { type LiveApp, resetLiveSecrets, startLiveApp } from "../test-utils/liveApp";

/**
 * The browser primitive against the real routes — the other half of #370.
 *
 * `api.test.ts` drives `callAuth` through an injected fetch and proves what it *does*. This proves the
 * paths it names are the paths this Worker serves, which nothing about a stub can. The six requests it
 * replaced were hand-written into scaffolded screens; a typo in any of them would have been found by an
 * adopter, in their repository, in a file Pithy cannot fix.
 *
 * **The real stack, on a real port.** `startLiveApp` composes the capability the way `pithy add auth`
 * does — the CSRF publication, the rate limiter, the session middleware, Better Auth's own routes —
 * over Miniflare's D1 with the real migrations. It reaches Cloudflare for nothing, so this is an
 * ordinary unit-suite test rather than an integration one.
 *
 * **The fetch below behaves like a browser deliberately**: it carries a cookie jar and attaches `Origin`
 * to a mutating request, neither of which Node's own `fetch` does. That is what makes the assertions
 * about the wire mean anything — and it is how the 415 on `/sign-out` was found, a defect that had been
 * frozen into every scaffolded app since the screen was written, invisible because the screen navigated
 * away without reading the answer.
 */

/** The mount path this suite pins. Stated, never defaulted — the primitive is asked to join it. */
const BASE_PATH = "/auth";

/** Whoever this suite signs in. Never a real address; nothing here sends mail anywhere. */
const EMAIL = "round-trip@example.test";

/**
 * A fetch that behaves the way a browser does on a same-origin request.
 *
 * The path arrives relative, because that is all `callAuth` ever produces; this resolves it against the
 * app's origin the way a page served from it would. Cookies are kept, and `Origin` is attached to
 * anything that is not a GET — both of which a real browser does and neither of which Node's `fetch`
 * does on its own.
 */
function browserLike(origin: string, sendOrigin = true): AuthFetch {
  const jar = new Map<string, string>();
  return async (path, init) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    if (sendOrigin && method !== "GET") headers.set("origin", origin);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await fetch(`${origin}${path}`, { method, headers, body: init?.body });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const split = pair.indexOf("=");
      if (split > 0) jar.set(pair.slice(0, split).trim(), pair.slice(split + 1));
    }
    return response;
  };
}

let app: LiveApp;

beforeAll(async () => {
  app = await startLiveApp({ basePath: BASE_PATH });
});

afterAll(async () => {
  await app?.close();
  resetLiveSecrets();
});

describe("the six calls, against the routes they name", () => {
  test("nobody is signed in, and that is an answer rather than a failure", async () => {
    const result = await getSession({ basePath: BASE_PATH, fetch: browserLike(app.origin) });
    expect(result).toEqual({ ok: true, value: null });
  });

  test("the magic link reaches the route that mails one", async () => {
    const before = (await app.enqueued()).length;
    const result = await sendMagicLink(
      { email: EMAIL, callbackURL: `${app.origin}/callback` },
      { basePath: BASE_PATH, fetch: browserLike(app.origin) },
    );
    expect(result.ok).toBe(true);
    const enqueued = await app.enqueued();
    expect(enqueued.length).toBe(before + 1);
    expect(enqueued.at(-1)).toEqual({ template: "magicLink", to: EMAIL });
  });

  test("the code route reaches the route that mails one", async () => {
    const before = (await app.enqueued()).length;
    const result = await sendOtp(
      { email: EMAIL, type: "sign-in" },
      { basePath: BASE_PATH, fetch: browserLike(app.origin) },
    );
    expect(result.ok).toBe(true);
    expect((await app.enqueued()).length).toBe(before + 1);
  });

  test("a code that is not the one is a renderable refusal, never a throw", async () => {
    const result = await signInWithOtp(
      { email: EMAIL, otp: "000000" },
      { basePath: BASE_PATH, fetch: browserLike(app.origin) },
    );
    expect(result.ok).toBe(false);
    // The server's public message, read off the error envelope. `detail` never crosses the codec, so
    // what a screen can render is exactly this.
    if (!result.ok) expect(typeof result.failure.message).toBe("string");
  });

  test("a provider with no credential behind it is named as unconfigured, not as a dead button", async () => {
    // Google is off in this composition, so the route refuses rather than minting an authorization URL.
    // Either way the screen gets an outcome it has copy for — which is the whole point of the union.
    const started = await startSocialSignIn(
      { provider: "google", callbackURL: `${app.origin}/callback` },
      { basePath: BASE_PATH, fetch: browserLike(app.origin) },
    );
    expect(started.kind).not.toBe("authorize");
  });

  test("signing out reaches the route that ends a session", async () => {
    const result = await signOut({ basePath: BASE_PATH, fetch: browserLike(app.origin) });
    expect(result.ok).toBe(true);
  });
});

describe("what the primitive refuses before the wire", () => {
  /**
   * **The client half of the CSRF rule is checked here rather than the server half, and the split is
   * deliberate.** `publishSameOrigin` guards cookie-authenticated mutating routes and Better Auth
   * guards its own; `csrf.test.ts` holds that side, and a passwordless sign-in *start* carries no
   * ambient credential to forge, so it is correctly not among them. What belongs to this module is the
   * other half: `credentials: "include"` is only safe because the request cannot leave this origin, and
   * a `basePath` is adopter config.
   */
  test("a basePath naming somewhere else never reaches the network at all", async () => {
    let attempts = 0;
    const counting: AuthFetch = async (path, init) => {
      attempts += 1;
      return browserLike(app.origin)(path, init);
    };
    const result = await sendMagicLink(
      { email: EMAIL, callbackURL: `${app.origin}/callback` },
      { basePath: "https://evil.example/auth", fetch: counting },
    );
    expect(result.ok).toBe(false);
    expect(attempts, "the cookie mode was handed to somebody else's host").toBe(0);
  });

  test("and the configured one does reach it — the refusal is not simply always on", async () => {
    let attempts = 0;
    const counting: AuthFetch = async (path, init) => {
      attempts += 1;
      return browserLike(app.origin)(path, init);
    };
    const result = await sendMagicLink(
      { email: EMAIL, callbackURL: `${app.origin}/callback` },
      { basePath: BASE_PATH, fetch: counting },
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(1);
  });
});
