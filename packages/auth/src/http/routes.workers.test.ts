// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { type AuditEmit, noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { makeAuth } from "../instance/auth";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { publishSameOrigin } from "./csrf";
import { createSessionMiddleware } from "./middleware";
import { createRateLimitMiddleware } from "./rateLimit";
import { createAuthRoutes } from "./routes";

const SECRET = "test-secret-please-rotate-0000000000";
const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
];

/** Dev-mode secret values (resolved from bindings keyed by the secret name). */
const SECRET_ENV: Record<string, string> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": JSON.stringify({ clientId: "g", clientSecret: "g" }),
  "auth-apple-credentials": JSON.stringify({ clientId: "a", clientSecret: "a" }),
  "auth-facebook-credentials": JSON.stringify({ clientId: "f", clientSecret: "f" }),
  "auth-github-credentials": JSON.stringify({ clientId: "h", clientSecret: "h" }),
  "turnstile-secret-keys": JSON.stringify({ visible: { key: "1x0000000000000000000000000000000AA" } }),
};

/** A rate-limiter binding stub. By default it allows; pass `allow: false` to block. */
function rateLimiter(allow = true): RateLimit {
  return { limit: async () => ({ success: allow }) };
}

function appEnv(rateLimit: RateLimit = rateLimiter()): Record<string, unknown> {
  return { ...(env as unknown as Record<string, unknown>), ...SECRET_ENV, AUTH_RATE_LIMITER: rateLimit };
}

function buildWiring(turnstile?: { mode: "visible" }): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
    enqueueEmail: emailCap.enqueue,
    turnstile,
  };
}

function buildApp(wiring: AuthWiring, emit: AuditEmit = noopEmit): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", emit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  // Mirror the capability's middleware order: the same-origin policy, the tier-1 rate limiter, then
  // session resolution. The first is not optional scaffolding — auth's own mutating routes read their
  // CSRF gate off the request, so a Worker that never published one denies them, as it should.
  publishSameOrigin(wiring)(app);
  app.use(`${wiring.config.basePath}/*`, createRateLimitMiddleware(wiring.config.rateLimiterBinding));
  createSessionMiddleware(wiring)(app);
  createAuthRoutes(wiring)(app);
  return app;
}

/** An `emit` seam that captures every audit event, for asserting security events fired. */
function capturingEmit(): { emit: AuditEmit; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return {
    events,
    emit: async (event) => {
      events.push(event);
    },
  };
}

/** Sign a user in via OTP directly (no HTTP, no email) and return a usable session token. */
async function signIn(deviceHeaders: Record<string, string> = {}): Promise<{ token: string; userId: string }> {
  const mailbox: { template: string; code?: string }[] = [];
  const instance = makeAuth({
    db: authDatabase(env.DB),
    secret: SECRET,
    baseURL: "http://localhost",
    basePath: "/auth",
    trustedOrigins: ["http://localhost"],
    google: undefined,
    apple: undefined,
    sendEmail: async (m) => {
      mailbox.push(m.template === "otp" ? { template: "otp", code: m.code } : { template: m.template });
    },
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    emit: noopEmit,
  });
  await instance.api.sendVerificationOTP({ body: { email: "u@test.com", type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((m) => m.template === "otp");
  if (!otp?.code) throw new Error("no OTP");
  const signedIn = await instance.api.signInEmailOTP({
    body: { email: "u@test.com", otp: otp.code },
    headers: new Headers(deviceHeaders),
  });
  return { token: signedIn.token, userId: signedIn.user.id };
}

const DEVICE_HEADERS = { "x-pithy-device-id": "dev-1", "x-pithy-platform": "ios", "cf-connecting-ip": "203.0.113.5" };

beforeEach(async () => {
  for (const t of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${t}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
    {
      database: "app",
      namespace: "email",
      order: 200,
      migrations: { "0001_init": email_0001_init },
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: { ...authSecretsRegistry, ...turnstileSecretsRegistry } });
});

afterEach(() => {
  resetSharedSecrets();
});

describe("auth HTTP routes", () => {
  test("requireAuth rejects an unauthenticated device-list request with 401", async () => {
    const res = await buildApp(buildWiring()).request("/auth/devices", {}, appEnv());
    expect(res.status).toBe(401);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("auth/invalid_token");
  });

  test("the tier-1 edge limiter blocks an over-limit request with 429, before anything else runs", async () => {
    // Even an unauthenticated route returns 429 (not 401) — the limiter runs first.
    const res = await buildApp(buildWiring()).request("/auth/devices", {}, appEnv(rateLimiter(false)));
    expect(res.status).toBe(429);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("rate_limit/exceeded");
  });

  test("a bearer token fills the AuthContext and lists the caller's devices", async () => {
    const { token } = await signIn(DEVICE_HEADERS);
    const res = await buildApp(buildWiring()).request(
      "/auth/devices",
      { headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ devices: { id: string; platform: string }[] }>();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ id: "dev-1", platform: "ios" });
  });

  test("token/rotate mints a new credential, preserves the device, and revokes the old one", async () => {
    const { token } = await signIn(DEVICE_HEADERS);
    const app = buildApp(buildWiring());

    const res = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ accessToken: string; refreshToken: string }>();
    expect(body.accessToken.split(".")).toHaveLength(3); // a JWT
    expect(body.refreshToken).not.toBe(token); // the session token rotated

    // The old token is revoked.
    const stale = await app.request("/auth/devices", { headers: { authorization: `Bearer ${token}` } }, appEnv());
    expect(stale.status).toBe(401);

    // The new token works and the device binding carried over.
    const fresh = await app.request(
      "/auth/devices",
      { headers: { authorization: `Bearer ${body.refreshToken}` } },
      appEnv(),
    );
    expect(fresh.status).toBe(200);
    const bound = await env.DB.prepare("select device_id, family_id from pithy_auth_sessions where token = ?")
      .bind(body.refreshToken)
      .first<{ device_id: string; family_id: string | null }>();
    expect(bound?.device_id).toBe("dev-1");
    // A family id is minted on first rotation, so a later replay of the old token can revoke the chain.
    expect(bound?.family_id).toBeTruthy();
  });

  test("the refresh-token family id is preserved across successive rotations", async () => {
    const { token } = await signIn(DEVICE_HEADERS);
    const app = buildApp(buildWiring());

    const first = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    const firstToken = (await first.json<{ refreshToken: string }>()).refreshToken;
    const familyOf = (t: string): Promise<{ family_id: string | null } | null> =>
      env.DB.prepare("select family_id from pithy_auth_sessions where token = ?")
        .bind(t)
        .first<{ family_id: string | null }>();
    const family1 = (await familyOf(firstToken))?.family_id;
    expect(family1).toBeTruthy();

    const second = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${firstToken}` } },
      appEnv(),
    );
    const secondToken = (await second.json<{ refreshToken: string }>()).refreshToken;
    expect((await familyOf(secondToken))?.family_id).toBe(family1);
  });

  test("replaying a rotated token within the grace window is denied but does NOT revoke the family", async () => {
    const { token, userId } = await signIn(DEVICE_HEADERS);
    const { emit, events } = capturingEmit();
    const app = buildApp(buildWiring(), emit);

    const rotated = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    const successor = (await rotated.json<{ refreshToken: string }>()).refreshToken;

    // Immediate replay of the just-consumed token: a benign race/retry, denied without revocation.
    const replay = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    expect(replay.status).toBe(401);

    // The successor the first rotation issued keeps working, and no reuse event fired.
    const successorCheck = await app.request(
      "/auth/devices",
      { headers: { authorization: `Bearer ${successor}` } },
      appEnv(),
    );
    expect(successorCheck.status).toBe(200);
    const live = await env.DB.prepare("select count(*) as n from pithy_auth_sessions where user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
    expect(events.find((e) => e.action === "auth/token_reuse_detected")).toBeUndefined();
  });

  test("replaying a rotated token past the grace window is reuse: the family is revoked, 401, critical audit", async () => {
    const { token, userId } = await signIn(DEVICE_HEADERS);
    const { emit, events } = capturingEmit();
    const app = buildApp(buildWiring(), emit);

    const rotated = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    const successor = (await rotated.json<{ refreshToken: string }>()).refreshToken;

    // Age the ledger entry past the grace window so the replay reads as a genuine, delayed reuse.
    await env.DB.prepare("update pithy_auth_rotated_tokens set rotated_at = ? where token = ?")
      .bind(1_000, token)
      .run();

    const replay = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    expect(replay.status).toBe(401);
    expect((await replay.json<{ error: { code: string } }>()).error.code).toBe("auth/invalid_token");

    // The whole family is revoked — the successor minted from the first rotation no longer works.
    const successorCheck = await app.request(
      "/auth/devices",
      { headers: { authorization: `Bearer ${successor}` } },
      appEnv(),
    );
    expect(successorCheck.status).toBe(401);
    const live = await env.DB.prepare("select count(*) as n from pithy_auth_sessions where user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(live?.n).toBe(0);

    const reuse = events.find((e) => e.action === "auth/token_reuse_detected");
    expect(reuse).toMatchObject({ outcome: "denied", severity: "critical", actorType: "user", actorId: userId });
    expect((reuse?.metadata as { familyId?: string } | undefined)?.familyId).toBeTruthy();
  });

  test("two concurrent rotations of one token yield exactly one live successor — never two, never zero", async () => {
    const { token, userId } = await signIn(DEVICE_HEADERS);
    const app = buildApp(buildWiring());

    const [a, b] = await Promise.all([
      app.request("/auth/token/rotate", { method: "POST", headers: { authorization: `Bearer ${token}` } }, appEnv()),
      app.request("/auth/token/rotate", { method: "POST", headers: { authorization: `Bearer ${token}` } }, appEnv()),
    ]);

    // Exactly one presented token yields exactly one successful rotation; the other is denied.
    expect([a.status, b.status].sort()).toEqual([200, 401]);

    // The grace window keeps a benign race from revoking the family, so exactly one successor survives.
    const live = await env.DB.prepare("select count(*) as n from pithy_auth_sessions where user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
  });

  test("devices/revoke signs out the device's sessions and drops the device", async () => {
    const { token } = await signIn(DEVICE_HEADERS);
    const app = buildApp(buildWiring());

    const res = await app.request(
      "/auth/devices/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "dev-1" }),
      },
      appEnv(),
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ revoked: number }>()).revoked).toBe(1);

    // The session is gone and so is the device row.
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const devices = await env.DB.prepare("select count(*) as n from pithy_auth_devices").first<{ n: number }>();
    expect(devices?.n).toBe(0);
  });

  test("devices/revoke without a deviceId is a 400", async () => {
    const { token } = await signIn();
    const res = await buildApp(buildWiring()).request(
      "/auth/devices/revoke",
      { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" },
      appEnv(),
    );
    expect(res.status).toBe(400);
    // The route-line `zValidator("json", RevokeDeviceBody)` now rejects it, so the code is the shared
    // validation code rather than the hand-rolled `validation/invalid_input` the handler used to throw.
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("devices/revoke with an over-long deviceId is a 400 — the bound is on the route line", async () => {
    const { token } = await signIn();
    const res = await buildApp(buildWiring()).request(
      "/auth/devices/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "d".repeat(257) }),
      },
      appEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("devices/revoke with an unparseable body is a 400, not a 500", async () => {
    const { token } = await signIn();
    const res = await buildApp(buildWiring()).request(
      "/auth/devices/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{not json",
      },
      appEnv(),
    );
    // Hono's validator raises `HTTPException(400)` on an unreadable JSON body; `pithyErrorHandler`
    // maps it to the same payload a schema failure produces.
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("devices/revoke checks auth before the body — an unauthenticated bad body is 401, not 400", async () => {
    // Pins the guard order: `requireAuth()` and `csrf` run before the validator, so an invalid body
    // never leaks the fact that the route exists to an unauthenticated caller.
    const res = await buildApp(buildWiring()).request(
      "/auth/devices/revoke",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      appEnv(),
    );
    expect(res.status).toBe(401);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("auth/invalid_token");
  });

  test("devices/revoke with a well-formed but unknown deviceId reaches the handler and revokes nothing", async () => {
    // The schema bounds the shape only — resolution stays in the handler, so an unknown id is a 200
    // with `revoked: 0`, never a 400.
    const { token } = await signIn(DEVICE_HEADERS);
    const res = await buildApp(buildWiring()).request(
      "/auth/devices/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "no-such-device" }),
      },
      appEnv(),
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ revoked: number }>()).revoked).toBe(0);
  });

  test("turnstile auto-gates the OTP send route — a tokenless request is denied", async () => {
    const app = buildApp(buildWiring({ mode: "visible" }));
    const res = await app.request(
      "/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@test.com", type: "sign-in" }),
      },
      appEnv(),
    );
    // A missing humanity token is `turnstile/missing_token` (400) — proof the gate is on the route.
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("turnstile/missing_token");
  });

  test("without turnstile composed, the OTP send route reaches Better Auth and enqueues an email", async () => {
    const app = buildApp(buildWiring());
    const res = await app.request(
      "/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@test.com", type: "sign-in" }),
      },
      appEnv(),
    );
    expect(res.status).toBe(200);
    // The send seam enqueued an `otp` email job — delivery is the email Workflow's job, not auth's.
    const job = await env.DB.prepare("select template from pithy_email_jobs where to_address = ?")
      .bind("x@test.com")
      .first<{ template: string }>();
    expect(job?.template).toBe("otp");
  });

  test("with facebook and github enabled, the instance builds — resolve gating reads their credentials", async () => {
    // Exercises resolve.ts's enabled branch and resolveFacebook/GithubCredentials: with the providers on,
    // building the Better Auth instance resolves their secrets (present in SECRET_ENV). A broken resolver
    // or gating would throw here and 500; a served Better Auth route proves the instance built.
    const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
    const wiring: AuthWiring = {
      config: AuthConfig.parse({
        baseURL: "http://localhost",
        basePath: "/auth",
        trustedOrigins: ["http://localhost"],
        facebook: { enabled: true },
        github: { enabled: true },
      }),
      enqueueEmail: emailCap.enqueue,
      turnstile: undefined,
    };
    const res = await buildApp(wiring).request(
      "/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "social@test.com", type: "sign-in" }),
      },
      appEnv(),
    );
    expect(res.status).toBe(200);
  });
});
