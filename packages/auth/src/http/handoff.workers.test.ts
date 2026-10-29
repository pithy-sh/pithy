// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthAuditActions } from "../audit/actions";
import { AuthConfig, type AuthWiring } from "../capability";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { HANDOFF_TTL_SECONDS } from "../token/handoff";
import { publishSameOrigin } from "./csrf";
import { HANDOFF_CHALLENGE_PARAM, HANDOFF_CODE_PARAM, handOffToApp } from "./handoff";
import { createSessionMiddleware } from "./middleware";
import { createRateLimitMiddleware } from "./rateLimit";
import { getAuthInstance } from "./resolve";
import { HandoffExchangeResponse } from "./responses";
import { createAuthRoutes } from "./routes";

/**
 * The one-time-token handoff, driven end to end: a GitHub sign-in started by a native app with its own deep link
 * as `callbackURL`, the provider's callback answered with a stubbed token endpoint, and the code the deep link
 * carries traded over `POST /auth/handoff`. Real routes, real D1, real encrypted secrets.
 */

const SECRET = "test-secret-please-rotate-0000000000";
const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_user_lifecycle",
  "pithy_auth_verification_outcomes",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
];
const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": SECRET,
  "auth-github-credentials": { clientId: "gh-client", clientSecret: "gh-secret" },
};

const DEEP_LINK = "myapp://auth/callback";
/** The origin of the app's universal link (iOS) or app link (Android): https, and in `trustedOrigins`. */
const APP_LINK_ORIGIN = "https://app.example.test";
const APP_LINK = `${APP_LINK_ORIGIN}/auth/callback`;

/** RFC 7636 appendix B: a verifier and the S256 challenge it hashes to. */
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const BOUND_LINK = `${DEEP_LINK}?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`;

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } satisfies RateLimit,
  };
}

function buildWiring(): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost", "myapp://", APP_LINK_ORIGIN],
      github: { enabled: true, allowSignUp: true },
    }),
    resolveGithubUserInfo: async () => ({
      user: { email: "ada@example.test", emailVerified: true, name: "Ada" },
      data: { id: 4242, name: "Ada", login: "ada", avatar_url: null },
    }),
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
  };
}

function buildApp(emit: AuditEmit): Hono<PithyHonoEnv> {
  const wiring = buildWiring();
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", emit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(wiring)(app);
  app.use(`${wiring.config.basePath}/*`, createRateLimitMiddleware(wiring.config.rateLimiterBinding));
  createSessionMiddleware(wiring)(app);
  createAuthRoutes(wiring)(app);
  return app;
}

function stubTokenEndpoint(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" });
    }
    throw new Error(`the callback reached out to ${url}; this suite calls nothing but the token endpoint`);
  });
}

function startSignIn(app: Hono<PithyHonoEnv>, callbackURL: string) {
  return app.request(
    "/auth/sign-in/social",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ provider: "github", callbackURL }),
    },
    appEnv(),
  );
}

/** The cookie jar a browser keeps for this origin: name to value, from the `Set-Cookie` lines it was handed. */
function jar(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** What the system browser's sign-in sheet opens: the GET that starts a native redirect sign-in. */
function startOnDevice(
  app: Hono<PithyHonoEnv>,
  query: { provider?: string; callbackURL?: string; errorCallbackURL?: string },
) {
  const search = new URLSearchParams(Object.entries(query).filter((pair): pair is [string, string] => !!pair[1]));
  return app.request(`/auth/sign-in/social/start?${search}`, { redirect: "manual" }, appEnv());
}

/** The provider's callback, carrying whatever the sheet's jar holds for this origin. */
function providerCallback(app: Hono<PithyHonoEnv>, state: string, cookie: string) {
  return app.request(
    `/auth/callback/github?code=the-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: cookie ? { cookie } : {} },
    appEnv(),
  );
}

/** The `state` the authorize URL a start answered with carries. */
function stateOf(authorize: string | null | undefined): string {
  const state = authorize ? new URL(authorize).searchParams.get("state") : null;
  if (!state) throw new Error("the authorize URL carried no state");
  return state;
}

/**
 * Start a native sign-in the way the sheet does, through the GET start route, and come back through the provider's
 * callback, unfollowed. The callback carries only the cookies the start's own answer set, as the sheet's jar would.
 */
async function completeSignIn(app: Hono<PithyHonoEnv>, callbackURL = BOUND_LINK): Promise<Response> {
  const started = await startOnDevice(app, { provider: "github", callbackURL });
  if (started.status !== 302) throw new Error(`sign-in/social/start answered ${started.status}`);
  return providerCallback(app, stateOf(started.headers.get("location")), jar(started));
}

/**
 * Start a sign-in over the JSON POST a web page makes, and come back through the callback with the same page's
 * cookies: what a browser does in cookie mode, and what a client that skipped the start route would do.
 */
async function completeWebSignIn(app: Hono<PithyHonoEnv>, callbackURL: string): Promise<Response> {
  const started = await startSignIn(app, callbackURL);
  if (started.status !== 200) throw new Error(`sign-in/social answered ${started.status}`);
  return providerCallback(app, stateOf((await started.json<{ url?: string }>()).url), jar(started));
}

function exchange(
  app: Hono<PithyHonoEnv>,
  code: string,
  headers: Record<string, string> = {},
  verifier: string = VERIFIER,
) {
  return app.request(
    "/auth/handoff",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code, verifier }),
    },
    appEnv(),
  );
}

function codeOf(response: Response): string {
  const location = response.headers.get("location");
  const code = location ? new URL(location).searchParams.get(HANDOFF_CODE_PARAM) : null;
  if (!code) throw new Error(`no handoff code on ${location}`);
  return code;
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: authSecretsRegistry });
  await seedSecrets(env, authSecretsRegistry, SECRETS);
  stubTokenEndpoint();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

describe("a redirect sign-in that ends on an app's deep link", () => {
  test("lands on the deep link with a one-time code, and no session rides along", async () => {
    const events: AuditEventInput[] = [];
    const callback = await completeSignIn(buildApp(async (event) => void events.push(event)));

    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(DEEP_LINK);
    expect(codeOf(callback)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The challenge stays with the code on the server; the link carries only the code.
    expect(location.searchParams.has(HANDOFF_CHALLENGE_PARAM)).toBe(false);

    // The session is not on the wire in any form: no cookie, no bearer header, not in the link.
    expect(callback.headers.getSetCookie().join("\n")).not.toContain("session_token");
    expect(callback.headers.get("set-auth-token")).toBeNull();
    const sessions = await env.DB.prepare("select token from pithy_auth_sessions").all<{ token: string }>();
    expect(sessions.results).toHaveLength(1);
    expect(callback.headers.get("location")).not.toContain(sessions.results[0]?.token ?? "?");

    expect(events.map((event) => event.action)).toContain(AuthAuditActions.handoffIssued);
  });

  test("the code trades once for the raw session token, which then authenticates as a bearer", async () => {
    const events: AuditEventInput[] = [];
    const app = buildApp(async (event) => void events.push(event));
    const code = codeOf(await completeSignIn(app));

    const traded = await exchange(app, code, { "x-pithy-device-id": "phone-1", "x-pithy-platform": "ios" });
    expect(traded.status).toBe(200);
    const body: unknown = await traded.json();
    expect(HandoffExchangeResponse.parse(body)).toEqual(body);
    const { token } = HandoffExchangeResponse.parse(body);
    const stored = await env.DB.prepare("select token, device_id from pithy_auth_sessions").first<{
      token: string;
      device_id: string | null;
    }>();
    expect(token).toBe(stored?.token);
    expect(stored?.device_id).toBe("phone-1");

    const devices = await app.request("/auth/devices", { headers: { authorization: `Bearer ${token}` } }, appEnv());
    expect(devices.status).toBe(200);
    expect(await devices.json()).toMatchObject({ devices: [{ id: "phone-1", platform: "ios" }] });

    expect(events).toContainEqual(
      expect.objectContaining({ action: AuthAuditActions.handoffExchanged, outcome: "success" }),
    );
  });

  test("a spent code is refused with the kit's code, and the refusal is on the trail", async () => {
    const events: AuditEventInput[] = [];
    const app = buildApp(async (event) => void events.push(event));
    const code = codeOf(await completeSignIn(app));
    expect((await exchange(app, code)).status).toBe(200);

    const again = await exchange(app, code);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "auth/handoff_invalid" } });
    expect(events).toContainEqual(
      expect.objectContaining({
        action: AuthAuditActions.handoffExchanged,
        outcome: "denied",
        metadata: { reason: "unknown" },
      }),
    );
  });

  test("a wrong verifier is refused with the same answer as a spent code, and spends the code", async () => {
    const events: AuditEventInput[] = [];
    const app = buildApp(async (event) => void events.push(event));
    const code = codeOf(await completeSignIn(app));

    const wrong = await exchange(app, code, {}, "a-verifier-some-other-app-made-up-0000000000");
    expect(wrong.status).toBe(400);
    const refusal = await wrong.json();
    expect(refusal).toMatchObject({ error: { code: "auth/handoff_invalid" } });
    expect(events).toContainEqual(
      expect.objectContaining({
        action: AuthAuditActions.handoffExchanged,
        outcome: "denied",
        metadata: { reason: "mismatch" },
      }),
    );

    // The right verifier, too late: the wrong one spent the code, and the answer is word for word the same.
    const right = await exchange(app, code);
    expect(right.status).toBe(400);
    expect(await right.json()).toEqual(refusal);
  });

  test("a sign-in whose deep link carries no challenge is never handed a code", async () => {
    const events: AuditEventInput[] = [];
    const callback = await completeWebSignIn(
      buildApp(async (event) => void events.push(event)),
      DEEP_LINK,
    );

    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    expect(location.searchParams.has(HANDOFF_CODE_PARAM)).toBe(false);
    expect(location.searchParams.get("error")).toBe("handoff_challenge_required");
    expect(callback.headers.getSetCookie().join("\n")).not.toContain("session_token");
    // The session the provider's callback made is unreachable, so it is not kept.
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const codes = await env.DB.prepare(
      "select count(*) as n from pithy_auth_verifications where identifier like 'pithy-handoff:%'",
    ).first<{ n: number }>();
    expect(codes?.n).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ action: AuthAuditActions.handoffIssued, outcome: "denied" }),
    );
  });

  test("a malformed verifier is refused with the same answer as a spent code, and spends the code", async () => {
    const events: AuditEventInput[] = [];
    const app = buildApp(async (event) => void events.push(event));
    const code = codeOf(await completeSignIn(app));

    const malformed = await exchange(app, code, {}, `${VERIFIER.slice(0, -1)}+`);
    expect(malformed.status).toBe(400);
    const refusal = await malformed.json();
    expect(refusal).toMatchObject({ error: { code: "auth/handoff_invalid" } });
    expect(events).toContainEqual(
      expect.objectContaining({
        action: AuthAuditActions.handoffExchanged,
        outcome: "denied",
        metadata: { reason: "malformed" },
      }),
    );

    const right = await exchange(app, code);
    expect(right.status).toBe(400);
    expect(await right.json()).toEqual(refusal);
  });

  test("a verifier too short or too long for RFC 7636 gets the same refusal, never a validation error", async () => {
    const app = buildApp(async () => {});
    for (const verifier of ["v", "a".repeat(42), "a".repeat(129)]) {
      const code = codeOf(await completeSignIn(app));
      const refused = await exchange(app, code, {}, verifier);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: "auth/handoff_invalid" } });
      expect((await exchange(app, code)).status).toBe(400);
    }
  });

  test("an expired code is refused with the same answer as a spent one", async () => {
    const app = buildApp(async () => {});
    const code = codeOf(await completeSignIn(app));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + HANDOFF_TTL_SECONDS * 1000 + 1_000);

    const late = await exchange(app, code);
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ error: { code: "auth/handoff_invalid" } });
  });

  test("a code whose session ended before the trade is refused, whether the session was revoked or expired", async () => {
    for (const end of [
      "delete from pithy_auth_sessions",
      `update pithy_auth_sessions set expires_at = '${new Date(Date.now() - 1_000).toISOString()}'`,
    ]) {
      const events: AuditEventInput[] = [];
      const app = buildApp(async (event) => void events.push(event));
      const code = codeOf(await completeSignIn(app));
      await env.DB.prepare(end).run();

      const refused = await exchange(app, code, { "x-pithy-device-id": "phone-1", "x-pithy-platform": "ios" });
      expect(refused.status, end).toBe(400);
      expect(await refused.json(), end).toMatchObject({ error: { code: "auth/handoff_invalid" } });
      expect(events, end).toContainEqual(
        expect.objectContaining({
          action: AuthAuditActions.handoffExchanged,
          outcome: "denied",
          metadata: { reason: "unknown" },
        }),
      );
      expect(
        events.some((event) => event.outcome === "success" && event.action === AuthAuditActions.handoffExchanged),
      ).toBe(false);
      const devices = await env.DB.prepare("select id from pithy_auth_devices where id = 'phone-1'").all();
      expect(devices.results, end).toEqual([]);
      await env.DB.prepare("delete from pithy_auth_sessions").run();
    }
  });

  test("a trade for a session already bound to a device leaves it bound there, and registers no other", async () => {
    const app = buildApp(async () => {});
    const code = codeOf(await completeSignIn(app));
    await env.DB.prepare("update pithy_auth_sessions set device_id = 'phone-1'").run();

    const traded = await exchange(app, code, { "x-pithy-device-id": "phone-2", "x-pithy-platform": "android" });
    expect(traded.status).toBe(200);
    const stored = await env.DB.prepare("select device_id from pithy_auth_sessions").first<{ device_id: string }>();
    expect(stored?.device_id).toBe("phone-1");
    const devices = await env.DB.prepare("select id from pithy_auth_devices where id = 'phone-2'").all();
    expect(devices.results).toEqual([]);
  });

  test("a code nobody issued is refused", async () => {
    const refused = await exchange(
      buildApp(async () => {}),
      "x".repeat(43),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "auth/handoff_invalid" } });
  });

  test("a deep link whose scheme is outside trustedOrigins is refused before the sign-in starts", async () => {
    const refused = await startSignIn(
      buildApp(async () => {}),
      "evilapp://auth/callback",
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "INVALID_CALLBACK_URL" });
  });

  test("a web callback is not handed off: the browser gets its cookie, as before", async () => {
    const app = buildApp(async () => {});
    const started = await startSignIn(app, "http://localhost/app");
    const authorize = (await started.json<{ url?: string }>()).url ?? "";
    const state = new URL(authorize).searchParams.get("state") ?? "";
    const cookies = started.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const callback = await app.request(
      `/auth/callback/github?code=the-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: cookies } },
      appEnv(),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost/app");
    expect(callback.headers.getSetCookie().join("\n")).toContain("session_token");
  });

  test("an https app link carrying a challenge is handed off like a custom scheme, and its code trades", async () => {
    const app = buildApp(async () => {});
    const callback = await completeSignIn(app, `${APP_LINK}?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`);

    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(APP_LINK);
    expect(location.searchParams.has(HANDOFF_CHALLENGE_PARAM)).toBe(false);
    expect(callback.headers.getSetCookie().join("\n")).not.toContain("session_token");
    expect(callback.headers.get("set-auth-token")).toBeNull();

    const traded = await exchange(app, codeOf(callback));
    expect(traded.status).toBe(200);
    const { token } = HandoffExchangeResponse.parse(await traded.json());
    const stored = await env.DB.prepare("select token from pithy_auth_sessions").first<{ token: string }>();
    expect(token).toBe(stored?.token);
  });

  test("an https callback with no challenge is a web page: it gets its cookie and no code", async () => {
    const callback = await completeWebSignIn(
      buildApp(async () => {}),
      APP_LINK,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(APP_LINK);
    expect(callback.headers.getSetCookie().join("\n")).toContain("session_token");
    const codes = await env.DB.prepare(
      "select count(*) as n from pithy_auth_verifications where identifier like 'pithy-handoff:%'",
    ).first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });

  test("an https app link outside trustedOrigins is refused before the sign-in starts", async () => {
    const refused = await startSignIn(
      buildApp(async () => {}),
      `https://evil.example.test/auth/callback?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "INVALID_CALLBACK_URL" });
  });

  test("a redirect to an untrusted https link with a challenge is refused, its session deleted, no code issued", async () => {
    const token = await webSessionToken(buildApp(async () => {}));
    const refused = await redirectThroughHandoff(
      `https://evil.example.test/auth/callback?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`,
      [["session_token", `${token}.some-signature`]],
    );

    expect(refused.status).toBe(403);
    expect(refused.headers.get("location")).toBeNull();
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const codes = await env.DB.prepare("select count(*) as n from pithy_auth_verifications").first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });

  test("an https link whose challenge is malformed gets the unbound error, not a cookie and not a code", async () => {
    const token = await webSessionToken(buildApp(async () => {}));
    const handed = await redirectThroughHandoff(`${APP_LINK}?${HANDOFF_CHALLENGE_PARAM}=not-a-challenge`, [
      ["session_token", `${token}.some-signature`],
    ]);

    expect(handed.status).toBe(302);
    const location = new URL(handed.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("handoff_challenge_required");
    expect(location.searchParams.has(HANDOFF_CODE_PARAM)).toBe(false);
    expect(handed.headers.getSetCookie().join("\n")).not.toContain("session_token");
  });

  test("a redirect to a scheme outside trustedOrigins that sets a session is refused, never handed off", async () => {
    const wiring = buildWiring();
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    app.use("*", async (c, next) => {
      c.set("emit", async () => {});
      await next();
    });
    app.get("/redirect", async (c) => {
      const instance = await getAuthInstance(c, wiring);
      const context = await instance.$context;
      const written = new Response(null, {
        status: 302,
        headers: [
          ["location", "evilapp://auth/callback"],
          ["set-cookie", `${context.authCookies.sessionToken.name}=some-token.some-signature; Path=/; HttpOnly`],
        ],
      });
      return (await handOffToApp(c, wiring, instance, written)) ?? written;
    });

    const refused = await app.request("/redirect", {}, appEnv());
    expect(refused.status).toBe(403);
    expect(refused.headers.get("location")).toBeNull();
    expect(refused.headers.getSetCookie()).toEqual([]);
    const codes = await env.DB.prepare("select count(*) as n from pithy_auth_verifications").first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });

  test("a refused untrusted scheme leaves no session behind, since nothing can reach it once its cookie is dropped", async () => {
    const token = await webSessionToken(buildApp(async () => {}));
    const refused = await redirectThroughHandoff(`evilapp://auth/callback?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`, [
      ["session_token", `${token}.some-signature`],
    ]);

    expect(refused.status).toBe(403);
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });

  test("every session cookie is dropped from a handoff, chunked cookie caches and the account cookie included", async () => {
    const token = await webSessionToken(buildApp(async () => {}));
    const handed = await redirectThroughHandoff(BOUND_LINK, [
      ["session_token", `${token}.some-signature`],
      ["session_data.0", "first-half-of-a-cached-session"],
      ["session_data.1", "second-half-of-a-cached-session"],
      ["account_data", "provider-tokens"],
      ["account_data.0", "provider-tokens-chunk"],
      ["unrelated", "kept"],
    ]);

    expect(handed.status).toBe(302);
    expect(codeOf(handed)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const names = handed.headers.getSetCookie().map((line) => line.slice(0, line.indexOf("=")));
    expect(names).toEqual(["unrelated"]);
  });
});

/** Sign in through a web callback and answer the raw session token the browser's cookie carries. */
async function webSessionToken(app: Hono<PithyHonoEnv>): Promise<string> {
  const started = await startSignIn(app, "http://localhost/app");
  const authorize = (await started.json<{ url?: string }>()).url ?? "";
  const state = new URL(authorize).searchParams.get("state") ?? "";
  const cookies = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const callback = await app.request(
    `/auth/callback/github?code=the-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { cookie: cookies } },
    appEnv(),
  );
  const line = callback.headers.getSetCookie().find((cookie) => cookie.includes("session_token="));
  const value = line ? decodeURIComponent(line.slice(line.indexOf("=") + 1, line.indexOf(";"))) : "";
  const token = value.split(".")[0];
  if (!token) throw new Error("the web sign-in set no session cookie");
  return token;
}

/**
 * A redirect to `location` setting the given cookies, each named by its suffix on Better Auth's cookie prefix
 * (or, for `unrelated`, as is), passed through {@link handOffToApp} as the callback would.
 */
async function redirectThroughHandoff(location: string, cookies: [string, string][]): Promise<Response> {
  const wiring = buildWiring();
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("emit", async () => {});
    await next();
  });
  app.get("/redirect", async (c) => {
    const instance = await getAuthInstance(c, wiring);
    const context = await instance.$context;
    const prefix = context.authCookies.sessionToken.name.slice(0, -"session_token".length);
    const written = new Response(null, {
      status: 302,
      headers: [
        ["location", location],
        ...cookies.map(([name, value]): [string, string] => [
          "set-cookie",
          `${name === "unrelated" ? name : `${prefix}${name}`}=${value}; Path=/; HttpOnly`,
        ]),
      ],
    });
    return (await handOffToApp(c, wiring, instance, written)) ?? written;
  });
  return app.request("/redirect", {}, appEnv());
}

describe("the GET that starts a native redirect sign-in in the system browser", () => {
  test("answers a redirect to the provider that sets the state cookie in the sheet's own jar", async () => {
    const started = await startOnDevice(
      buildApp(async () => {}),
      {
        provider: "github",
        callbackURL: BOUND_LINK,
        errorCallbackURL: "myapp://sign-in?provider=github",
      },
    );

    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(started.headers.getSetCookie().some((line) => /state=/.test(line.split(";")[0] ?? ""))).toBe(true);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const state = started.headers.getSetCookie().find((line) => /state=/.test(line.split(";")[0] ?? "")) ?? "";
    expect(state).toMatch(/; HttpOnly/);
    expect(state).toMatch(/; SameSite=Lax/);
    expect(state).toMatch(/; Path=\//);
    expect(state).toMatch(/; Max-Age=\d+/);
  });

  test("a start another site sent the browser to is refused: only the app's own sheet opens it", async () => {
    const app = buildApp(async () => {});
    for (const site of ["cross-site", "same-site"]) {
      const refused = await app.request(
        `/auth/sign-in/social/start?provider=github&callbackURL=${encodeURIComponent(BOUND_LINK)}`,
        { redirect: "manual", headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate" } },
        appEnv(),
      );
      expect(refused.status, site).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "auth/forbidden" } });
      expect(refused.headers.get("location")).toBeNull();
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
    const opened = await app.request(
      `/auth/sign-in/social/start?provider=github&callbackURL=${encodeURIComponent(BOUND_LINK)}`,
      { redirect: "manual", headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" } },
      appEnv(),
    );
    expect(opened.status).toBe(302);
  });

  test("a callback whose browser never held the state cookie is refused, and signs nobody in", async () => {
    const app = buildApp(async () => {});
    const started = await startOnDevice(app, { provider: "github", callbackURL: BOUND_LINK });
    const callback = await providerCallback(app, stateOf(started.headers.get("location")), "");

    expect(callback.status).toBe(302);
    const location = callback.headers.get("location") ?? "";
    expect(location).toMatch(/error=state/);
    expect(location).not.toContain(`${HANDOFF_CODE_PARAM}=`);
    expect(callback.headers.getSetCookie().join("\n")).not.toContain("session_token");
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });

  test("a callback with no handoff challenge is refused: the route exists only for the handoff", async () => {
    const refused = await startOnDevice(
      buildApp(async () => {}),
      { provider: "github", callbackURL: DEEP_LINK },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "validation/invalid_input" } });
    expect(refused.headers.getSetCookie()).toEqual([]);
  });

  test("a malformed handoff challenge is refused the same way", async () => {
    const refused = await startOnDevice(
      buildApp(async () => {}),
      {
        provider: "github",
        callbackURL: `${DEEP_LINK}?${HANDOFF_CHALLENGE_PARAM}=not-a-challenge`,
      },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "validation/invalid_input" } });
  });

  test("a callback or error callback outside trustedOrigins is refused before the provider is reached", async () => {
    const app = buildApp(async () => {});
    for (const query of [
      { provider: "github", callbackURL: `evilapp://auth/callback?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}` },
      {
        provider: "github",
        callbackURL: `https://evil.example.test/auth/callback?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`,
      },
      { provider: "github", callbackURL: BOUND_LINK, errorCallbackURL: "evilapp://sign-in" },
    ]) {
      const refused = await startOnDevice(app, query);
      expect(refused.status, JSON.stringify(query)).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "auth/forbidden" } });
      expect(refused.headers.get("location")).toBeNull();
    }
  });

  test("a provider this Worker has not enabled is not found, and one it does not know is not valid", async () => {
    const app = buildApp(async () => {});
    const off = await startOnDevice(app, { provider: "google", callbackURL: BOUND_LINK });
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ error: { code: "core/not_found" } });

    const unknown = await startOnDevice(app, { provider: "myspace", callbackURL: BOUND_LINK });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "validation/invalid_input" } });
  });
});

describe("a magic link that returns to an app", () => {
  /** Ask for a magic link to `callbackURL` and open it, unfollowed, as the mail client would. */
  async function openMagicLink(app: Hono<PithyHonoEnv>, callbackURL: string): Promise<Response> {
    const sent = await app.request(
      "/auth/sign-in/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ email: "ada@example.test", callbackURL }),
      },
      appEnv(),
    );
    if (sent.status !== 200) throw new Error(`sign-in/magic-link answered ${sent.status}`);
    const row = await env.DB.prepare(
      "select payload from pithy_email_jobs where template = 'magicLink' order by rowid desc limit 1",
    ).first<{ payload: string }>();
    const link = new URL(String((JSON.parse(row?.payload ?? "{}") as { url?: string }).url));
    return app.request(`${link.pathname}${link.search}`, { redirect: "manual" }, appEnv());
  }

  test("to a custom scheme is refused: any app can claim the scheme, and the one asking chose the challenge", async () => {
    const events: AuditEventInput[] = [];
    const opened = await openMagicLink(
      buildApp(async (event) => void events.push(event)),
      BOUND_LINK,
    );

    expect(opened.status).toBe(302);
    const location = new URL(opened.headers.get("location") ?? "");
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(DEEP_LINK);
    expect(location.searchParams.get("error")).toBe("handoff_scheme_refused");
    expect(location.searchParams.has(HANDOFF_CODE_PARAM)).toBe(false);
    expect(location.searchParams.has(HANDOFF_CHALLENGE_PARAM)).toBe(false);
    expect(opened.headers.getSetCookie().join("\n")).not.toContain("session_token");
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const codes = await env.DB.prepare(
      "select count(*) as n from pithy_auth_verifications where identifier like 'pithy-handoff:%'",
    ).first<{ n: number }>();
    expect(codes?.n).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: AuthAuditActions.handoffIssued,
        outcome: "denied",
        metadata: { reason: "scheme" },
      }),
    );
  });

  test("to an https universal link is handed off, and its code trades for the session", async () => {
    const app = buildApp(async () => {});
    const opened = await openMagicLink(app, `${APP_LINK}?${HANDOFF_CHALLENGE_PARAM}=${CHALLENGE}`);

    expect(opened.status).toBe(302);
    const location = new URL(opened.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(APP_LINK);
    expect(opened.headers.getSetCookie().join("\n")).not.toContain("session_token");
    const traded = await exchange(app, codeOf(opened));
    expect(traded.status).toBe(200);
    const { token } = HandoffExchangeResponse.parse(await traded.json());
    const stored = await env.DB.prepare("select token from pithy_auth_sessions").first<{ token: string }>();
    expect(token).toBe(stored?.token);
  });

  test("with no challenge is a web sign-in: the browser gets its cookie and the link gets no code", async () => {
    const opened = await openMagicLink(
      buildApp(async () => {}),
      APP_LINK,
    );

    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(APP_LINK);
    expect(opened.headers.getSetCookie().join("\n")).toContain("session_token=");
    const codes = await env.DB.prepare(
      "select count(*) as n from pithy_auth_verifications where identifier like 'pithy-handoff:%'",
    ).first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });

  test("a social sign-in to the same custom scheme still gets its code", async () => {
    const callback = await completeSignIn(buildApp(async () => {}));
    expect(codeOf(callback)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
