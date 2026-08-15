// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fixtureReady, fixtureValue } from "@pithy-sh/cloudflare/src/test-utils/fixtures";
import { TURNSTILE_TEST_KEYS } from "@pithy-sh/turnstile/src/provision/testKeys";
import { afterAll, describe, expect, test } from "vitest";
import { type LiveApp, resetLiveSecrets, startLiveApp } from "../test-utils/liveApp";

/**
 * LIVE — the Turnstile gate on the passwordless sign-in routes, against Cloudflare's real siteverify
 * (#84).
 *
 * ## Two suites, one set of assertions, and only one of them needs a widget
 *
 * A gate that has only ever been watched passing cannot tell you it is enforcing anything, so what is
 * asserted here is mostly refusal: a request with no token, a request with a token that is not one, and
 * — the case a real widget alone can answer — whether Cloudflare recognises the secret at all.
 *
 * The two describes below run **the same helpers** against two different secrets:
 *
 * - **`real widget`** is gated on the `turnstile-widget` fixture. It is the only place a secret
 *   Cloudflare has actually registered is exercised.
 * - **`documented test keys`** needs no fixture, only the network. It runs those same helpers against
 *   Cloudflare's published test secrets, so the assertions above are demonstrably not vacuous even on a
 *   machine that has no widget — which, while nobody has made one, is every machine.
 *
 * `metadata.result_with_testing_key` is what separates them, and it is Cloudflare's own flag rather
 * than a string comparison against a list we maintain: siteverify sets it on every answer produced by a
 * documented test key and on no answer produced by a real widget. So the real-widget suite asserts its
 * fixture is **not** a test key, live, and a fixture wrongly filled in with `1x0000…AA` fails loudly
 * instead of certifying a gate that never ran.
 *
 * ## The pass-then-forward path, and what is still out of reach
 *
 * It used to be uncovered, and the reason was #374: `createAuthRoutes` stacks the gate as
 * `turnstile({ action: "login" })`, a documented test key's answer carries **no action at all**, and the
 * binding therefore denied the always-pass secret too — so dev and staging could not sign in and no live
 * suite could watch the gate let anything through. The middleware now relaxes that binding for exactly
 * that answer, in exactly the two environments a test key is provisioned into, and the dev case below
 * signs in end to end: through the gate, into Better Auth, out as an enqueued magic link. That is also
 * the first live cover #74's `c.req.raw.clone()` fix has had.
 *
 * What a real widget would still add is the **action binding biting**: a token minted for one action and
 * replayed against another. No key available here returns an action at all, so a mismatch cannot be
 * produced from this side; it is asserted in `@pithy-sh/turnstile`'s own suites, including against a
 * test-key answer that *does* carry a differing action.
 *
 * ## Gate
 *
 * `turnstile-widget`, for the first describe only. Absent, that describe skips and the run stays green;
 * `globalSetup` prints which fixture was missing and where to make it. See
 * `docs/FIXTURES.md#turnstile-widget`.
 */

/** The mount path these apps pin. Stated, never defaulted — the redirect and route surface hang off it. */
const BASE_PATH = "/auth";

/** Cloudflare's server-side verification endpoint, for the case that asks it about a secret directly. */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** A response token that is not one. Never solved by anything; siteverify rejects it on sight. */
const NOT_A_TOKEN = "not-a-token-and-never-was";

/** siteverify's answer, narrowed to what these cases read — the HTTP status included, because it varies. */
interface SiteverifyAnswer {
  /** The HTTP status. 200 for a secret Cloudflare knows, 400 for one it does not. */
  status: number;
  success: boolean;
  "error-codes": string[];
  metadata?: { result_with_testing_key?: boolean };
}

const WIDGET_READY = fixtureReady("turnstile-widget");

afterAll(() => {
  resetLiveSecrets();
});

describe.skipIf(!WIDGET_READY)("turnstile gate, a real widget — LIVE", () => {
  const secretKey = (): string => fixtureValue("turnstile-widget", "TURNSTILE_SECRET_KEY");

  test("Cloudflare recognises the secret, and it is not a documented test key", async () => {
    const answer = await siteverify(secretKey());
    // A secret Cloudflare does not know answers HTTP 400 and `invalid-input-secret`; a registered one
    // answers 200 and gets as far as judging the token. So this separates a real widget's key from a
    // string, in one request.
    expect(answer.status).toBe(200);
    expect(answer["error-codes"]).toContain("invalid-input-response");
    expect(answer["error-codes"]).not.toContain("invalid-input-secret");
    // And Cloudflare's own flag, rather than a list of test keys kept in this repo: a fixture filled in
    // with `1x0000…AA` would satisfy every other assertion in this file while proving nothing.
    expect(answer.metadata?.result_with_testing_key).toBeUndefined();
  });

  test("a sign-in with no token is refused, and no mail is enqueued", async () => {
    await expectNoTokenRefused(secretKey());
  });

  test("a sign-in with a token that is not one is refused, and no mail is enqueued", async () => {
    await expectBogusTokenRefused(secretKey());
  });
});

describe("turnstile gate, Cloudflare's documented test keys — LIVE", () => {
  test("Cloudflare recognises the always-fail test secret, and says it is a testing key", async () => {
    const answer = await siteverify(TURNSTILE_TEST_KEYS.secret.fail);
    expect(answer.status).toBe(200);
    expect(answer["error-codes"]).toContain("invalid-input-response");
    expect(answer["error-codes"]).not.toContain("invalid-input-secret");
    // The other side of the discriminator the real-widget suite leans on. Asserted here so that a
    // Cloudflare change to this flag fails on a machine with no widget, rather than silently turning
    // the real-widget suite's guard into a tautology on the one machine that has one.
    expect(answer.metadata?.result_with_testing_key).toBe(true);
  });

  test("a secret Cloudflare does not know is rejected as a secret, not as a token", async () => {
    // The refutation the two cases above rest on. Without it, "error-codes mentions the response" would
    // be indistinguishable from "Cloudflare says that about everything".
    const answer = await siteverify("0x0000000000000000000000000000000ZZ");
    expect(answer.status).toBe(400);
    expect(answer["error-codes"]).toContain("invalid-input-secret");
    expect(answer["error-codes"]).not.toContain("invalid-input-response");
  });

  test("a sign-in with no token is refused, and no mail is enqueued", async () => {
    await expectNoTokenRefused(TURNSTILE_TEST_KEYS.secret.fail);
  });

  test("a sign-in with a token that is not one is refused, and no mail is enqueued", async () => {
    await expectBogusTokenRefused(TURNSTILE_TEST_KEYS.secret.fail);
  });

  test("a dev sign-in completes: the always-pass test secret passes the gate, and the mail is enqueued", async () => {
    // #374, and the case this file used to state as a ceiling. Cloudflare's always-pass secret answers
    // `success: true` with **no `action` field**, the gate is stacked as `action: "login"`, and the
    // binding therefore compared "login" against nothing and denied every dev and staging sign-in.
    //
    // The enqueued row is the half that makes this a sign-in rather than a status code: the gate let the
    // request reach Better Auth, which enqueued a magic link. A 200 alone would also be answered by a
    // gate that ran the handler and then denied.
    const app = await startLiveApp({
      basePath: BASE_PATH,
      environment: "dev",
      turnstile: { mode: "visible", secretKey: TURNSTILE_TEST_KEYS.secret.pass },
    });
    try {
      const response = await magicLink(app, NOT_A_TOKEN);
      expect(response.status).toBe(200);
      expect(await app.enqueued()).toEqual([{ template: "magicLink", to: "someone@example.test" }]);
    } finally {
      await app.close();
    }
  });

  test("the same secret in prod is refused, and named as a misconfiguration", async () => {
    // The exception is scoped to the two environments provisioning wires a test key into, and this is
    // the other side of it. Same secret, same route, same live siteverify — one var apart. Without this
    // case, "the always-pass key signs in" would be indistinguishable from a gate that stopped
    // enforcing the action binding everywhere.
    const app = await startLiveApp({
      basePath: BASE_PATH,
      environment: "prod",
      turnstile: { mode: "visible", secretKey: TURNSTILE_TEST_KEYS.secret.pass },
    });
    try {
      const response = await magicLink(app, NOT_A_TOKEN);
      expect(response.status).toBe(500);
      expect(await codeOf(response)).toBe("turnstile/config");
      expect(await app.enqueued()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  test("a secret Cloudflare does not know is a misconfiguration, not a failed challenge", async () => {
    // The gate's answer to the 400 asserted two cases above. It is the operator-facing half of #374:
    // a wrong secret refused every caller under `turnstile/failed`, which sends whoever is debugging it
    // to look at the user.
    const app = await startLiveApp({
      basePath: BASE_PATH,
      turnstile: { mode: "visible", secretKey: "0x0000000000000000000000000000000ZZ" },
    });
    try {
      const response = await magicLink(app, NOT_A_TOKEN);
      expect(response.status).toBe(500);
      expect(await codeOf(response)).toBe("turnstile/config");
      expect(await app.enqueued()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  test("a route the gate does not guard is untouched by it", async () => {
    // The gate is composed, and `sign-up` — a route `createAuthRoutes` never stacks it on — still
    // answers for itself. Without this, "the gate denied everything" would satisfy every case above.
    const app = await startLiveApp({
      basePath: BASE_PATH,
      turnstile: { mode: "visible", secretKey: TURNSTILE_TEST_KEYS.secret.fail },
    });
    try {
      const response = await fetch(`${app.origin}${BASE_PATH}/get-session`, { headers: { origin: app.origin } });
      expect(response.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

/**
 * Both gated routes, with no token at all: 400 `turnstile/missing_token`, and nothing enqueued.
 *
 * The second half is what makes this a gating test rather than a status-code test. A 400 alone would
 * also be returned by a gate that had already let the handler run — and a magic link that has been sent
 * is sent, whatever the caller is told afterwards.
 */
async function expectNoTokenRefused(secretKey: string): Promise<void> {
  const app = await startLiveApp({ basePath: BASE_PATH, turnstile: { mode: "visible", secretKey } });
  try {
    const link = await magicLink(app);
    expect(link.status).toBe(400);
    expect(await codeOf(link)).toBe("turnstile/missing_token");

    const otp = await sendOtp(app);
    expect(otp.status).toBe(400);
    expect(await codeOf(otp)).toBe("turnstile/missing_token");

    expect(await app.enqueued()).toHaveLength(0);
  } finally {
    await app.close();
  }
}

/** Both gated routes, with a token siteverify rejects: 403 `turnstile/failed`, and nothing enqueued. */
async function expectBogusTokenRefused(secretKey: string): Promise<void> {
  const app = await startLiveApp({ basePath: BASE_PATH, turnstile: { mode: "visible", secretKey } });
  try {
    const link = await magicLink(app, NOT_A_TOKEN);
    expect(link.status).toBe(403);
    expect(await codeOf(link)).toBe("turnstile/failed");

    const otp = await sendOtp(app, NOT_A_TOKEN);
    expect(otp.status).toBe(403);
    expect(await codeOf(otp)).toBe("turnstile/failed");

    expect(await app.enqueued()).toHaveLength(0);
  } finally {
    await app.close();
  }
}

/** Ask siteverify about a secret, with a token it will certainly reject. */
async function siteverify(secret: string): Promise<SiteverifyAnswer> {
  const response = await fetch(SITEVERIFY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, response: NOT_A_TOKEN }),
  });
  return { status: response.status, ...((await response.json()) as Omit<SiteverifyAnswer, "status">) };
}

/** Request a magic link, as the sign-in form does — with the widget's token when it has one. */
function magicLink(app: LiveApp, token?: string): Promise<Response> {
  return post(app, `${BASE_PATH}/sign-in/magic-link`, { email: "someone@example.test" }, token);
}

/** Request an email OTP, as the sign-in form does. */
function sendOtp(app: LiveApp, token?: string): Promise<Response> {
  return post(
    app,
    `${BASE_PATH}/email-otp/send-verification-otp`,
    { email: "someone@example.test", type: "sign-in" },
    token,
  );
}

/** A JSON post from the app's own origin, carrying the widget's token in the field the widget names. */
function post(app: LiveApp, path: string, body: Record<string, string>, token?: string): Promise<Response> {
  const payload = token === undefined ? body : { ...body, "cf-turnstile-response": token };
  return fetch(`${app.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.origin },
    body: JSON.stringify(payload),
  });
}

/** The Pithy error code a refused request carries. */
async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
