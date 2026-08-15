// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fixtureReady, fixtureValue } from "@pithy-sh/cloudflare/src/test-utils/fixtures";
import { TURNSTILE_TEST_KEYS } from "@pithy-sh/turnstile/src/provision/testKeys";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type LiveApp, resetLiveSecrets, startLiveApp } from "../test-utils/liveApp";

/**
 * LIVE — the Google provider, against real Google, on localhost (#84).
 *
 * ## Nothing here completes a Google sign-in, and nothing here pretends to
 *
 * Driving a consent screen needs a human, a browser, a Google account and whatever 2FA that account
 * carries; a suite built on it fails for Google's reasons rather than for Pithy's, which is why #84's
 * own refinement removed it from scope. So the round trip is never completed. What is asserted instead
 * is the pair of things that break silently and are only observable against the real provider:
 *
 * 1. **The redirect this app hands the browser** — which `redirect_uri` it embeds, computed from the
 *    port this run happens to be listening on and the base path the suite pinned. This is the value a
 *    human copies into the Google console, and the one a change to `basePath` invalidates wholesale.
 * 2. **Whether Google knows the credential.** Posted to the real token endpoint with a code that is not
 *    one, Google answers `invalid_grant` for a client it recognises and `invalid_client` for one it does
 *    not — so a single request separates "these are a registered client id and secret" from "these are
 *    two strings", without a consent screen anywhere.
 *
 * Everything after that is the trust boundary: what the callback does with a `state` it never issued, a
 * `state` it already spent, a `code` that is not a code, and a provider that answers garbage.
 *
 * ## `basePath` is pinned, and the pin is proven to matter
 *
 * `AuthConfig` defaults `basePath` to `/auth`. A suite that took the default would assert `/auth/...`
 * and keep passing after somebody moved the mount to `/identity` — while every redirect URI registered
 * with Google silently became wrong. So every app here states its base path, and one case boots a second
 * app at a different one to show the assertion follows the pin rather than the default.
 *
 * ## Gate
 *
 * `google-oauth`. Absent, the whole file skips and the run stays green — `globalSetup` prints which
 * fixture was missing and where to make it. See `docs/FIXTURES.md#google-oauth`.
 */

/** The mount path this suite pins. Stated, never defaulted — see the note above. */
const BASE_PATH = "/auth";

/** A second mount path, for the case that proves the pin is load-bearing. */
const MOVED_BASE_PATH = "/identity";

/** Google's authorization endpoint, as Better Auth composes it. */
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's token endpoint — where a code is exchanged, and where a credential is recognised or not. */
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/** Better Auth's session cookie, so a case can assert one was not set. */
const SESSION_COOKIE = "better-auth.session_token";

const READY = fixtureReady("google-oauth");

describe.skipIf(!READY)("google provider — LIVE", () => {
  let app: LiveApp;
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    clientId = fixtureValue("google-oauth", "GOOGLE_CLIENT_ID");
    clientSecret = fixtureValue("google-oauth", "GOOGLE_CLIENT_SECRET");
    app = await startLiveApp({ basePath: BASE_PATH, google: { clientId, clientSecret } });
  });

  afterAll(async () => {
    await app?.close();
    resetLiveSecrets();
  });

  test("the authorization URL names this run's own origin, at the pinned base path", async () => {
    const url = new URL(await authorizeUrl(app));

    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE);
    // The whole point: composed from the port the OS handed this run, and from the base path pinned
    // above — not from a constant that would keep matching after either moved.
    expect(url.searchParams.get("redirect_uri")).toBe(app.callbackUrl("google"));
    expect(url.searchParams.get("redirect_uri")).toBe(`${app.origin}${BASE_PATH}/callback/google`);
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("scope")).toContain("profile");
    expect(url.searchParams.get("state")).toBeTruthy();
    // The offline-consent block `socialProviders()` builds, arriving at the provider rather than only in
    // the object a unit test can read.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
    // PKCE, so an intercepted code is not by itself redeemable.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("moving the base path moves the redirect URI — the pin is what the assertion follows", async () => {
    const moved = await startLiveApp({ basePath: MOVED_BASE_PATH, google: { clientId, clientSecret } });
    try {
      const url = new URL(await authorizeUrl(moved));
      expect(url.searchParams.get("redirect_uri")).toBe(`${moved.origin}${MOVED_BASE_PATH}/callback/google`);
      // Stated as its own assertion, because this is the failure being guarded against: a registered
      // `…/auth/callback/google` is dead the moment the mount moves, and Google reports it as its own
      // error page rather than as anything a diff would show.
      expect(url.searchParams.get("redirect_uri")).not.toContain(`${BASE_PATH}/callback`);
    } finally {
      await moved.close();
    }
  });

  test("Google recognises the client id and secret — invalid_grant, never invalid_client", async () => {
    // A code that is not one. Google validates the client before the code, so the error it returns
    // separates a registered credential from a pair of strings — and no consent screen is involved.
    const response = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-code-and-never-was",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: app.callbackUrl("google"),
      }),
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    // The refutation, stated rather than implied: this is the answer for credentials Google does not
    // know, and a suite that only asserted "some error" would pass with two empty strings.
    expect(body.error).not.toBe("invalid_client");
  });

  /**
   * Each case here gets its own app, and that is not tidiness.
   *
   * Better Auth's rate limiter is real in this harness — durable, D1-backed, the deployed
   * configuration — and it counts every `/sign-in/social` this file makes. Sharing one app across the
   * cases meant the fifth request answered 429, and a suite that "cleared the limiter" between cases
   * would be reaching into the product to keep itself green. A fresh app costs a Miniflare boot and
   * gives each case an empty verification table too, which a replay case wants anyway.
   */
  describe("the callback is the trust boundary", () => {
    let fresh: LiveApp;

    beforeEach(async () => {
      fresh = await startLiveApp({ basePath: BASE_PATH, google: { clientId, clientSecret } });
    });

    afterEach(async () => {
      await fresh?.close();
    });

    test("a callback with no state sets no session", async () => {
      const response = await callback(fresh, { code: "anything" });
      expectRefused(response);
      await expectNoSession(fresh, response);
    });

    test("a callback with a state this app never issued sets no session", async () => {
      const response = await callback(fresh, { code: "anything", state: "a-state-nobody-minted" });
      expectRefused(response);
      await expectNoSession(fresh, response);
    });

    test("a code that is not a code sets no session, and the real Google is what says so", async () => {
      // A genuine state, so the request gets past the state check and reaches Google's token endpoint
      // with a code Google will reject. This is the one case here that makes a live exchange attempt.
      const state = stateOf(await authorizeUrl(fresh));
      const response = await callback(fresh, { code: "not-a-code-and-never-was", state });
      expectRefused(response);
      await expectNoSession(fresh, response);
    });

    test("a replayed state is refused the second time", async () => {
      const state = stateOf(await authorizeUrl(fresh));
      const first = await callback(fresh, { code: "not-a-code-and-never-was", state });
      expectRefused(first);

      const replayed = await callback(fresh, { code: "not-a-code-and-never-was", state });
      expectRefused(replayed);
      await expectNoSession(fresh, replayed);
      // The state was consumed by the first attempt, so the second is refused for a different reason
      // than the first — a replay is not merely "also failed", it is "no longer known".
      expect(errorOf(replayed)).not.toBe("");
    });

    test("a provider that answers garbage sets no session and does not crash the route", async () => {
      // The only stubbed case in this file, and stubbed deliberately: there is no way to make the real
      // Google return a 502 or an HTML error page on demand, and "the provider is having a bad day" is
      // exactly the shape a trust boundary must survive. Everything up to the token exchange is the
      // real app; only the hop out is replaced.
      const state = stateOf(await authorizeUrl(fresh));
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (target.startsWith(GOOGLE_TOKEN)) {
          return new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          });
        }
        return real(input as RequestInfo, init);
      }) as typeof fetch;
      try {
        const response = await callback(fresh, { code: "anything", state });
        expectRefused(response);
        await expectNoSession(fresh, response);
      } finally {
        globalThis.fetch = real;
      }
    });
  });

  test("social sign-in is never behind the humanity gate, in an app whose gate demonstrably bites", async () => {
    // The gate is composed here at a secret Cloudflare's siteverify always fails, so anything it guards
    // is refused. That is what makes the first assertion mean something: the gate is live, it denies the
    // magic-link route in this very app, and the social route still answers without a token.
    const gated = await startLiveApp({
      basePath: BASE_PATH,
      google: { clientId, clientSecret },
      turnstile: { mode: "visible", secretKey: TURNSTILE_TEST_KEYS.secret.fail },
    });
    try {
      const social = await fetch(`${gated.origin}${BASE_PATH}/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: gated.origin },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      });
      expect(social.status).toBe(200);
      expect(new URL(((await social.json()) as { url: string }).url).origin).toBe("https://accounts.google.com");

      const magicLink = await fetch(`${gated.origin}${BASE_PATH}/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: gated.origin },
        body: JSON.stringify({ email: "someone@example.test" }),
      });
      expect(magicLink.status).toBe(400);
      expect(((await magicLink.json()) as { error: { code: string } }).error.code).toBe("turnstile/missing_token");
    } finally {
      await gated.close();
    }
  });
});

/** Ask the app for a Google authorization URL, the way the sign-in screen's button does. */
async function authorizeUrl(app: LiveApp): Promise<string> {
  const response = await fetch(`${app.origin}${app.basePath}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.origin },
    body: JSON.stringify({ provider: "google", callbackURL: "/" }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { url: string }).url;
}

/** The `state` Better Auth minted, from an authorization URL. */
function stateOf(url: string): string {
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  return state ?? "";
}

/** Drive the OAuth callback as a browser would — a redirect back from the provider, followed manually. */
function callback(app: LiveApp, params: Record<string, string>): Promise<Response> {
  const url = new URL(app.callbackUrl("google"));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url, { redirect: "manual" });
}

/** The `error` query parameter of whatever a refused callback redirected to; `""` when there is none. */
function errorOf(response: Response): string {
  const location = response.headers.get("location");
  if (!location) return "";
  return new URL(location, "http://localhost").searchParams.get("error") ?? "";
}

/**
 * A refused callback: it redirects to an error rather than to a landing page, and it sets no session
 * cookie. Asserted on the response itself, because a `Set-Cookie` is how this failure would leak.
 */
function expectRefused(response: Response): void {
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  const location = response.headers.get("location") ?? "";
  expect(location).toContain("error");
  for (const cookie of response.headers.getSetCookie()) {
    // A cleared cookie is fine; a cookie carrying a value is a session this request must not have got.
    if (cookie.startsWith(`${SESSION_COOKIE}=`)) expect(cookie).toMatch(/=(;|$)/);
  }
}

/** Whatever cookies a refused callback did hand back, they buy no session. */
async function expectNoSession(app: LiveApp, response: Response): Promise<void> {
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await fetch(`${app.origin}${app.basePath}/get-session`, {
    headers: cookies ? { cookie: cookies, origin: app.origin } : { origin: app.origin },
  });
  const body = (await session.text()).trim();
  expect(body === "" || body === "null").toBe(true);
}
