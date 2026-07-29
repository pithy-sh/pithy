import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "../secret/registry";
import { siteverify, type TurnstileOptions, turnstile } from "./middleware";

// The middleware reads its secret through the shared per-invocation accessor, so configure it from
// turnstile's slice before each case (and reset after) — each case then resolves fresh from its env.
beforeEach(() => configureSharedSecrets({ registry: turnstileSecretsRegistry }));

const SECRET = "1x0000000000000000000000000000000AA";
/** The single binding holds a JSON object keyed by mode. A one-widget app has one entry. */
const ONE_WIDGET = JSON.stringify({ visible: { key: SECRET } });

/** A tiny app that stacks `turnstile()` on a public POST route, with the env binding seeded. */
function app(options?: TurnstileOptions, env: Record<string, unknown> = { [TURNSTILE_SECRET_NAME]: ONE_WIDGET }) {
  const hono = new Hono();
  hono.onError(pithyErrorHandler);
  hono.use("/protected", turnstile(options));
  hono.post("/protected", (c) => c.json({ ok: true }));
  return (init: RequestInit) => hono.request("/protected", { method: "POST", ...init }, env);
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
    const env = {
      [TURNSTILE_SECRET_NAME]: JSON.stringify({ visible: { key: "vis-secret" }, invisible: { key: "inv-secret" } }),
    };
    const res = await app(
      { mode: "invisible" },
      env,
    )({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "tok" }),
    });
    expect(res.status).toBe(200);
    const sent = sentBody(fetchMock);
    expect(sent.get("secret")).toBe("inv-secret");
  });

  test("with two widgets and no mode, fails as turnstile/config (never opens)", async () => {
    const env = { [TURNSTILE_SECRET_NAME]: JSON.stringify({ visible: { key: "v" }, invisible: { key: "i" } }) };
    const res = await app(
      undefined,
      env,
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

  test("500 turnstile/config when the secret is malformed (reader error rewrapped to the gate contract)", async () => {
    const res = await app(
      {},
      { [TURNSTILE_SECRET_NAME]: "not json" },
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
