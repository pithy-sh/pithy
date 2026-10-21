// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { publishSameOrigin } from "../http/csrf";
import { createSessionMiddleware, requireAuth } from "../http/middleware";
import { createRateLimitMiddleware } from "../http/rateLimit";
import { createAuthRoutes } from "../http/routes";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";

/**
 * The account lifecycle, enforced at every door (#620): a suspended or deleted account cannot use the
 * session it holds, cannot get a new access token, and cannot sign in again — and a suspension that has run
 * out is no suspension at all. Driven through the real middleware, routes and Better Auth instance over a
 * real D1, because every one of these is a place a check could be missing.
 */

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_user_lifecycle",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
];

const ORIGIN = "http://localhost";
const ADDRESS = "held@test.com";
const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": "test-secret-please-rotate-0000000000",
  "auth-github-credentials": { clientId: "gh-client", clientSecret: "gh-secret" },
};

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } satisfies RateLimit,
  };
}

/** The GitHub identity the social case signs in as. Linked to the held account by a seeded account row. */
const GITHUB_ID = 4242;

function wiring(): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: ORIGIN });
  return {
    config: AuthConfig.parse({
      baseURL: ORIGIN,
      basePath: "/auth",
      trustedOrigins: [ORIGIN],
      github: { enabled: true },
    }),
    resolveGithubUserInfo: async () => ({
      user: { email: ADDRESS, emailVerified: true, name: "Held" },
      data: { id: GITHUB_ID, name: "Held", login: "held", avatar_url: null },
    }),
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
  };
}

/**
 * The capability's middleware order, plus one route guarded the way every *other* capability guards — a
 * copy of `requireAuth` that asks only whether `auth` was filled. That is the shape media, storage, ledger and
 * the rest carry, and the lifecycle has to close it without any of them changing.
 */
function buildApp(events: AuditEventInput[] = []): Hono<PithyHonoEnv> {
  const w = wiring();
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) {
      c.set("emit", async (event) => {
        events.push(event);
      });
    }
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(w)(app);
  app.use(`${w.config.basePath}/*`, createRateLimitMiddleware(w.config.rateLimiterBinding));
  createSessionMiddleware(w)(app);
  app.get("/elsewhere/mine", async (c) => {
    if (!c.var.auth) throw new UnauthorizedError({ message: "Authentication required." });
    return c.json({ userId: c.var.auth.userId });
  });
  app.get("/kit/mine", requireAuth(), (c) => c.json({ userId: c.var.auth?.userId }));
  createAuthRoutes(w)(app);
  return app;
}

/** The newest job of `template` mailed to `to`, read out of its payload. The harness standing in for a mailbox. */
async function mailed(to: string, template: "otp" | "magicLink"): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "select payload from pithy_email_jobs where to_address = ? and template = ? order by rowid desc limit 1",
  )
    .bind(to, template)
    .first<{ payload: string }>();
  if (!row) throw new Error(`nothing mailed: ${template} to ${to}`);
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** Ask for a one-time code over HTTP and post it back, the way a reader signs in. */
async function signInWithOtp(app: Hono<PithyHonoEnv>): Promise<Response> {
  const headers = { "content-type": "application/json", origin: ORIGIN };
  const sent = await app.request(
    "/auth/email-otp/send-verification-otp",
    { method: "POST", headers, body: JSON.stringify({ email: ADDRESS, type: "sign-in" }) },
    appEnv(),
  );
  expect(sent.status).toBe(200);
  const { code } = await mailed(ADDRESS, "otp");
  return app.request(
    "/auth/sign-in/email-otp",
    { method: "POST", headers, body: JSON.stringify({ email: ADDRESS, otp: code }) },
    appEnv(),
  );
}

/** Sign in and hand back the bearer credential and the user it belongs to. */
async function signedIn(app: Hono<PithyHonoEnv>): Promise<{ token: string; userId: string }> {
  const res = await signInWithOtp(app);
  expect(res.status).toBe(200);
  const body = await res.json<{ token: string; user: { id: string } }>();
  return { token: body.token, userId: body.user.id };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Suspend an account the way the lifecycle transition writes it: the columns, and the row with the reason. */
async function suspend(userId: string, reason: string | null, until: Date | null = null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("update pithy_auth_users set suspended_at = ?, suspended_until = ? where id = ?")
    .bind(now - 1000, until ? until.getTime() : null, userId)
    .run();
  await env.DB.prepare(
    "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, reason, suspended_until, created_at) values (?, 'suspended', 'control-plane', ?, ?, ?)",
  )
    .bind(userId, reason, until ? until.getTime() : null, now)
    .run();
}

async function softDelete(userId: string, purgeAfter: Date): Promise<void> {
  await env.DB.prepare("update pithy_auth_users set deleted_at = ?, purge_after = ? where id = ?")
    .bind(Date.now() - 1000, purgeAfter.getTime(), userId)
    .run();
}

async function errorOf(res: Response): Promise<{ code: string; message: string; params?: Record<string, unknown> }> {
  const body = await res.json<{ error: { code: string; message: string; params?: Record<string, unknown> } }>();
  return body.error;
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
});

afterEach(() => {
  resetSharedSecrets();
});

describe("a suspended account's existing session", () => {
  test("requireAuth refuses it with auth/account_suspended 403, the reason as the message", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    expect((await app.request("/kit/mine", { headers: bearer(token) }, appEnv())).status).toBe(200);

    await suspend(userId, "Chargeback under review.");
    const res = await app.request("/kit/mine", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe("auth/account_suspended");
    expect(error.message).toBe("Chargeback under review.");
    expect(error.params).toBeUndefined();
  });

  test("an end to the suspension rides in params, and nothing else crosses", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    const until = new Date(Date.now() + 86_400_000);
    await suspend(userId, "Cooling off.", until);
    const res = await app.request("/kit/mine", { headers: bearer(token) }, appEnv());
    const body = await res.json<{ error: Record<string, unknown> }>();
    expect(body.error.params).toEqual({ suspendedUntil: until.toISOString() });
    // `clientError` is the boundary: the operator's remedy and the account id stay in the log.
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "params", "status"]);
    expect(JSON.stringify(body)).not.toContain(userId);
  });

  test("a route another capability guards refuses it too, because the account has no AuthContext", async () => {
    // Every kit capability copies `requireAuth` rather than import it, and each copy asks only whether
    // `auth` was filled. The lifecycle closes all of them by never filling it.
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, "Chargeback under review.");
    const res = await app.request("/elsewhere/mine", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(401);
  });

  test("the kit's own routes refuse it with the code — the device list, here", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, "Chargeback under review.");
    const res = await app.request("/auth/devices", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("auth/account_suspended");
  });

  test("Better Auth's own session endpoints refuse it, not only the kit's", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, null);
    const res = await app.request("/auth/get-session", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe("auth/account_suspended");
    expect(error.message).toBe("This account is suspended.");
  });

  test("it can still sign out", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, "Chargeback under review.");
    const res = await app.request(
      "/auth/sign-out",
      { method: "POST", headers: { ...bearer(token), origin: ORIGIN } },
      appEnv(),
    );
    expect(res.status).toBe(200);
  });

  test("a suspension past its end is treated as absent, with nothing written to expire it", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, "Cooling off.", new Date(Date.now() - 1000));
    const res = await app.request("/kit/mine", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("select suspended_at from pithy_auth_users where id = ?")
      .bind(userId)
      .first<{ suspended_at: number | null }>();
    expect(row?.suspended_at).not.toBeNull();
  });
});

describe("a suspended account cannot obtain a new access token", () => {
  test("/token/rotate refuses it, and the presented credential is not spent", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, "Chargeback under review.");

    const res = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { ...bearer(token), origin: ORIGIN } },
      appEnv(),
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("auth/account_suspended");
    const sessions = await env.DB.prepare("select token from pithy_auth_sessions where user_id = ?")
      .bind(userId)
      .all<{ token: string }>();
    expect(sessions.results.map((row) => row.token)).toEqual([token]);
  });

  test("Better Auth's /token refuses it — no JWT is minted", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    expect((await app.request("/auth/token", { headers: bearer(token) }, appEnv())).status).toBe(200);

    await suspend(userId, "Chargeback under review.");
    const res = await app.request("/auth/token", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("auth/account_suspended");
    expect(body).not.toContain('"token"');
  });
});

describe("a lifecycle check that fails closes the door rather than opening it", () => {
  // The reason for a suspension costs a read, and a read can fail. A failure there must not leave the request
  // looking anonymous, because Better Auth's own endpoints resolve their own session and would serve it.
  async function brokenReasonRead(): Promise<{ app: Hono<PithyHonoEnv>; token: string }> {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    await suspend(userId, "Chargeback under review.");
    await env.DB.prepare("drop table pithy_auth_user_lifecycle").run();
    return { app, token };
  }

  test("Better Auth's /token mints nothing", async () => {
    const { app, token } = await brokenReasonRead();
    const res = await app.request("/auth/token", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('"token"');
  });

  test("Better Auth's /get-session hands back no session", async () => {
    const { app, token } = await brokenReasonRead();
    const res = await app.request("/auth/get-session", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('"session"');
  });

  test("the kit's own routes refuse it, and /token/rotate spends nothing", async () => {
    const { app, token } = await brokenReasonRead();
    expect((await app.request("/kit/mine", { headers: bearer(token) }, appEnv())).status).toBe(500);
    const rotate = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { ...bearer(token), origin: ORIGIN } },
      appEnv(),
    );
    expect(rotate.status).toBe(500);
    const sessions = await env.DB.prepare("select token from pithy_auth_sessions").all<{ token: string }>();
    expect(sessions.results.map((row) => row.token)).toEqual([token]);
  });

  test("it can still sign out", async () => {
    const { app, token } = await brokenReasonRead();
    const res = await app.request(
      "/auth/sign-out",
      { method: "POST", headers: { ...bearer(token), origin: ORIGIN } },
      appEnv(),
    );
    expect(res.status).toBe(200);
  });
});

describe("a suspended or deleted account cannot sign in again", () => {
  test("an OTP sign-in is refused with auth/account_suspended, and no session is written", async () => {
    const events: AuditEventInput[] = [];
    const app = buildApp(events);
    const { userId } = await signedIn(app);
    await env.DB.prepare("delete from pithy_auth_sessions").run();
    await suspend(userId, "Chargeback under review.");

    const res = await signInWithOtp(app);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("auth/account_suspended");
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(left?.n).toBe(0);
    // A refused sign-in is a denied one on the trail, with the reason as the code.
    expect(events.some((event) => event.action === "auth/signin" && event.outcome === "denied")).toBe(true);
  });

  test("an OTP sign-in for a deleted account is refused with auth/account_deleted", async () => {
    const app = buildApp();
    const { userId } = await signedIn(app);
    const purgeAfter = new Date(Date.now() + 30 * 86_400_000);
    await softDelete(userId, purgeAfter);

    const res = await signInWithOtp(app);
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe("auth/account_deleted");
    expect(error.params).toEqual({ purgeAfter: purgeAfter.toISOString() });
  });

  test("a magic link for a suspended account lands back on the screen it named, with the code", async () => {
    const app = buildApp();
    const { userId } = await signedIn(app);
    await suspend(userId, "Chargeback under review.");

    const sent = await app.request(
      "/auth/sign-in/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: ADDRESS, callbackURL: `${ORIGIN}/callback` }),
      },
      appEnv(),
    );
    expect(sent.status).toBe(200);
    const { url } = await mailed(ADDRESS, "magicLink");
    const link = new URL(String(url));
    const res = await app.request(`${link.pathname}${link.search}`, {}, appEnv());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/callback");
    expect(location.searchParams.get("error")).toBe("auth/account_suspended");
    expect(
      res.headers.getSetCookie().some((cookie) => cookie.includes("session_token=") && !cookie.includes("Max-Age=0")),
    ).toBe(false);
  });

  test("a suspension that has run out does not stop a sign-in", async () => {
    const app = buildApp();
    const { userId } = await signedIn(app);
    await suspend(userId, "Cooling off.", new Date(Date.now() - 1000));
    expect((await signInWithOtp(app)).status).toBe(200);
  });
});

describe("a social sign-in for a suspended account", () => {
  test("redirects back to the adopter's error screen with the kit's code, and mints no session", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" });
      }
      throw new Error(`the callback reached out to ${url}`);
    });
    try {
      const app = buildApp();
      const { userId } = await signedIn(app);
      await env.DB.prepare("delete from pithy_auth_sessions").run();
      // The GitHub identity is already this account's, so the callback signs in rather than links: what
      // stops it is the account's standing, and nothing about the provider.
      await env.DB.prepare(
        "insert into pithy_auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values ('acct-gh', ?, 'github', ?, ?, ?)",
      )
        .bind(String(GITHUB_ID), userId, new Date().toISOString(), new Date().toISOString())
        .run();
      await suspend(userId, "Chargeback under review.");

      const started = await app.request(
        "/auth/sign-in/social",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({
            provider: "github",
            callbackURL: `${ORIGIN}/app`,
            errorCallbackURL: `${ORIGIN}/sign-in?provider=github`,
          }),
        },
        appEnv(),
      );
      expect(started.status).toBe(200);
      const state = new URL((await started.json<{ url: string }>()).url).searchParams.get("state") ?? "";
      const cookies = started.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const res = await app.request(
        `/auth/callback/github?code=the-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual", headers: { cookie: cookies } },
        appEnv(),
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.pathname).toBe("/sign-in");
      // Not collapsed to the neutral provider refusal: it is reached only by somebody who just proved they
      // hold this account, and it is their own account's state they are being told.
      expect(location.searchParams.get("error")).toBe("auth/account_suspended");
      const left = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
      expect(left?.n).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a deleted account's existing session", () => {
  test("is refused with auth/account_deleted, and says until when it can be restored", async () => {
    const app = buildApp();
    const { token, userId } = await signedIn(app);
    const purgeAfter = new Date(Date.now() + 30 * 86_400_000);
    await softDelete(userId, purgeAfter);
    const res = await app.request("/kit/mine", { headers: bearer(token) }, appEnv());
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe("auth/account_deleted");
    expect(error.params).toEqual({ purgeAfter: purgeAfter.toISOString() });
  });
});
