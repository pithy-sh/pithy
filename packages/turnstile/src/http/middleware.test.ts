// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TURNSTILE_SECRET_NAME, type TurnstileSecrets, turnstileSecretsRegistry } from "../secret/registry";
import { siteverify, type TurnstileOptions, turnstile } from "./middleware";

const SECRET = "1x0000000000000000000000000000000AA";
/** The single secret holds one entry per configured widget. A one-widget app has one. */
const ONE_WIDGET: TurnstileSecrets = { visible: { key: SECRET } };

/**
 * A tiny app that stacks `turnstile()` on a public POST route, with the secret provisioned.
 *
 * There is no D1 in the Node project, so the value is installed on the shared accessor rather than
 * seeded as a row — `@pithy-sh/secrets`' `test-utils/secretFixtures` explains which idiom belongs to
 * which runtime. A case may pass `{}` to provision nothing, which is how "declared but never
 * provisioned" is expressed.
 */
function app(options?: TurnstileOptions, secrets: SecretFixture<typeof turnstileSecretsRegistry> = one(ONE_WIDGET)) {
  stubSecrets(turnstileSecretsRegistry, secrets);
  const hono = new Hono();
  hono.onError(pithyErrorHandler);
  hono.use("/protected", turnstile(options));
  hono.post("/protected", (c) => c.json({ ok: true }));
  return (init: RequestInit) => hono.request("/protected", { method: "POST", ...init }, {});
}

/** The fixture for turnstile's one secret — named so a case reads as the widgets it configures. */
const one = (secrets: TurnstileSecrets): SecretFixture<typeof turnstileSecretsRegistry> => ({
  [TURNSTILE_SECRET_NAME]: secrets,
});

/**
 * The same app, but the handler forwards the untouched request the way `@pithy-sh/auth`'s catch-all
 * hands `c.req.raw` to Better Auth. If the gate read the body off the request instead of a clone, this
 * handler throws "Body has already been read" on every request the gate LET THROUGH.
 */
function forwardingApp() {
  stubSecrets(turnstileSecretsRegistry, one(ONE_WIDGET));
  const hono = new Hono();
  hono.onError(pithyErrorHandler);
  hono.use("/protected", turnstile());
  hono.post("/protected", async (c) => {
    const forwarded = await c.req.raw.text();
    return c.json({ forwarded });
  });
  return (init: RequestInit) => hono.request("/protected", { method: "POST", ...init }, {});
}

/** Stub `fetch` to return a siteverify body. */
function stubSiteverify(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, statusText: "x", json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The siteverify form body from a stubbed `fetch` call. The call is asserted rather than
 * optional-chained: `calls[0]?.[1]` reads as safe but only defers the failure to a bare TypeError
 * on `.body`. Throwing here names what actually went wrong — fetch was never called.
 */
function sentBody(fetchMock: ReturnType<typeof stubSiteverify>, call = 0): URLSearchParams {
  const args = fetchMock.mock.calls[call];
  if (!args) throw new Error(`Expected fetch call #${call + 1}, but fetch was called ${fetchMock.mock.calls.length}x.`);
  return (args[1] as RequestInit).body as URLSearchParams;
}

/** The `code` from a `{ error: <public payload> }` response body. */
async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

describe("turnstile() middleware", () => {
  test("passes the request through when siteverify succeeds", async () => {
    const fetchMock = stubSiteverify({ success: true, "error-codes": [] });
    const res = await app()({
      headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "9.9.9.9" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const sent = sentBody(fetchMock);
    expect(sent.get("secret")).toBe(SECRET);
    expect(sent.get("response")).toBe("tok");
    expect(sent.get("remoteip")).toBe("9.9.9.9");
  });

  test("with two widgets, mode selects the right secret", async () => {
    const fetchMock = stubSiteverify({ success: true });
    const res = await app(
      { mode: "invisible" },
      one({ visible: { key: "vis-secret" }, invisible: { key: "inv-secret" } }),
    )({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(200);
    const sent = sentBody(fetchMock);
    expect(sent.get("secret")).toBe("inv-secret");
  });

  test("with two widgets and no mode, fails as turnstile/config (never opens)", async () => {
    const res = await app(
      undefined,
      one({ visible: { key: "v" }, invisible: { key: "i" } }),
    )({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe("turnstile/config");
  });

  test("reads the token from a JSON body field", async () => {
    stubSiteverify({ success: true });
    const res = await app()({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "cf-turnstile-response": "json-tok" }),
    });
    expect(res.status).toBe(200);
  });

  test("leaves a JSON body readable downstream — the gate reads a clone, never the request", async () => {
    stubSiteverify({ success: true });
    const body = JSON.stringify({ "cf-turnstile-response": "json-tok", email: "a@b.test" });
    const res = await forwardingApp()({ headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(200);
    // The whole original body reaches the handler, not an empty or half-consumed stream.
    expect(await res.json()).toEqual({ forwarded: body });
  });

  test("leaves a form body readable downstream too", async () => {
    stubSiteverify({ success: true });
    const body = new URLSearchParams({ "cf-turnstile-response": "tok", email: "a@b.test" });
    const res = await forwardingApp()({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: body.toString() });
  });

  test("reads the token from a header when configured", async () => {
    const fetchMock = stubSiteverify({ success: true });
    const res = await app({ header: "x-turnstile-token" })({
      headers: { "content-type": "application/json", "x-turnstile-token": "hdr-tok" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const sent = sentBody(fetchMock);
    expect(sent.get("response")).toBe("hdr-tok");
  });

  test("accepts when the returned action matches the configured action", async () => {
    stubSiteverify({ success: true, action: "login" });
    const res = await app({ action: "login" })({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(200);
  });

  test("denies (403) when the returned action does not match the configured action", async () => {
    stubSiteverify({ success: true, action: "signup" });
    const res = await app({ action: "login" })({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });

  test("does not send a request-body action (Turnstile uses a response field, not a param)", async () => {
    const fetchMock = stubSiteverify({ success: true });
    await app()({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    const sent = sentBody(fetchMock);
    expect(sent.get("action")).toBeNull();
  });

  test("400 turnstile/missing_token when no token is present", async () => {
    const res = await app()({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("turnstile/missing_token");
  });

  test("403 turnstile/failed when siteverify rejects the token", async () => {
    stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const res = await app()({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "bad" }),
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });

  test("500 turnstile/config when the secret is unreadable (reader error rewrapped to the gate contract)", async () => {
    // Declared, never provisioned — so the reader throws `secrets/not_found` and the gate must answer in
    // its own vocabulary rather than passing a stranger's code to the client. Which reader failure it is
    // does not matter here; that a reader failure closes the gate does. The failure modes of the read
    // itself (a malformed stored value, a missing master key) belong to `secretsStore`'s own suite.
    const res = await app(
      {},
      {},
    )({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe("turnstile/config");
  });

  test("fails closed (403) when siteverify is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const res = await app()({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });
});

describe("siteverify", () => {
  test("fails closed on a non-OK status", async () => {
    stubSiteverify({}, false, 500);
    await expect(siteverify("s", "t")).rejects.toMatchObject({ payload: { code: "turnstile/failed" } });
  });

  test("fails closed on an unexpected body shape", async () => {
    stubSiteverify({ unexpected: "shape" });
    await expect(siteverify("s", "t")).rejects.toMatchObject({ payload: { code: "turnstile/failed" } });
  });

  test("defaults error-codes to an empty array", async () => {
    stubSiteverify({ success: true });
    const result = await siteverify("s", "t");
    expect(result["error-codes"]).toEqual([]);
  });
});
