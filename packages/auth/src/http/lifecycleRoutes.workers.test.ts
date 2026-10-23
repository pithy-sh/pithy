// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CONTROLPLANE_MIGRATION_ORDER, controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import { controlplane_0001_init } from "@pithy-sh/core/src/controlPlane/migrations/0001_init";
import { controlplane_0002_management_origin } from "@pithy-sh/core/src/controlPlane/migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "@pithy-sh/core/src/controlPlane/migrations/0003_connection_principal";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { EMAIL_MIGRATION_ORDER, email } from "@pithy-sh/email/src/capability";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { email_0001_suppressions } from "@pithy-sh/email/src/migrations/0001_suppressions";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auth } from "../capability";
import { Session, User } from "../data/betterAuth";
import { authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { authSecretsRegistry } from "../instance/secrets";
import type { UserLifecycleHookEvent, UserLifecycleHooks } from "../lifecycle/hooks";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { AUTH_USERS_READ_SCOPE, AUTH_USERS_SUSPEND_SCOPE } from "./guards";
import { AdminUserReinstateResponse, AdminUserSuspendResponse } from "./responses";

/**
 * Suspend and reinstate, through the control plane (#621) — a real `createBackend`, real D1, tokens signed by
 * `mintControlPlaneToken`, and a person signed in over OTP the way a reader signs in.
 *
 * The transitions underneath are proved in `../lifecycle/transitions.workers.test.ts`, and enforcement in
 * `../lifecycle/enforcement.workers.test.ts`. What this file proves is the route: the scope it demands, the
 * order its guard and validator run in, the sessions it ends, the mail it sends or does not, the audit event
 * every call writes, and that its response is exactly the schema a management client validates it with.
 */

const ORIGIN = "http://localhost";
const ENVIRONMENT = "dev";
const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3399";
const ISSUER = "https://app.pithy.sh";
const KEY_ID = "cpk_admin_1";
const SUBJECT = "ops@dashboard.test";
const ADDRESS = "held@test.com";
const DAY = 86_400_000;

const REGISTRY = { ...authSecretsRegistry, ...emailSigningRegistry };
const SECRETS: SecretFixture<typeof REGISTRY> = {
  "auth-session-secret": "test-secret-please-rotate-0000000000",
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
  "email-link-signing-key": "dev-link-signing-key",
};

const AUTH_TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_user_lifecycle",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
  "pithy_email_suppressions",
];

let signingKey: CryptoKey;
let emitted: AuditEventInput[] = [];
let fired: { hook: keyof UserLifecycleHooks; event: UserLifecycleHookEvent }[] = [];

function memoryKv() {
  const entries = new Map<string, string>();
  return {
    get: async (name: string) => entries.get(name) ?? null,
    put: async (name: string, value: string) => void entries.set(name, value),
  };
}

function workerEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    ENVIRONMENT,
    EMAIL_SUPPRESSIONS: env.DB,
    EMAIL_SENDER: {},
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    CONTROL_PLANE: memoryKv(),
  };
}

const captureCapability = defineCapability({
  name: "capture",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
        await next();
      });
    },
  ],
});

const hook =
  (name: keyof UserLifecycleHooks) =>
  (event: UserLifecycleHookEvent): void =>
    void fired.push({ hook: name, event });

function buildApp() {
  return createBackend({
    capabilities: [
      secrets({ registry: authSecretsRegistry }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: ORIGIN }),
      auth({
        baseURL: ORIGIN,
        basePath: "/auth",
        trustedOrigins: [ORIGIN],
        onUserSuspended: hook("onUserSuspended"),
        onUserReinstated: hook("onUserReinstated"),
      }),
      controlplane(),
    ],
    app: captureCapability,
  });
}

async function registerConnection(publicKey: Ed25519PublicJwk, scopes: readonly ControlPlaneScope[]): Promise<void> {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: "https://worker.example.test",
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "dashboard",
        purpose: "The hosted dashboard.",
        scopes: [...scopes],
        keys: [
          {
            keyId: KEY_ID,
            publicKey,
            validFrom: new Date(now.getTime() - 60_000),
            validUntil: null,
            revokedAt: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

async function grant(scopes: readonly ControlPlaneScope[]): Promise<void> {
  await env.DB.prepare("delete from pithy_controlplane_connections").run();
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  await registerConnection(await exportPublicJwk(pair.publicKey), scopes);
}

/** One management call, carrying a freshly minted, body-bound control-plane token. */
async function call(path: string, body: unknown, scope: ControlPlaneScope = AUTH_USERS_SUSPEND_SCOPE) {
  const payload = JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: signingKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope,
    body: new TextEncoder().encode(payload),
  });
  return buildApp().request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token, "cf-ray": "ray-621" },
      body: payload,
    },
    workerEnv(),
  );
}

const suspend = (userId: string, body: unknown, scope?: ControlPlaneScope) =>
  call(`/auth/admin/users/${userId}/suspend`, body, scope);
const reinstate = (userId: string, body: unknown, scope?: ControlPlaneScope) =>
  call(`/auth/admin/users/${userId}/reinstate`, body, scope);

const db = () => authDatabase(env.DB);

async function seedUser(id: string, address = `${id}@example.test`): Promise<void> {
  const at = new Date();
  await db()
    .insertInto("pithyAuthUsers")
    .values(
      User.encode({
        id,
        name: "Ada Lovelace",
        email: address,
        emailVerified: true,
        image: null,
        locale: null,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

async function seedSession(id: string, userId: string): Promise<void> {
  const now = new Date();
  await db()
    .insertInto("pithyAuthSessions")
    .values(
      Session.encode({
        id,
        token: `session-token-${id}`,
        userId,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + DAY),
        ipAddress: "203.0.113.7",
        userAgent: "PithyTest/1.0",
        deviceId: null,
        familyId: null,
        authenticatedAt: now,
      }),
    )
    .execute();
}

async function sessionCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from pithy_auth_sessions where user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function history(userId: string): Promise<UserLifecycleEvent[]> {
  const rows = await db()
    .selectFrom("pithyAuthUserLifecycle")
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("id")
    .execute();
  return rows.map((row) => UserLifecycleEvent.parse(row));
}

async function columns(userId: string): Promise<{ suspended_at: number | null; suspended_until: number | null }> {
  const row = await env.DB.prepare("select suspended_at, suspended_until from pithy_auth_users where id = ?")
    .bind(userId)
    .first<{ suspended_at: number | null; suspended_until: number | null }>();
  if (!row) throw new Error(`no user ${userId}`);
  return row;
}

/** The lifecycle mails enqueued, in order. */
async function lifecycleMail(): Promise<{ template: string; to: string }[]> {
  const rows = await env.DB.prepare(
    "select template, to_address from pithy_email_jobs where template in ('accountSuspended', 'accountReinstated') order by rowid",
  ).all<{ template: string; to_address: string }>();
  return rows.results.map((row) => ({ template: row.template, to: row.to_address }));
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return (await res.json<{ error: { code: string; message: string } }>()).error;
}

/** Ask for a one-time code and post it back, the way a reader signs in. */
async function signInWithOtp(): Promise<Response> {
  const headers = { "content-type": "application/json", origin: ORIGIN };
  const sent = await buildApp().request(
    "/auth/email-otp/send-verification-otp",
    { method: "POST", headers, body: JSON.stringify({ email: ADDRESS, type: "sign-in" }) },
    workerEnv(),
  );
  expect(sent.status).toBe(200);
  const row = await env.DB.prepare(
    "select payload from pithy_email_jobs where to_address = ? and template = 'otp' order by rowid desc limit 1",
  )
    .bind(ADDRESS)
    .first<{ payload: string }>();
  if (!row) throw new Error("no OTP was mailed");
  const { code } = JSON.parse(row.payload) as { code: string };
  return buildApp().request(
    "/auth/sign-in/email-otp",
    { method: "POST", headers, body: JSON.stringify({ email: ADDRESS, otp: code }) },
    workerEnv(),
  );
}

async function signedIn(): Promise<{ token: string; userId: string }> {
  const res = await signInWithOtp();
  expect(res.status).toBe(200);
  const body = await res.json<{ token: string; user: { id: string } }>();
  return { token: body.token, userId: body.user.id };
}

const asHolder = (token: string, path: string, method = "GET") =>
  buildApp().request(path, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN } }, workerEnv());

const events = (action: string) => emitted.filter((event) => event.action === action);

beforeEach(async () => {
  for (const table of [
    ...AUTH_TABLES,
    "pithy_controlplane_connections",
    "pithy_controlplane_replays",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: EMAIL_MIGRATION_ORDER, migrations: { "0001_init": email_0001_init } },
    // The suppression table an OTP send reads before it mails, from the capability's own migration.
    {
      database: "app",
      namespace: "emailsuppressions",
      order: EMAIL_MIGRATION_ORDER + 10,
      migrations: { "0001_suppressions": email_0001_suppressions },
    },
    {
      database: "app",
      namespace: "controlplane",
      order: CONTROLPLANE_MIGRATION_ORDER,
      migrations: {
        "0001_init": controlplane_0001_init,
        "0002_management_origin": controlplane_0002_management_origin,
        "0003_connection_principal": controlplane_0003_connection_principal,
      },
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  await seedSecrets(env, REGISTRY, SECRETS);
  emitted = [];
  fired = [];
  await grant([AUTH_USERS_SUSPEND_SCOPE]);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("POST /auth/admin/users/:userId/suspend", () => {
  test("ends the person's access: their session is revoked, a refresh is refused, and signing in again answers auth/account_suspended", async () => {
    const { token, userId } = await signedIn();
    expect((await asHolder(token, "/auth/devices")).status).toBe(200);

    const res = await suspend(userId, { reason: "Chargeback under review." });
    expect(res.status).toBe(200);
    const body = AdminUserSuspendResponse.parse(await res.json());
    expect(body).toMatchObject({ userId, state: "suspended", outcome: "suspended", sessionsRevoked: 1, mailed: true });

    // The credential they hold no longer opens anything, and cannot be traded for another.
    const after = await asHolder(token, "/auth/devices");
    expect(after.status).toBe(401);
    const refresh = await asHolder(token, "/auth/token/rotate", "POST");
    expect(refresh.status).toBe(401);
    expect(await sessionCount(userId)).toBe(0);

    // And the door they come back to says why, with the operator's reason as the message.
    const again = await signInWithOtp();
    expect(again.status).toBe(403);
    expect(await errorOf(again)).toMatchObject({ code: "auth/account_suspended", message: "Chargeback under review." });
    expect(await sessionCount(userId)).toBe(0);
  });

  test("a session that slipped past the revocation is refused with auth/account_suspended at every door", async () => {
    // The columns are written before the sessions are revoked, so a credential alive in between — or one an
    // adopter's own code minted — meets the refusal, not a pass.
    const { token, userId } = await signedIn();
    const held = await env.DB.prepare("select * from pithy_auth_sessions where user_id = ?")
      .bind(userId)
      .first<Record<string, unknown>>();
    if (!held) throw new Error("no session to hold");
    await suspend(userId, { reason: "Chargeback under review." });
    // Put the revoked row back exactly as it was: the session the revocation raced.
    const keys = Object.keys(held);
    await env.DB.prepare(
      `insert into pithy_auth_sessions (${keys.join(", ")}) values (${keys.map(() => "?").join(", ")})`,
    )
      .bind(...keys.map((key) => held[key]))
      .run();
    const res = await asHolder(token, "/auth/devices");
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("auth/account_suspended");
    const refresh = await asHolder(token, "/auth/token/rotate", "POST");
    expect(refresh.status).toBe(403);
    expect((await errorOf(refresh)).code).toBe("auth/account_suspended");
  });

  test("stamps the columns, writes the row, mails the person, fires the hook once and audits the operator", async () => {
    await seedUser("u-1");
    await seedSession("s-1", "u-1");
    await seedSession("s-2", "u-1");
    await seedSession("s-3", "u-2");
    const until = new Date(Date.now() + 7 * DAY);

    const res = await suspend("u-1", { reason: "Abuse report.", until: until.toISOString() });
    expect(res.status).toBe(200);
    const raw = await res.json();
    // The schema a management client validates with is exactly what the handler sent.
    expect(AdminUserSuspendResponse.parse(raw)).toEqual(raw);
    expect(raw).toMatchObject({ sessionsRevoked: 2, suspendedUntil: until.toISOString(), mailed: true });

    expect((await columns("u-1")).suspended_until).toBe(until.getTime());
    expect(await sessionCount("u-1")).toBe(0);
    expect(await sessionCount("u-2")).toBe(1);
    const [row] = await history("u-1");
    expect(row).toMatchObject({
      action: "suspended",
      actorType: "control-plane",
      actorId: SUBJECT,
      reason: "Abuse report.",
    });
    expect(await lifecycleMail()).toEqual([{ template: "accountSuspended", to: "u-1@example.test" }]);
    expect(fired.map((call) => call.hook)).toEqual(["onUserSuspended"]);

    expect(events("auth/admin_user_suspended")).toEqual([
      expect.objectContaining({
        outcome: "success",
        actorType: "control-plane",
        actorId: SUBJECT,
        resourceType: "user",
        resourceId: "u-1",
        requestId: "ray-621",
        metadata: expect.objectContaining({ connectionId: CONNECTION_ID, reason: "Abuse report.", updated: false }),
      }),
    ]);
    expect(events("auth/admin_user_sessions_revoked")).toEqual([
      expect.objectContaining({
        actorId: SUBJECT,
        resourceId: "u-1",
        metadata: expect.objectContaining({ revoked: 2, cause: "suspended" }),
      }),
    ]);
  });

  test("a body the validator refuses is validation/invalid_input, nothing is written, and the refusal is audited", async () => {
    await seedUser("u-1");
    const long = "x".repeat(501);
    const bodies = [
      {},
      { reason: "" },
      { reason: "   " },
      { reason: 42 },
      { reason: long },
      { reason: "y", until: "never" },
    ];
    for (const body of bodies) {
      const res = await suspend("u-1", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).code).toBe("validation/invalid_input");
    }
    expect((await columns("u-1")).suspended_at).toBeNull();
    expect(await history("u-1")).toEqual([]);
    // Every attempt is on the trail, with whatever reason the body carried — the trail is bounded at the
    // reason's own limit, so a refused essay is not stored whole.
    const refused = events("auth/admin_user_suspended");
    expect(refused.map((event) => [event.outcome, event.actorId, event.resourceId])).toEqual(
      bodies.map(() => ["denied", SUBJECT, "u-1"]),
    );
    expect(refused.map((event) => event.metadata)).toEqual(
      [null, "", "   ", null, long.slice(0, 500), "y"].map((reason) =>
        expect.objectContaining({
          connectionId: CONNECTION_ID,
          reason,
          changed: false,
          code: "validation/invalid_input",
        }),
      ),
    );
  });

  test("an end in the past is refused, and the refusal is audited", async () => {
    await seedUser("u-1");
    const res = await suspend("u-1", { reason: "x", until: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
    expect((await columns("u-1")).suspended_at).toBeNull();
    expect(events("auth/admin_user_suspended")).toEqual([
      expect.objectContaining({
        outcome: "denied",
        actorId: SUBJECT,
        resourceId: "u-1",
        metadata: expect.objectContaining({ reason: "x", code: "validation/invalid_input", changed: false }),
      }),
    ]);
  });

  test("an end in the future stops applying when it passes, with nothing written to end it", async () => {
    const { userId } = await signedIn();
    const res = await suspend(userId, { reason: "Cooling off.", until: new Date(Date.now() + 1500).toISOString() });
    expect(res.status).toBe(200);
    expect((await signInWithOtp()).status).toBe(403);
    const before = { columns: await columns(userId), rows: (await history(userId)).length };

    await new Promise((resolve) => setTimeout(resolve, 1600));
    // Better Auth's own send limit is not what this test is about; the third code in a minute would meet it.
    await env.DB.prepare("delete from pithy_auth_rate_limit").run();
    expect((await signInWithOtp()).status).toBe(200);
    expect(await columns(userId)).toEqual(before.columns);
    expect(await history(userId)).toHaveLength(before.rows);
  });

  test("suspending a suspended account restates the reason and the end, and says so", async () => {
    await seedUser("u-1");
    await suspend("u-1", { reason: "First." });
    const until = new Date(Date.now() + 3 * DAY);
    const res = await suspend("u-1", { reason: "Second.", until: until.toISOString() });
    expect(res.status).toBe(200);
    const body = AdminUserSuspendResponse.parse(await res.json());
    expect(body).toMatchObject({ outcome: "updated", suspendedUntil: until.toISOString() });
    expect((await history("u-1")).map((row) => row.reason)).toEqual(["First.", "Second."]);
    expect((await columns("u-1")).suspended_until).toBe(until.getTime());
    // The hook heard one transition; the trail heard two calls.
    expect(fired.map((call) => call.hook)).toEqual(["onUserSuspended"]);
    expect(
      events("auth/admin_user_suspended").map((event) => (event.metadata as { updated: boolean }).updated),
    ).toEqual([false, true]);
  });

  test("a soft-deleted account is refused, and the refusal names the route that restores it", async () => {
    await seedUser("u-1");
    await env.DB.prepare("update pithy_auth_users set deleted_at = ?, purge_after = ? where id = 'u-1'")
      .bind(Date.now() - 1000, Date.now() + 30 * DAY)
      .run();
    for (const res of [await suspend("u-1", { reason: "x" }), await reinstate("u-1", { reason: "x" })]) {
      expect(res.status).toBe(409);
      const error = await errorOf(res);
      expect(error.code).toBe("core/conflict");
      expect(error.message).toContain("POST /auth/admin/users/u-1/restore");
    }
    expect(await history("u-1")).toEqual([]);
    expect(emitted.filter((event) => event.outcome === "denied").map((event) => event.action)).toEqual([
      "auth/admin_user_suspended",
      "auth/admin_user_reinstated",
    ]);
  });

  test("notify: false sends no mail, and the response says none was sent", async () => {
    await seedUser("u-1");
    const res = await suspend("u-1", { reason: "Quiet.", notify: false });
    expect(AdminUserSuspendResponse.parse(await res.json()).mailed).toBe(false);
    expect(await lifecycleMail()).toEqual([]);
  });
});

describe("POST /auth/admin/users/:userId/reinstate", () => {
  test("lifts the suspension and lets the person sign in again, with none of their sessions restored", async () => {
    const { token, userId } = await signedIn();
    await suspend(userId, { reason: "Review." });

    const res = await reinstate(userId, { reason: "Cleared." });
    expect(res.status).toBe(200);
    const raw = await res.json();
    expect(AdminUserReinstateResponse.parse(raw)).toEqual(raw);
    expect(raw).toEqual({ userId, state: "active", outcome: "reinstated", mailed: true });
    expect(await columns(userId)).toEqual({ suspended_at: null, suspended_until: null });

    // The old credential stays dead; a fresh sign-in works.
    expect(await sessionCount(userId)).toBe(0);
    expect((await asHolder(token, "/auth/devices")).status).toBe(401);
    const fresh = await signedIn();
    expect((await asHolder(fresh.token, "/auth/devices")).status).toBe(200);

    expect((await history(userId)).map((row) => [row.action, row.reason])).toEqual([
      ["suspended", "Review."],
      ["reinstated", "Cleared."],
    ]);
    expect((await lifecycleMail()).map((job) => job.template)).toEqual(["accountSuspended", "accountReinstated"]);
    expect(fired.map((call) => call.hook)).toEqual(["onUserSuspended", "onUserReinstated"]);
    expect(events("auth/admin_user_reinstated")).toEqual([
      expect.objectContaining({
        outcome: "success",
        actorId: SUBJECT,
        resourceId: userId,
        metadata: expect.objectContaining({ connectionId: CONNECTION_ID, reason: "Cleared." }),
      }),
    ]);
  });

  test("reinstating an account that is not suspended changes nothing, answers 200, and is still audited", async () => {
    await seedUser("u-1");
    const res = await reinstate("u-1", { reason: "Just in case." });
    expect(res.status).toBe(200);
    expect(AdminUserReinstateResponse.parse(await res.json())).toEqual({
      userId: "u-1",
      state: "active",
      outcome: "unchanged",
      mailed: false,
    });
    expect(await history("u-1")).toEqual([]);
    expect(await lifecycleMail()).toEqual([]);
    expect(fired).toEqual([]);
    expect(events("auth/admin_user_reinstated")).toEqual([
      expect.objectContaining({
        outcome: "success",
        actorId: SUBJECT,
        resourceId: "u-1",
        metadata: expect.objectContaining({ reason: "Just in case.", changed: false }),
      }),
    ]);
  });

  test("notify: false sends no reinstated mail", async () => {
    await seedUser("u-1");
    await suspend("u-1", { reason: "x", notify: false });
    const res = await reinstate("u-1", { reason: "y", notify: false });
    expect(AdminUserReinstateResponse.parse(await res.json()).mailed).toBe(false);
    expect(await lifecycleMail()).toEqual([]);
  });

  test("a request with no reason is refused validation/invalid_input, and the refusal is audited", async () => {
    await seedUser("u-1");
    const res = await reinstate("u-1", { notify: true });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
    expect(events("auth/admin_user_reinstated")).toEqual([
      expect.objectContaining({
        outcome: "denied",
        actorId: SUBJECT,
        resourceId: "u-1",
        metadata: expect.objectContaining({ reason: null, changed: false, code: "validation/invalid_input" }),
      }),
    ]);
  });
});

describe("both routes", () => {
  test("an unknown user is a 404 on each, and each refusal is audited with the reason", async () => {
    for (const res of [await suspend("nobody", { reason: "x" }), await reinstate("nobody", { reason: "y" })]) {
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("core/not_found");
    }
    const lifecycle = emitted.filter((event) => event.action.startsWith("auth/admin_user_"));
    expect(lifecycle.map((event) => [event.action, event.outcome, event.resourceId, event.metadata])).toEqual([
      [
        "auth/admin_user_suspended",
        "denied",
        "nobody",
        expect.objectContaining({ reason: "x", code: "core/not_found" }),
      ],
      [
        "auth/admin_user_reinstated",
        "denied",
        "nobody",
        expect.objectContaining({ reason: "y", code: "core/not_found" }),
      ],
    ]);
  });

  test("a client holding only auth:users:read is refused 403, and nothing is written", async () => {
    await seedUser("u-1");
    await grant([AUTH_USERS_READ_SCOPE]);
    expect((await suspend("u-1", { reason: "x" }, AUTH_USERS_READ_SCOPE)).status).toBe(403);
    expect((await reinstate("u-1", { reason: "x" }, AUTH_USERS_READ_SCOPE)).status).toBe(403);
    expect((await columns("u-1")).suspended_at).toBeNull();
    expect(await history("u-1")).toEqual([]);
  });

  test("the guard runs before the validator: a malformed body under the wrong scope is 403, not 400", async () => {
    await seedUser("u-1");
    await grant([AUTH_USERS_READ_SCOPE]);
    for (const res of [
      await suspend("u-1", { until: "never" }, AUTH_USERS_READ_SCOPE),
      await reinstate("u-1", { reason: 42 }, AUTH_USERS_READ_SCOPE),
    ]) {
      expect(res.status).toBe(403);
    }
    // Refused by the guard, so audited by the guard alone, never as a lifecycle attempt.
    expect(emitted.filter((event) => event.action.startsWith("auth/admin_user_"))).toEqual([]);
  });

  test("a credential granted auth:users:suspend opens neither the user read nor sign-out-everywhere", async () => {
    // The scope ends access and gives it back. It is not a read, and it is not a logout.
    const readToken = await mintControlPlaneToken({
      privateKey: signingKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      connectionId: CONNECTION_ID,
      subject: SUBJECT,
      scope: AUTH_USERS_SUSPEND_SCOPE,
    });
    const res = await buildApp().request(
      "/auth/admin/users/u-1",
      { headers: { [CONTROL_PLANE_HEADER]: readToken } },
      workerEnv(),
    );
    expect(res.status).toBe(403);
  });
});
