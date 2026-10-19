// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthInstance } from "../instance/auth";
import type { SessionSecretVersions } from "../instance/sessionSecrets";
import { resignCredentials, signCredential, verifyCredential, withResignedCredentials } from "./credentialResign";

/** The version set `withResignedCredentials` reads, set per test. */
const secrets = vi.hoisted(() => ({
  resolve: async (): Promise<SessionSecretVersions> => {
    throw new Error("no version set for this test");
  },
}));
vi.mock("../instance/secrets", () => ({ resolveSessionSecrets: () => secrets.resolve() }));

const OLD = "old-session-secret-000000000000000000000000";
const NEW = "new-session-secret-000000000000000000000000";
const COOKIE = "better-auth.session_token";
const DONT_REMEMBER = "better-auth.dont_remember";

describe("signCredential / verifyCredential — Better Auth's signed-cookie format", () => {
  test("signs as `value.signature` with a 44-character base64 HMAC-SHA256, the shape better-call verifies", async () => {
    const signed = await signCredential("token-abc", NEW);
    const [value, signature] = [signed.slice(0, signed.lastIndexOf(".")), signed.slice(signed.lastIndexOf(".") + 1)];
    expect(value).toBe("token-abc");
    expect(signature).toHaveLength(44);
    expect(signature.endsWith("=")).toBe(true);
  });

  test("names which of the keys it verifies under, and refuses one signed under none", async () => {
    const signed = await signCredential("token-abc", OLD);
    expect(await verifyCredential(signed, [NEW, OLD])).toEqual({ value: "token-abc", key: 1 });
    expect(await verifyCredential(signed, [NEW])).toBeNull();
    expect(await verifyCredential("token-abc", [OLD])).toBeNull();
    expect(await verifyCredential("token-abc.not-a-signature", [OLD])).toBeNull();
  });
});

describe("resignCredentials — a credential signed before a rotation, carried across it (#602)", () => {
  test("a session cookie signed under a retained version is re-signed under the current one", async () => {
    const old = encodeURIComponent(await signCredential("token-abc", OLD));
    const headers = new Headers({ cookie: `theme=dark; ${COOKIE}=${old}` });
    const result = await resignCredentials(headers, { current: NEW, prior: [OLD] }, [COOKIE]);

    const fresh = await signCredential("token-abc", NEW);
    expect(result?.cookies).toEqual([{ name: COOKIE, value: fresh }]);
    // The request now carries the re-signed cookie, and nothing else about it changed.
    expect(result?.headers.get("cookie")).toBe(`theme=dark; ${COOKIE}=${encodeURIComponent(fresh)}`);
  });

  test("a bearer credential signed under a retained version is re-signed too, so a mobile client is not signed out", async () => {
    const old = await signCredential("token-abc", OLD);
    const headers = new Headers({ authorization: `Bearer ${encodeURIComponent(old)}` });
    const result = await resignCredentials(headers, { current: NEW, prior: [OLD] }, [COOKIE]);

    const fresh = await signCredential("token-abc", NEW);
    expect(result?.bearer).toBe(fresh);
    expect(result?.headers.get("authorization")).toBe(`Bearer ${fresh}`);
  });

  test("a credential already under the current version, or under none, is left exactly as it came", async () => {
    const current = encodeURIComponent(await signCredential("token-abc", NEW));
    expect(
      await resignCredentials(new Headers({ cookie: `${COOKIE}=${current}` }), { current: NEW, prior: [OLD] }, [
        COOKIE,
      ]),
    ).toBeNull();
    const forged = encodeURIComponent(await signCredential("token-abc", "nobody-holds-this-0000000000000000000000"));
    expect(
      await resignCredentials(new Headers({ cookie: `${COOKIE}=${forged}` }), { current: NEW, prior: [OLD] }, [COOKIE]),
    ).toBeNull();
    // A raw bearer token carries no signature: Better Auth signs it itself, under whatever is current.
    expect(
      await resignCredentials(new Headers({ authorization: "Bearer token-abc" }), { current: NEW, prior: [OLD] }, [
        COOKIE,
      ]),
    ).toBeNull();
  });

  test("with no prior version there is nothing to carry across, and nothing is parsed", async () => {
    const old = encodeURIComponent(await signCredential("token-abc", OLD));
    expect(
      await resignCredentials(new Headers({ cookie: `${COOKIE}=${old}` }), { current: NEW, prior: [] }, [COOKIE]),
    ).toBeNull();
  });

  test("a cookie this does not own is never touched, whatever it is signed with", async () => {
    const old = encodeURIComponent(await signCredential("token-abc", OLD));
    expect(
      await resignCredentials(new Headers({ cookie: `someone-else=${old}` }), { current: NEW, prior: [OLD] }, [COOKIE]),
    ).toBeNull();
  });
});

describe("withResignedCredentials — the middleware that carries a request across a rotation (#602)", () => {
  const WEEK = 604_800;
  const rotated: SessionSecretVersions = { currentVersion: "2", versions: { "1": OLD, "2": NEW } };
  const attributes = { path: "/", httpOnly: true, secure: true, sameSite: "lax" };
  const instance = {
    $context: Promise.resolve({
      authCookies: {
        sessionToken: { name: COOKIE, attributes },
        dontRememberToken: { name: DONT_REMEMBER, attributes },
      },
      sessionConfig: { expiresIn: WEEK },
    }),
  } as unknown as AuthInstance;

  /** The middleware in front of three routes: one that echoes what it was handed, a sign-out, and a refresh. */
  function app(): Hono<PithyHonoEnv> {
    const built = new Hono<PithyHonoEnv>();
    built.use("*", (c, next) => withResignedCredentials(c, instance, next));
    built.get("/echo", (c) => {
      c.header("access-control-expose-headers", "x-request-id");
      return c.json({ cookie: c.req.header("cookie") ?? null, authorization: c.req.header("authorization") ?? null });
    });
    built.post("/sign-out", (c) => {
      c.header("set-cookie", `${COOKIE}=; Max-Age=0; Path=/`);
      return c.body(null, 200);
    });
    built.get("/session", (c) => {
      c.header("set-cookie", "better-auth.session_data=cached; Path=/");
      return c.body(null, 200);
    });
    built.get("/refresh", (c) => {
      c.header("set-auth-token", "handed-out-by-better-auth");
      return c.body(null, 200);
    });
    return built;
  }

  const old = async (value: string) => encodeURIComponent(await signCredential(value, OLD));
  const fresh = async (value: string) => encodeURIComponent(await signCredential(value, NEW));
  const lineFor = (response: Response, name: string) =>
    response.headers.getSetCookie().filter((line) => line.startsWith(`${name}=`));

  beforeEach(() => {
    secrets.resolve = async () => rotated;
  });

  test("the rest of the chain sees the re-signed cookie, and a remembered session's cookie lasts the session", async () => {
    const response = await app().request("/echo", { headers: { cookie: `theme=dark; ${COOKIE}=${await old("t")}` } });
    expect(await response.json()).toEqual({ cookie: `theme=dark; ${COOKIE}=${await fresh("t")}`, authorization: null });
    expect(lineFor(response, COOKIE)).toEqual([
      `${COOKIE}=${await fresh("t")}; Max-Age=${WEEK}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  test("a don't-remember-me session's cookies end with the browser: no Max-Age on either", async () => {
    const cookie = `${COOKIE}=${await old("t")}; ${DONT_REMEMBER}=${await old("true")}`;
    const response = await app().request("/echo", { headers: { cookie } });
    expect(lineFor(response, COOKIE)).toEqual([
      `${COOKIE}=${await fresh("t")}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(lineFor(response, DONT_REMEMBER)).toEqual([
      `${DONT_REMEMBER}=${await fresh("true")}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  test("a response that sets the cookie itself keeps its own: a sign-out is never undone by a re-signed cookie", async () => {
    const response = await app().request("/sign-out", {
      method: "POST",
      headers: { cookie: `${COOKIE}=${await old("t")}` },
    });
    expect(lineFor(response, COOKIE)).toEqual([`${COOKIE}=; Max-Age=0; Path=/`]);
  });

  test("a response that sets some other cookie keeps it, and still carries the re-signed session cookie", async () => {
    const response = await app().request("/session", { headers: { cookie: `${COOKIE}=${await old("t")}` } });
    expect(lineFor(response, "better-auth.session_data")).toEqual(["better-auth.session_data=cached; Path=/"]);
    expect(lineFor(response, COOKIE)).toEqual([
      `${COOKIE}=${await fresh("t")}; Max-Age=${WEEK}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  test("a bearer client is handed its re-signed token, and the header is exposed beside what the route exposed", async () => {
    const response = await app().request("/echo", { headers: { authorization: `Bearer ${await old("t")}` } });
    expect(await response.json()).toEqual({ cookie: null, authorization: `Bearer ${await signCredential("t", NEW)}` });
    expect(response.headers.get("set-auth-token")).toBe(await fresh("t"));
    expect(response.headers.get("access-control-expose-headers")).toBe("x-request-id, set-auth-token");
  });

  test("a response that hands out its own bearer token keeps it", async () => {
    const response = await app().request("/refresh", { headers: { authorization: `Bearer ${await old("t")}` } });
    expect(response.headers.get("set-auth-token")).toBe("handed-out-by-better-auth");
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
  });

  test("with nothing to re-sign, the request and the response pass through untouched", async () => {
    const response = await app().request("/echo", { headers: { cookie: `${COOKIE}=${await fresh("t")}` } });
    expect(await response.json()).toEqual({ cookie: `${COOKIE}=${await fresh("t")}`, authorization: null });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("access-control-expose-headers")).toBe("x-request-id");
  });

  test("a version set that cannot be read is not this middleware's to raise: the request goes on as it came", async () => {
    secrets.resolve = async () => {
      throw new Error("secrets D1 unavailable");
    };
    const cookie = `${COOKIE}=${await old("t")}`;
    const response = await app().request("/echo", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cookie, authorization: null });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
