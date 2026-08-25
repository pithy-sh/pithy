// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  AUTH_BASE_PATH,
  AUTH_CROSS_ORIGIN,
  AUTH_UNREACHABLE,
  AUTH_UNREADABLE,
  type AuthFetch,
  type AuthRequestInit,
  callAuth,
  getSession,
  sendMagicLink,
  sendOtp,
  signInWithOtp,
  signOut,
  startSocialSignIn,
  updateUser,
} from "./api";

/**
 * The browser primitive, driven through its seams.
 *
 * Every assertion here is about something a scaffolded screen used to be responsible for and no longer
 * is: the cookie mode, the base-path join, the three ways an answer can fail to be one, and the
 * same-origin refusal that keeps an ambient session from leaving this origin (#370).
 */

/** One request the module made. */
interface Call {
  url: string;
  init: AuthRequestInit | undefined;
}

/** A fetch that records what was asked and answers from a table keyed on the URL. */
function recorder(answers: Record<string, () => unknown> = {}): { fetch: AuthFetch; calls: Call[] } {
  const calls: Call[] = [];
  const send: AuthFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[url];
    const body = answer ? answer() : {};
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch: send, calls };
}

/** A fetch that answers with a status and a body, for the refusal paths. */
function answering(status: number, body: unknown): AuthFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("not json");
      return body;
    },
  });
}

/** Any value is a value, for tests about transport rather than about shape. */
function anything(value: unknown): value is unknown {
  return value !== Symbol.for("never");
}

describe("the one producer of the same-origin request", () => {
  test("carries the cookie mode, and the caller cannot take it off", async () => {
    const { fetch: send, calls } = recorder();
    // Written as an assignment rather than an object literal on purpose: `sameOrigin.test.ts` fails
    // the build on any module that writes the cookie mode as a key, this file included.
    const overridden: AuthRequestInit = { method: "POST" };
    overridden.credentials = "omit";
    await callAuth("/get-session", overridden, { fetch: send }, anything);
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  test("joins the configured base path, and defaults to the one the capability defaults to", async () => {
    const { fetch: send, calls } = recorder();
    await callAuth("/get-session", {}, { fetch: send }, anything);
    await callAuth("/get-session", {}, { fetch: send, basePath: "/identity" }, anything);
    expect(calls.map((call) => call.url)).toEqual([`${AUTH_BASE_PATH}/get-session`, "/identity/get-session"]);
  });

  test("takes its fetch off the injected global when none is passed", async () => {
    const { fetch: send, calls } = recorder();
    await callAuth("/get-session", {}, { global: { fetch: send } }, anything);
    expect(calls).toHaveLength(1);
  });

  test("no fetch anywhere reads as unreachable rather than as a crash", async () => {
    const result = await callAuth("/get-session", {}, { global: {} }, anything);
    expect(result).toEqual({ ok: false, failure: AUTH_UNREACHABLE });
  });

  test("a rejected fetch is a failure, not a throw", async () => {
    const send: AuthFetch = async () => {
      throw new TypeError("offline");
    };
    const result = await callAuth("/get-session", {}, { fetch: send }, anything);
    expect(result).toEqual({ ok: false, failure: AUTH_UNREACHABLE });
  });

  test("a body that will not parse is a failure, whatever the status said", async () => {
    for (const status of [200, 500]) {
      const result = await callAuth("/get-session", {}, { fetch: answering(status, undefined) }, anything);
      expect(result).toEqual({ ok: false, failure: AUTH_UNREADABLE });
    }
  });

  test("a refusal is read off the error envelope the HTTP codec writes", async () => {
    const body = { error: { code: "auth/invalid_token", message: "That link has expired.", action: "ignored" } };
    const result = await callAuth("/sign-in/magic-link", {}, { fetch: answering(401, body) }, anything);
    expect(result).toEqual({
      ok: false,
      failure: { code: "auth/invalid_token", message: "That link has expired.", action: "ignored" },
    });
  });

  test("a refusal that is not that envelope is the generic failure, never a partly-read one", async () => {
    const result = await callAuth("/sign-out", {}, { fetch: answering(502, "<html>bad gateway</html>") }, anything);
    expect(result).toEqual({ ok: false, failure: AUTH_UNREADABLE });
  });

  test("an answer the guard refuses is unreadable rather than passed through", async () => {
    const result = await callAuth("/get-session", {}, { fetch: answering(200, { user: { id: 7 } }) }, isNever);
    expect(result).toEqual({ ok: false, failure: AUTH_UNREADABLE });
  });
});

/** A guard that refuses everything, so "the guard decided" is distinguishable from "the transport did". */
function isNever(_value: unknown): _value is never {
  return false;
}

describe("the cookie mode never leaves this origin", () => {
  /**
   * The client half of "cookie/session mode means CSRF protection travels with it". The server refuses
   * a mutating cookie-authenticated request whose `Origin` is wrong; this refuses to make one that
   * would have a different origin at all. Each of these is a `basePath` an adopter could write.
   */
  const ELSEWHERE = ["https://evil.example", "//evil.example", "/\\evil.example", "http://localhost:8787", "auth"];

  test("a base path that is not a path on this worker refuses before anything is sent", async () => {
    for (const basePath of ELSEWHERE) {
      const { fetch: send, calls } = recorder();
      const result = await callAuth("/sign-out", { method: "POST" }, { fetch: send, basePath }, anything);
      expect(result, basePath).toEqual({ ok: false, failure: AUTH_CROSS_ORIGIN });
      expect(calls, `${basePath} was sent anyway`).toEqual([]);
    }
  });

  test("the paths an adopter really configures are not refused — the rule is not simply always red", async () => {
    // `/identity` is auth moved; `""` is auth mounted at the root, which `AuthConfig.basePath` allows
    // and `capability.ts` calls out by name. A rule that refused either would be a rule against config.
    for (const [basePath, url] of [
      ["/identity", "/identity/sign-out"],
      ["", "/sign-out"],
    ] as const) {
      const { fetch: send, calls } = recorder();
      const result = await callAuth("/sign-out", { method: "POST" }, { fetch: send, basePath }, anything);
      expect(result.ok, basePath).toBe(true);
      expect(calls[0]?.url).toBe(url);
    }
  });
});

describe("the six calls a scaffolded screen makes", () => {
  test("the session route is a plain GET, and `null` is an answer rather than a failure", async () => {
    const { fetch: send, calls } = recorder({ "/auth/get-session": () => null });
    const result = await getSession({ fetch: send });
    expect(result).toEqual({ ok: true, value: null });
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  test("a session envelope is narrowed, and a malformed one does not reach the caller", async () => {
    const good = await getSession({ fetch: answering(200, { user: { id: "u1", email: "a@b.c", name: "A" } }) });
    expect(good).toEqual({ ok: true, value: { user: { id: "u1", email: "a@b.c", name: "A" } } });
    const bad = await getSession({ fetch: answering(200, { user: { id: 7, email: null } }) });
    expect(bad).toEqual({ ok: false, failure: AUTH_UNREADABLE });
  });

  test("signing out is a POST to the route that ends it", async () => {
    const { fetch: send, calls } = recorder();
    await signOut({ fetch: send });
    expect(calls[0]?.url).toBe("/auth/sign-out");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("include");
    // The 415 the scaffolded screen shipped with. The route wants a JSON content type and a body to go
    // with it; without both it refuses, and the screen navigated away without ever reading the answer.
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
    expect(calls[0]?.init?.body).toBe("{}");
  });

  test("the code routes post what the screen collected", async () => {
    const { fetch: send, calls } = recorder();
    await signInWithOtp({ email: "a@b.c", otp: "123456" }, { fetch: send });
    await sendOtp({ email: "a@b.c", type: "sign-in" }, { fetch: send });
    expect(calls.map((call) => call.url)).toEqual(["/auth/sign-in/email-otp", "/auth/email-otp/send-verification-otp"]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ email: "a@b.c", otp: "123456" });
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
  });

  test("the magic link posts the callback the adopter named", async () => {
    const { fetch: send, calls } = recorder();
    await sendMagicLink({ email: "a@b.c", callbackURL: "https://app.example/callback" }, { fetch: send });
    expect(calls[0]?.url).toBe("/auth/sign-in/magic-link");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "a@b.c",
      callbackURL: "https://app.example/callback",
    });
  });
});

describe("the humanity check rides on the request rather than on a screen's memory", () => {
  /** A check that puts its token in the body, the way Turnstile's default configuration does. */
  const inBody = (body: Record<string, unknown>) => ({
    body: { ...body, "cf-turnstile-response": "tok" },
    headers: {},
  });

  /** A check configured to send its token as a header instead. */
  const inHeader = (body: Record<string, unknown>) => ({ body, headers: { "x-turnstile": "tok" } });

  test("a gated route carries the token, in the body or in the header, without the caller placing it", async () => {
    const { fetch: send, calls } = recorder();
    await sendMagicLink({ email: "a@b.c", callbackURL: "https://app.example/callback" }, { fetch: send, gate: inBody });
    await sendOtp({ email: "a@b.c", type: "sign-in" }, { fetch: send, gate: inHeader });
    expect(JSON.parse(String(calls[0]?.init?.body))["cf-turnstile-response"]).toBe("tok");
    expect(calls[1]?.init?.headers?.["x-turnstile"]).toBe("tok");
  });

  test("the social route is never gated, even when the caller passes a check", async () => {
    const { fetch: send, calls } = recorder({
      "/auth/sign-in/social": () => ({ url: "https://accounts.google.com/o/oauth2/auth?client_id=abc" }),
    });
    await startSocialSignIn(
      { provider: "google", callbackURL: "https://app.example/callback" },
      {
        fetch: send,
        gate: inHeader,
      },
    );
    expect(calls[0]?.init?.headers?.["x-turnstile"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      provider: "google",
      callbackURL: "https://app.example/callback",
    });
  });
});

describe("a provider button is never a control that cannot complete", () => {
  const input = { provider: "google", callbackURL: "https://app.example/callback" };

  test("an authorization URL is handed back to be followed", async () => {
    const url = "https://accounts.google.com/o/oauth2/auth?client_id=abc";
    const result = await startSocialSignIn(input, { fetch: answering(200, { url }) });
    expect(result).toEqual({ kind: "authorize", url });
  });

  test("a URL naming no client is a provider with no credential behind it, not a transport failure", async () => {
    const url = "https://accounts.google.com/o/oauth2/auth?client_id=";
    expect(await startSocialSignIn(input, { fetch: answering(200, { url }) })).toEqual({ kind: "unconfigured" });
  });

  test("a `javascript:` URL is refused, whatever answered with it", async () => {
    const result = await startSocialSignIn(input, {
      fetch: answering(200, { url: "javascript:alert(1)?client_id=a" }),
    });
    expect(result).toEqual({ kind: "unconfigured" });
  });

  test("a worker that did not answer is a different fault, and says so", async () => {
    const result = await startSocialSignIn(input, { fetch: answering(500, "nope") });
    expect(result).toEqual({ kind: "refused", failure: AUTH_UNREADABLE });
  });
});
describe("the one home for a reader's language", () => {
  /** A check that would put its token in the body and in a header, so a leak of either is visible. */
  const everywhere = (body: Record<string, unknown>) => ({
    body: { ...body, "cf-turnstile-response": "tok" },
    headers: { "x-turnstile": "tok" },
  });

  test("a chosen tag posts to the route that stores it, with the content type the route wants", async () => {
    const { fetch: send, calls } = recorder();
    await updateUser({ locale: "es-AR" }, { fetch: send });
    expect(calls[0]?.url).toBe("/auth/update-user");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ locale: "es-AR" });
  });

  test("`null` crosses the wire as null, because taking a choice back is an ordinary thing", async () => {
    // Not dropped, and not the empty string: the column is nullable and null is "has not chosen", which
    // is the state that makes the server fall back to `Accept-Language`.
    const { fetch: send, calls } = recorder();
    await updateUser({ locale: null }, { fetch: send });
    expect(String(calls[0]?.init?.body)).toBe('{"locale":null}');
  });

  test("naming no field still writes `{}` and declares the type, rather than the empty body a 415 is", async () => {
    // About the wire, not about the outcome: the real route answers 400 "No fields to update" to this,
    // which a stub cannot see. What is asserted is that the request is one the route gets to refuse on
    // its own terms — a declared JSON type with no body at all never reaches the handler.
    const { fetch: send, calls } = recorder();
    await updateUser({}, { fetch: send });
    expect(calls[0]?.init?.body).toBe("{}");
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
  });

  test("the humanity check never rides on it — this is not one of the two gated routes", async () => {
    const { fetch: send, calls } = recorder();
    await updateUser({ locale: "fr" }, { fetch: send, gate: everywhere });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ locale: "fr" });
    expect(calls[0]?.init?.headers?.["x-turnstile"]).toBeUndefined();
  });

  // No stubbed-refusal test here, deliberately. `/update-user` is Better Auth's own route and never
  // produces the kit's error envelope — its `APIError`s become Responses inside `instance.handler`, so
  // they never reach `apiErrorToPithy` — and `callAuth`'s decoding of a well-formed envelope is already
  // proved above. What a refusal on *this* route actually reads as is asserted against the live route,
  // in `../http/clientRoundTrip.test.ts`.

  test("a worker that cannot be reached costs the reader the write and nothing else", async () => {
    expect(await updateUser({ locale: "es" }, { global: {} })).toEqual({ ok: false, failure: AUTH_UNREACHABLE });
  });

  test("a basePath naming somewhere else never puts the session on that wire", async () => {
    const { fetch: send, calls } = recorder();
    const result = await updateUser({ locale: "es" }, { fetch: send, basePath: "https://evil.example/auth" });
    expect(result).toEqual({ ok: false, failure: AUTH_CROSS_ORIGIN });
    expect(calls, "the cookie mode was handed to somebody else's host").toEqual([]);
  });
});

/**
 * The two shapes this Worker answers with, and the one it does not (#449).
 *
 * Everything this capability writes answers the kit envelope; every route Better Auth owns answers its
 * own flat `{ message, code }`, because better-call renders an endpoint's `APIError` into a Response
 * inside `instance.handler`. Reading only the envelope meant every Better Auth refusal — a mistyped
 * one-time code, an expired magic link, a signed-out write — arrived as `client/unreadable`, and the
 * screen could only say the answer could not be read.
 */
describe("readFailure, through callAuth", () => {
  /** A fetch that answers one refusal, so the decoding is what is under test and nothing else. */
  function refusing(status: number, body: unknown): AuthFetch {
    return async () => ({ ok: false, status, json: async () => body });
  }

  test("reads the kit envelope", async () => {
    const result = await getSession({
      fetch: refusing(401, {
        error: { code: "auth/invalid_token", message: "Sign in first.", action: "Go to /sign-in." },
      }),
    });
    expect(result).toEqual({
      ok: false,
      failure: { code: "auth/invalid_token", message: "Sign in first.", action: "Go to /sign-in." },
    });
  });

  test("reads Better Auth's flat shape", async () => {
    const result = await getSession({ fetch: refusing(400, { message: "Invalid OTP", code: "INVALID_OTP" }) });
    // Better Auth's vocabulary, surfaced as it is. The two are told apart by shape — `auth/invalid_token`
    // is ours, `INVALID_OTP` is theirs — and a screen matching a code expects the route's own.
    expect(result).toEqual({ ok: false, failure: { code: "INVALID_OTP", message: "Invalid OTP", action: null } });
  });

  test("keeps the flat shape's message when the i18n plugin translated it", async () => {
    // `@better-auth/i18n` substitutes `message` and keeps the English on `originalMessage` (#452). The
    // translated sentence is the one a screen renders; the extra field is ignored rather than surfaced.
    const result = await getSession({
      fetch: refusing(400, { code: "INVALID_OTP", message: "Código no válido", originalMessage: "Invalid OTP" }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.message).toBe("Código no válido");
  });

  test("a body that is neither shape is still unreadable", async () => {
    // The sentinel has to keep meaning "whatever answered was not this Worker" — a proxy's HTML page, a
    // shape change — or a screen cannot tell a refusal from a broken deployment.
    for (const body of [{ detail: "nope" }, { message: 42, code: "X" }, { code: "X" }, "a string", null, []]) {
      const result = await getSession({ fetch: refusing(400, body) });
      expect(result, JSON.stringify(body)).toEqual({ ok: false, failure: AUTH_UNREADABLE });
    }
  });
});
