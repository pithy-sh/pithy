// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CONTROLPLANE_MIGRATION_ORDER, controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import {
  ControlPlaneErasurePeriodResponse,
  ControlPlaneErasureSubjectResponse,
} from "@pithy-sh/core/src/controlPlane/http/responses";
import { controlplane_0001_init } from "@pithy-sh/core/src/controlPlane/migrations/0001_init";
import { controlplane_0002_management_origin } from "@pithy-sh/core/src/controlPlane/migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "@pithy-sh/core/src/controlPlane/migrations/0003_connection_principal";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ERASURE_READ_SCOPE } from "@pithy-sh/core/src/controlPlane/scope/scope";
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
import { ACCOUNT_DELETION_INTENT, ACCOUNT_DELETION_INTENT_HEADER } from "../lifecycle/enforce";
import type { UserLifecycleHookEvent, UserLifecycleHooks } from "../lifecycle/hooks";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { runAuthPurge, runAuthPurgeDue } from "../purge/workflow";
import { footprintCounts, seedAccountFootprint } from "../test-utils/accountFootprint";
import {
  AUTH_USERS_DELETE_SCOPE,
  AUTH_USERS_EXPORT_SCOPE,
  AUTH_USERS_READ_SCOPE,
  AUTH_USERS_SUSPEND_SCOPE,
} from "./guards";
import {
  AccountDeleteResponse,
  AdminUserDeleteResponse,
  AdminUserExportResponse,
  AdminUserRestoreResponse,
  AuthUserExport,
} from "./responses";

/**
 * Delete, restore, export and the purge, through the control plane — and a person deleting their own account
 * (#622). A real `createBackend`, real D1, tokens signed by `mintControlPlaneToken`, a person signed in over OTP
 * the way a reader signs in, and the purge Workflow's own body run against a step runner that journals the
 * way a Workflow does.
 *
 * The transitions underneath are proved in `../lifecycle/transitions.workers.test.ts`, the purge's step order
 * in `../purge/run.test.ts`, and auth's own erase in `../purge/contribution.workers.test.ts`. What this file
 * proves is what an operator and a person meet: the scopes, the refusals, the sessions, the mail, the audit
 * trail, the purge actually started, and every response exactly the schema a client validates it with.
 */

const ORIGIN = "http://localhost";
const ENVIRONMENT = "dev";
const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3399";
const ISSUER = "https://app.pithy.sh";
const KEY_ID = "cpk_admin_1";
const SUBJECT = "ops@dashboard.test";
const WINDOW_DAYS = 14;
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
  "pithy_auth_verification_outcomes",
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
/** Every purge instance the binding took, under the id it was created with. */
let started: { id: string; params: unknown }[] = [];
let bindPurge = true;
/** Make the `silent` capability's erase throw, so a purge stops at its step and records the failure. */
let failSilent = false;

/**
 * The purge Workflow binding, holding one instance per id the way Cloudflare does: a `create` under an id it
 * already holds is refused, and `get` finds what it holds.
 */
function purgeBinding() {
  return {
    create: async (options: { id?: string; params?: unknown }) => {
      const id = options.id ?? crypto.randomUUID();
      if (started.some((each) => each.id === id)) throw new Error(`instance.already_exists: ${id}`);
      started.push({ id, params: options.params });
    },
    get: async (id: string) => {
      if (!started.some((each) => each.id === id)) throw new Error(`instance.not_found: ${id}`);
      return { id };
    },
  };
}

/** The parameters each started purge was handed, in the order they were started. */
const startedParams = () => started.map((each) => each.params);

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
    ...(bindPurge ? { AUTH_PURGE: purgeBinding() } : {}),
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

/** An adopter's own tables, as the adopter's `app` capability declares how they are erased and exported. */
const drafts = new Map<string, string[]>();
const appCapability = defineCapability({
  name: "app",
  requiredBindings: [],
  purge: [
    {
      subject: "user",
      summary: "Deletes the user's drafts.",
      erase: async ({ subject }) => void drafts.delete(subject.id),
      export: async ({ subject }) => ({ drafts: drafts.get(subject.id) ?? [] }),
    },
  ],
});

/**
 * The audit recorder a Workflow step records through — what `@pithy-sh/audit` declares — writing to the same
 * capture the request-time events land in, so one list holds the whole trail.
 */
const recorderCapability = defineCapability({
  name: "recorder",
  requiredBindings: [],
  auditRecorder: () => async (event) => void emitted.push(event as AuditEventInput),
  // And the citation reader `@pithy-sh/audit` declares (#823), over the same capture: each event's place in the
  // list stands for its chain position, so the erasure attestation's citations are checked end to end.
  auditCitations: () => async (query) =>
    emitted.flatMap((event, index) =>
      event.resourceType === query.resourceType &&
      typeof event.resourceId === "string" &&
      query.resourceIds.includes(event.resourceId) &&
      query.actions.includes(event.action)
        ? [
            {
              eventId: `ev-${index + 1}`,
              action: event.action,
              resourceId: event.resourceId,
              occurredAt: new Date(),
              tenant: event.tenant ?? null,
              seq: index + 1,
              hash: "c".repeat(64),
              step: typeof event.metadata?.step === "string" ? event.metadata.step : null,
            },
          ]
        : [],
    ),
});

/** A capability that erases rows and does not say how to export them. */
const silentCapability = defineCapability({
  name: "silent",
  requiredBindings: [],
  purge: [
    {
      subject: "user",
      summary: "Deletes the user's scores.",
      erase: async () => {
        if (failSilent) throw new Error("the scores table is unreachable");
      },
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
        retention: { purgeAfterDays: WINDOW_DAYS },
        onUserSuspended: hook("onUserSuspended"),
        onUserDeleted: hook("onUserDeleted"),
        onUserPurged: hook("onUserPurged"),
      }),
      controlplane(),
      silentCapability,
      recorderCapability,
      captureCapability,
    ],
    app: appCapability,
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
async function call(path: string, body: unknown, scope: ControlPlaneScope, method = "POST") {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: signingKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope,
    ...(payload === undefined ? {} : { body: new TextEncoder().encode(payload) }),
  });
  return buildApp().request(
    path,
    {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        [CONTROL_PLANE_HEADER]: token,
        "cf-ray": "ray-622",
      },
      ...(payload === undefined ? {} : { body: payload }),
    },
    workerEnv(),
  );
}

const remove = (userId: string, body: unknown, scope: ControlPlaneScope = AUTH_USERS_DELETE_SCOPE) =>
  call(`/auth/admin/users/${userId}`, body, scope, "DELETE");
const restore = (userId: string, body: unknown, scope: ControlPlaneScope = AUTH_USERS_DELETE_SCOPE) =>
  call(`/auth/admin/users/${userId}/restore`, body, scope);
const exportOf = (userId: string, reason: string | null, scope: ControlPlaneScope = AUTH_USERS_EXPORT_SCOPE) =>
  call(
    `/auth/admin/users/${userId}/export${reason === null ? "" : `?reason=${encodeURIComponent(reason)}`}`,
    undefined,
    scope,
    "GET",
  );
const suspend = (userId: string, body: unknown) =>
  call(`/auth/admin/users/${userId}/suspend`, body, AUTH_USERS_SUSPEND_SCOPE);

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

async function columns(userId: string): Promise<{ deleted_at: number | null; purge_after: number | null }> {
  const row = await env.DB.prepare("select deleted_at, purge_after from pithy_auth_users where id = ?")
    .bind(userId)
    .first<{ deleted_at: number | null; purge_after: number | null }>();
  if (!row) throw new Error(`no user ${userId}`);
  return row;
}

/** The lifecycle mails enqueued, in order. */
async function lifecycleMail(): Promise<{ template: string; to: string }[]> {
  const rows = await env.DB.prepare(
    "select template, to_address from pithy_email_jobs where template in ('deletionScheduled', 'deletionComplete') order by rowid",
  ).all<{ template: string; to_address: string }>();
  return rows.results.map((row) => ({ template: row.template, to: row.to_address }));
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return (await res.json<{ error: { code: string; message: string } }>()).error;
}

/** Ask for a one-time code and post it back, the way a reader signs in. */
async function signInWithOtp(extra: Record<string, string> = {}): Promise<Response> {
  const headers = { "content-type": "application/json", origin: ORIGIN, ...extra };
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

const asHolder = (token: string, path: string, method = "GET", body?: unknown) =>
  buildApp().request(
    path,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    workerEnv(),
  );

/** The person deleting their own account. */
const deleteOwn = (token: string, body: unknown = { confirm: true }) =>
  asHolder(token, "/auth/account", "DELETE", body);

class Terminal extends Error {}

/** A Workflow's step runner in miniature: a finished step is served from its journal and never re-run. */
function journal() {
  const done = new Map<string, unknown>();
  const ran: string[] = [];
  return {
    ran,
    step: {
      async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (done.has(name)) return done.get(name) as T;
        ran.push(name);
        const value = await fn();
        done.set(name, value);
        return value;
      },
    },
  };
}

/** Run one account's purge the way the adopter's Workflow class does, in the Worker that composed it. */
async function purge(userId: string, steps = journal()) {
  buildApp();
  return runAuthPurge(workerEnv(), { payload: { userId }, instanceId: "test" }, steps.step, Terminal);
}

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
  started = [];
  bindPurge = true;
  failSilent = false;
  drafts.clear();
  await grant([AUTH_USERS_DELETE_SCOPE, AUTH_USERS_EXPORT_SCOPE, AUTH_USERS_SUSPEND_SCOPE]);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("DELETE /auth/admin/users/:userId", () => {
  test("no mode soft-deletes: the window from retention.purgeAfterDays, every session revoked, and sign-in refused with auth/account_deleted", async () => {
    const { token, userId } = await signedIn();
    const before = Date.now();
    const res = await remove(userId, { reason: "Asked by email." });
    expect(res.status).toBe(200);
    const raw = await res.json();
    expect(AdminUserDeleteResponse.parse(raw)).toEqual(raw);
    const body = AdminUserDeleteResponse.parse(raw);
    expect(body).toMatchObject({
      userId,
      state: "deleted",
      mode: "soft",
      outcome: "deleted",
      purge: "scheduled",
      sessionsRevoked: 1,
      mailed: true,
    });
    const { deleted_at, purge_after } = await columns(userId);
    expect(deleted_at).toBeGreaterThanOrEqual(before);
    expect(purge_after).toBe((deleted_at ?? 0) + WINDOW_DAYS * DAY);
    expect(body.purgeAfter).toBe(new Date(purge_after ?? 0).toISOString());

    // The credential they held opens nothing, and the door they come back to says why.
    expect(await sessionCount(userId)).toBe(0);
    expect((await asHolder(token, "/auth/devices")).status).toBe(401);
    const again = await signInWithOtp();
    expect(again.status).toBe(403);
    expect((await errorOf(again)).code).toBe("auth/account_deleted");
    expect(await sessionCount(userId)).toBe(0);

    // Nothing was started: a soft deletion waits for its window.
    expect(started).toEqual([]);
    expect(await lifecycleMail()).toEqual([{ template: "deletionScheduled", to: ADDRESS }]);
    expect(fired.map((each) => each.hook)).toEqual(["onUserDeleted"]);
    expect(events("auth/admin_user_soft_deleted")).toEqual([
      expect.objectContaining({
        outcome: "success",
        actorType: "control-plane",
        actorId: SUBJECT,
        resourceId: userId,
        requestId: "ray-622",
        metadata: expect.objectContaining({ connectionId: CONNECTION_ID, reason: "Asked by email." }),
      }),
    ]);
    expect(events("auth/admin_user_sessions_revoked")).toEqual([
      expect.objectContaining({
        resourceId: userId,
        metadata: expect.objectContaining({ revoked: 1, cause: "deleted" }),
      }),
    ]);
  });

  test('mode: "hard" closes the window now and starts the purge', async () => {
    await seedUser("u-1");
    await seedSession("s-1", "u-1");
    const res = await remove("u-1", { mode: "hard", reason: "Fraud." });
    expect(res.status).toBe(200);
    const body = AdminUserDeleteResponse.parse(await res.json());
    expect(body).toMatchObject({
      mode: "hard",
      outcome: "deleted",
      purge: "started",
      sessionsRevoked: 1,
      mailed: false,
    });
    expect(body.purgeAfter).toBe(body.deletedAt);
    const { deleted_at, purge_after } = await columns("u-1");
    expect(purge_after).toBe(deleted_at);
    expect(startedParams()).toEqual([{ userId: "u-1" }]);
    expect(started[0]?.id).toMatch(/^auth-purge-[0-9a-f]{40}-\d{8}$/);
    // Nothing is scheduled, so no mail says it is. The purge sends the deletion-complete one.
    expect(await lifecycleMail()).toEqual([]);
    expect(events("auth/admin_user_hard_deleted")).toEqual([
      expect.objectContaining({ actorId: SUBJECT, metadata: expect.objectContaining({ reason: "Fraud." }) }),
    ]);
    expect(events("auth/admin_user_soft_deleted")).toEqual([]);
  });

  test("a hard deletion with notify: false passes it to the purge, so no deletion-complete mail is sent", async () => {
    await seedUser("u-1");
    await remove("u-1", { mode: "hard", reason: "Fraud.", notify: false });
    expect(startedParams()).toEqual([{ userId: "u-1", notify: false }]);
  });

  test("a hard deletion repeated is one purge: the second finds the instance the first started, and starts none", async () => {
    await seedUser("u-1");
    await remove("u-1", { mode: "hard", reason: "Fraud." });
    const again = AdminUserDeleteResponse.parse(
      await (await remove("u-1", { mode: "hard", reason: "Fraud, again." })).json(),
    );
    expect(again).toMatchObject({ outcome: "unchanged", purge: "started" });
    expect(started).toHaveLength(1);
    // And the daily pass, finding the same account due the same day, asks for that instance too.
    buildApp();
    await runAuthPurgeDue(workerEnv(), { payload: {} }, journal().step, Terminal);
    expect(started).toHaveLength(1);
  });

  test("a hard deletion with notify: false whose purge was pending sends no mail when the daily pass purges it", async () => {
    bindPurge = false;
    await seedAccountFootprint(env.DB, "u-1");
    const body = AdminUserDeleteResponse.parse(
      await (await remove("u-1", { mode: "hard", reason: "Fraud.", notify: false })).json(),
    );
    expect(body.purge).toBe("pending");
    bindPurge = true;
    buildApp();
    expect(await runAuthPurgeDue(workerEnv(), { payload: {} }, journal().step, Terminal)).toEqual({ started: 1 });
    // The pass hands the purge the account alone; the choice is the deletion's, read off its row.
    expect(startedParams()).toEqual([{ userId: "u-1" }]);
    expect(await purge("u-1")).toMatchObject({ state: "purged", mailed: false });
    expect(await lifecycleMail()).toEqual([]);
  });

  test("with no purge Workflow bound, a hard deletion is written and its purge reported pending, not started", async () => {
    bindPurge = false;
    await seedUser("u-1");
    const body = AdminUserDeleteResponse.parse(await (await remove("u-1", { mode: "hard", reason: "x" })).json());
    expect(body).toMatchObject({ outcome: "deleted", purge: "pending" });
    expect((await columns("u-1")).deleted_at).not.toBeNull();
  });

  test("the daily pass reports no purge it could not start: none bound, or every create refused", async () => {
    for (const id of ["due-1", "due-2"]) await seedAccountFootprint(env.DB, id);
    await remove("due-1", { reason: "x" });
    await remove("due-2", { reason: "x" });
    await env.DB.prepare("update pithy_auth_users set purge_after = ?")
      .bind(Date.now() - DAY)
      .run();
    buildApp();
    bindPurge = false;
    expect(await runAuthPurgeDue(workerEnv(), { payload: {} }, journal().step, Terminal)).toEqual({ started: 0 });
    bindPurge = true;
    const refusing = {
      ...workerEnv(),
      AUTH_PURGE: { create: async () => Promise.reject(new Error("quota exceeded")) },
    };
    expect(await runAuthPurgeDue(refusing, { payload: {} }, journal().step, Terminal)).toEqual({ started: 0 });
    expect(started).toEqual([]);
    expect(await runAuthPurgeDue(workerEnv(), { payload: {} }, journal().step, Terminal)).toEqual({ started: 2 });
  });

  test("hard is never reached by omission or by a typo in mode: a typo is refused and nothing is written", async () => {
    await seedUser("u-1");
    for (const mode of ["Hard", "HARD", "hrad", "hard ", "purge", true]) {
      const res = await remove("u-1", { mode, reason: "x" });
      expect(res.status, String(mode)).toBe(400);
      expect((await errorOf(res)).code).toBe("validation/invalid_input");
    }
    expect(await columns("u-1")).toEqual({ deleted_at: null, purge_after: null });
    expect(started).toEqual([]);
    // Omitted, it is soft, and nothing is started.
    const soft = AdminUserDeleteResponse.parse(await (await remove("u-1", { reason: "x" })).json());
    expect(soft.mode).toBe("soft");
    expect(started).toEqual([]);
    // Each refusal is on the trail, under the soft action — none of them said "hard".
    expect(
      events("auth/admin_user_soft_deleted")
        .filter((event) => event.outcome === "denied")
        .map((e) => e.metadata?.code),
    ).toEqual(Array(6).fill("validation/invalid_input"));
    expect(events("auth/admin_user_hard_deleted")).toEqual([]);
  });

  test("a request with no reason is refused validation/invalid_input, and the refusal is audited", async () => {
    await seedUser("u-1");
    for (const body of [{}, { mode: "hard" }, { reason: "   " }]) {
      const res = await remove("u-1", body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("validation/invalid_input");
    }
    expect(await columns("u-1")).toEqual({ deleted_at: null, purge_after: null });
    expect(events("auth/admin_user_hard_deleted")).toEqual([
      expect.objectContaining({
        outcome: "denied",
        metadata: expect.objectContaining({ code: "validation/invalid_input" }),
      }),
    ]);
  });

  test("deleting a deleted account changes nothing, answers 200, and is still audited", async () => {
    await seedUser("u-1");
    await remove("u-1", { reason: "x" });
    const body = AdminUserDeleteResponse.parse(await (await remove("u-1", { reason: "again" })).json());
    expect(body.outcome).toBe("unchanged");
    expect(fired.filter((each) => each.hook === "onUserDeleted")).toHaveLength(1);
    expect(events("auth/admin_user_soft_deleted").map((event) => event.metadata?.changed)).toEqual([undefined, false]);
  });

  test("a hard deletion of a soft-deleted account brings its purge forward and starts it", async () => {
    await seedUser("u-1");
    await remove("u-1", { reason: "x" });
    const body = AdminUserDeleteResponse.parse(await (await remove("u-1", { mode: "hard", reason: "Now." })).json());
    expect(body).toMatchObject({ outcome: "brought_forward", purge: "started" });
    expect(started).toHaveLength(1);
  });

  test("an unknown user is a 404, audited with the reason", async () => {
    const res = await remove("nobody", { reason: "x" });
    expect(res.status).toBe(404);
    expect(events("auth/admin_user_soft_deleted")).toEqual([
      expect.objectContaining({
        outcome: "denied",
        metadata: expect.objectContaining({ code: "core/not_found", reason: "x" }),
      }),
    ]);
  });
});

describe("POST /auth/admin/users/:userId/restore", () => {
  test("inside the window clears both columns and lets the person sign in again", async () => {
    const { userId } = await signedIn();
    await remove(userId, { reason: "x" });
    expect((await signInWithOtp()).status).toBe(403);

    const res = await restore(userId, { reason: "Changed their mind." });
    expect(res.status).toBe(200);
    const raw = await res.json();
    expect(AdminUserRestoreResponse.parse(raw)).toEqual(raw);
    expect(raw).toEqual({ userId, state: "active", outcome: "restored" });
    expect(await columns(userId)).toEqual({ deleted_at: null, purge_after: null });
    expect((await signInWithOtp()).status).toBe(200);
    expect(events("auth/admin_user_restored")).toEqual([
      expect.objectContaining({
        actorId: SUBJECT,
        metadata: expect.objectContaining({ reason: "Changed their mind." }),
      }),
    ]);
  });

  test("after a purge it answers 404, and the refusal is audited", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "x" });
    await purge("u-1");
    const res = await restore("u-1", { reason: "Too late." });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("core/not_found");
    expect(events("auth/admin_user_restored")).toEqual([
      expect.objectContaining({ outcome: "denied", metadata: expect.objectContaining({ code: "core/not_found" }) }),
    ]);
  });

  test("once the window has closed it is a conflict, and the account stays deleted", async () => {
    await seedUser("u-1");
    bindPurge = false;
    await remove("u-1", { mode: "hard", reason: "x" });
    const res = await restore("u-1", { reason: "y" });
    expect(res.status).toBe(409);
    expect((await columns("u-1")).deleted_at).not.toBeNull();
  });

  test("a request with no reason is refused validation/invalid_input", async () => {
    await seedUser("u-1");
    const res = await restore("u-1", {});
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });
});

describe("the purge", () => {
  test("erases every composed capability's rows, records each step, and leaves no pithy_auth_* row but the record", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await seedAccountFootprint(env.DB, "u-2");
    await env.DB.prepare(
      "insert into pithy_email_suppressions (email, reason, created_at) values ('u-1@test.com', 'complaint', 0), ('u-2@test.com', 'bounce', 0)",
    ).run();
    drafts.set("u-1", ["a draft"]);
    await remove("u-1", { mode: "hard", reason: "Fraud." });
    const steps = journal();
    const outcome = await purge("u-1", steps);
    expect(outcome).toEqual({
      userId: "u-1",
      state: "purged",
      erased: ["silent", "app", "auth"],
      // Email is composed, and keeps the address's suppression and mail log through a purge (#814).
      retained: ["email"],
      mailed: true,
    });
    expect(steps.ran).toEqual(["due", "retain email", "erase silent", "erase app", "mail", "erase auth", "complete"]);
    expect(drafts.has("u-1")).toBe(false);

    const counts = await footprintCounts(env.DB, "u-1");
    expect(counts).toEqual({
      pithy_auth_users: 0,
      pithy_auth_sessions: 0,
      pithy_auth_accounts: 0,
      pithy_auth_devices: 0,
      pithy_auth_rotated_tokens: 0,
      pithy_auth_verification_outcomes: 0,
      pithy_auth_verifications: 0,
      pithy_auth_user_lifecycle: (await history("u-1")).length,
    });
    expect((await history("u-1")).map((row) => [row.action, row.step])).toEqual([
      ["deleted", null],
      ["purge_retained", "email"],
      ["purge_step", "silent"],
      ["purge_step", "app"],
      ["purge_step", "auth"],
      ["purged", null],
    ]);
    // Email retains: the address's suppression outlives the account it belonged to.
    const suppressed = await env.DB.prepare("select email from pithy_email_suppressions order by email").all<{
      email: string;
    }>();
    expect(suppressed.results.map((row) => row.email)).toEqual(["u-1@test.com", "u-2@test.com"]);
    // Somebody else's rows are where they were.
    expect((await footprintCounts(env.DB, "u-2")).pithy_auth_users).toBe(1);
    expect((await footprintCounts(env.DB, "u-2")).pithy_auth_verification_outcomes).toBe(1);
  });

  test("the deletion-complete mail goes to the address, sent before the address is erased", async () => {
    await seedAccountFootprint(env.DB, "u-1", "leaving@example.test");
    await remove("u-1", { mode: "hard", reason: "x" });
    await purge("u-1");
    // The address is read in the mail step, from the row auth's own step erases after it — never carried in the
    // journal — so a mail to it is the proof it went before the row did.
    expect(await lifecycleMail()).toEqual([{ template: "deletionComplete", to: "leaving@example.test" }]);
  });

  test("onUserDeleted and onUserPurged fire once each, and re-running the purge exits without error", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "x" });
    await purge("u-1");
    expect(await purge("u-1")).toEqual({ userId: "u-1", state: "gone", erased: [], retained: [], mailed: false });
    expect(await purge("u-1", journal())).toMatchObject({ state: "gone" });
    expect(fired.map((each) => each.hook)).toEqual(["onUserDeleted", "onUserPurged"]);
    expect((await history("u-1")).filter((row) => row.action === "purged")).toHaveLength(1);
    // Recorded once, from the Workflow, through the composed recorder — there is no request to record it on.
    expect(events("auth/admin_user_purged")).toEqual([
      expect.objectContaining({ outcome: "success", actorType: "system", actorId: null, resourceId: "u-1" }),
    ]);
  });

  test("two purges of one account that overlap record, audit and fire onUserPurged once between them", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "x" });
    const outcomes = await Promise.all([purge("u-1"), purge("u-1")]);
    expect(outcomes.every((outcome) => outcome.state === "purged" || outcome.state === "gone")).toBe(true);
    expect(fired.filter((each) => each.hook === "onUserPurged")).toHaveLength(1);
    expect((await history("u-1")).filter((row) => row.action === "purged")).toHaveLength(1);
    expect(events("auth/admin_user_purged")).toHaveLength(1);
    expect((await footprintCounts(env.DB, "u-1")).pithy_auth_users).toBe(0);
  });

  test("an account inside its window, or restored, is not erased", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { reason: "x" });
    expect(await purge("u-1")).toMatchObject({ state: "not_due" });
    expect((await footprintCounts(env.DB, "u-1")).pithy_auth_users).toBe(1);
  });

  test("the daily pass starts the purge for every account past purgeAfter, and for none before it", async () => {
    for (const id of ["due-1", "due-2", "inside", "active"]) await seedAccountFootprint(env.DB, id);
    await remove("due-1", { reason: "x" });
    await remove("due-2", { reason: "x" });
    await remove("inside", { reason: "x" });
    // Two windows have closed: their purge was due yesterday. The third is still open.
    await env.DB.prepare("update pithy_auth_users set purge_after = ? where id in ('due-1', 'due-2')")
      .bind(Date.now() - DAY)
      .run();
    buildApp();
    const result = await runAuthPurgeDue(workerEnv(), { payload: {} }, journal().step, Terminal);
    expect(result).toEqual({ started: 2 });
    expect(startedParams()).toEqual([{ userId: "due-1" }, { userId: "due-2" }]);
    // One instance per deletion: each account's own id.
    expect(new Set(started.map((each) => each.id)).size).toBe(2);
  });
});

describe("the erasure attestation (#823)", () => {
  const attest = (userId: string, scope: ControlPlaneScope = ERASURE_READ_SCOPE) =>
    call(`/control-plane/erasure/user/${userId}`, undefined, scope, "GET");

  test("attests a purged account: the deletion, every step erased or kept with its reason, complete, each step cited", async () => {
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "Fraud." });
    await purge("u-1");

    const response = await attest("u-1");
    expect(response.status).toBe(200);
    const body = ControlPlaneErasureSubjectResponse.parse(await response.json());
    const { attestation } = body;
    expect(attestation).toMatchObject({
      subject: { type: "user", id: "u-1" },
      deletion: {
        actorType: "control-plane",
        reason: "Fraud.",
        mode: "hard",
        audit: { action: "auth/admin_user_hard_deleted" },
      },
      state: "complete",
      overdue: false,
      stoppedAt: null,
      trail: "recorded",
      completion: { action: "auth/admin_user_purged" },
      failure: null,
    });
    expect(attestation.steps.map((step) => [step.capability, step.disposition])).toEqual([
      ["email", "retained"],
      ["silent", "erased"],
      ["app", "erased"],
      ["auth", "erased"],
    ]);
    // A retained step shows its basis, and never reads as erased (#814).
    expect(attestation.steps[0]?.reason).toBeTruthy();
    expect(attestation.steps[0]?.summary).toBeNull();
    // Every step and the completion are cited by id and position, each its own event.
    const cited = [...attestation.steps.map((step) => step.audit), attestation.completion];
    expect(cited.every((each) => each !== null && each.seq !== null)).toBe(true);
    expect(new Set(cited.map((each) => each?.eventId)).size).toBe(cited.length);
    expect(events("auth/admin_user_purge_step").map((event) => event.metadata)).toEqual([
      { step: "email", disposition: "retained" },
      { step: "silent", disposition: "erased" },
      { step: "app", disposition: "erased" },
      { step: "auth", disposition: "erased" },
    ]);
    // Nothing about the person beyond the id: not the address, not the name.
    const text = JSON.stringify(body);
    expect(text).not.toContain("u-1@test.com");
    expect(text).not.toContain("Ada");
  });

  test("the period counts the purge, and names none for attention when it completed", async () => {
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "Fraud." });
    await purge("u-1");
    const response = await call("/control-plane/erasure", undefined, ERASURE_READ_SCOPE, "GET");
    expect(response.status).toBe(200);
    const body = ControlPlaneErasurePeriodResponse.parse(await response.json());
    expect(body.subjects).toEqual(["user"]);
    expect(body.counts).toMatchObject({ complete: 1, inProgress: 0, failed: 0 });
    expect(body.attention).toEqual([]);
    expect(body.purges.map((entry) => entry.subject.id)).toEqual(["u-1"]);
  });

  test("the period names a purge that came due before the window and has done nothing since, overdue at `due`", async () => {
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "Fraud." });
    // Deleted 130 days ago and due 100 days ago, before the default 90-day window opened; the purge never started.
    const now = Date.now();
    await env.DB.prepare("update pithy_auth_user_lifecycle set created_at = ?, purge_after = ? where user_id = ?")
      .bind(now - 130 * DAY, now - 100 * DAY, "u-1")
      .run();
    const response = await call("/control-plane/erasure", undefined, ERASURE_READ_SCOPE, "GET");
    expect(response.status).toBe(200);
    const body = ControlPlaneErasurePeriodResponse.parse(await response.json());
    expect(body.counts).toMatchObject({ complete: 0, overdue: 1 });
    expect(body.attention).toEqual([
      expect.objectContaining({ subject: { type: "user", id: "u-1" }, overdue: true, stoppedAt: "due" }),
    ]);
  });

  test("attests an operator's soft deletion: scheduled, nothing erased yet, citing auth/admin_user_soft_deleted", async () => {
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { reason: "Requested by mail." });

    const response = await attest("u-1");
    expect(response.status).toBe(200);
    const { attestation } = ControlPlaneErasureSubjectResponse.parse(await response.json());
    expect(attestation).toMatchObject({
      subject: { type: "user", id: "u-1" },
      deletion: { actorType: "control-plane", mode: "soft", audit: { action: "auth/admin_user_soft_deleted" } },
      state: "scheduled",
      completion: null,
      failure: null,
    });
    expect(attestation.deletion.audit?.seq).not.toBeNull();
  });

  test("attests a person's own deletion, citing auth/user_self_deleted", async () => {
    const { token, userId } = await signedIn();
    expect((await deleteOwn(token)).status).toBe(200);
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);

    const response = await attest(userId);
    expect(response.status).toBe(200);
    const { attestation } = ControlPlaneErasureSubjectResponse.parse(await response.json());
    expect(attestation).toMatchObject({
      subject: { type: "user", id: userId },
      deletion: { actorType: "user", mode: "soft", audit: { action: "auth/user_self_deleted" } },
      state: "scheduled",
      failure: null,
    });
  });

  test("attests a failed purge: failed at the step it stopped at, citing auth/admin_user_purge_failed", async () => {
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "Fraud." });
    failSilent = true;
    await expect(purge("u-1")).rejects.toThrow();

    const response = await attest("u-1");
    expect(response.status).toBe(200);
    const { attestation } = ControlPlaneErasureSubjectResponse.parse(await response.json());
    expect(attestation).toMatchObject({
      state: "failed",
      stoppedAt: "silent",
      completion: null,
      failure: { action: "auth/admin_user_purge_failed" },
    });
    expect(attestation.failure?.seq).not.toBeNull();
  });

  test("an account never deleted is a 404, and the read is refused without erasure:read", async () => {
    await grant([AUTH_USERS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
    await seedUser("u-2");
    expect((await attest("u-2")).status).toBe(404);
    await grant([AUTH_USERS_DELETE_SCOPE, AUTH_USERS_READ_SCOPE]);
    expect((await attest("u-2", AUTH_USERS_READ_SCOPE)).status).toBe(403);
    expect((await attest("u-2")).status).toBe(403);
  });
});

describe("DELETE /auth/account", () => {
  test("deletes the caller's own account, soft, on the configured window, and ends every session", async () => {
    const { token, userId } = await signedIn();
    const before = Date.now();
    const res = await deleteOwn(token);
    expect(res.status).toBe(200);
    const raw = await res.json();
    expect(AccountDeleteResponse.parse(raw)).toEqual(raw);
    const { deleted_at, purge_after } = await columns(userId);
    expect(deleted_at).toBeGreaterThanOrEqual(before);
    expect(purge_after).toBe((deleted_at ?? 0) + WINDOW_DAYS * DAY);
    expect(raw).toEqual({ state: "deleted", purgeAfter: new Date(purge_after ?? 0).toISOString(), mailed: true });
    expect(await sessionCount(userId)).toBe(0);
    expect(started).toEqual([]);
    expect((await signInWithOtp()).status).toBe(403);
    expect(events("auth/user_self_deleted")).toEqual([
      expect.objectContaining({ outcome: "success", actorType: "user", actorId: userId, resourceId: userId }),
    ]);
    expect(fired.map((each) => each.hook)).toEqual(["onUserDeleted"]);
  });

  test("cannot name another user: a body naming one deletes the caller's own and nobody else's", async () => {
    await seedUser("u-other");
    const { token, userId } = await signedIn();
    const res = await deleteOwn(token, { confirm: true, userId: "u-other" });
    expect(res.status).toBe(200);
    expect((await columns(userId)).deleted_at).not.toBeNull();
    expect(await columns("u-other")).toEqual({ deleted_at: null, purge_after: null });
  });

  test("requires the explicit confirmation, and is refused without it", async () => {
    const { token, userId } = await signedIn();
    for (const body of [{}, { confirm: false }, { confirm: "true" }]) {
      const res = await deleteOwn(token, body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("validation/invalid_input");
    }
    expect(await columns(userId)).toEqual({ deleted_at: null, purge_after: null });
  });

  test("a suspended user can still delete their own account: suspend, sign in for deletion, delete", async () => {
    const { userId } = await signedIn();
    await suspend(userId, { reason: "Chargeback under review." });
    expect(await sessionCount(userId)).toBe(0);

    // An ordinary sign-in is refused, as every suspension refuses it.
    const refused = await signInWithOtp();
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe("auth/account_suspended");
    expect(await sessionCount(userId)).toBe(0);

    // A sign-in that asks only to delete the account completes — the person still proves who they are.
    const asked = await signInWithOtp({ [ACCOUNT_DELETION_INTENT_HEADER]: ACCOUNT_DELETION_INTENT });
    expect(asked.status).toBe(200);
    const { token } = await asked.json<{ token: string }>();

    // The session it gets opens no other door: not a kit route, not a token, not a refresh.
    expect((await errorOf(await asHolder(token, "/auth/devices"))).code).toBe("auth/account_suspended");
    expect((await asHolder(token, "/auth/token")).status).toBe(403);
    expect((await asHolder(token, "/auth/token/rotate", "POST", {})).status).toBe(403);
    expect((await columns(userId)).deleted_at).toBeNull();

    const res = await deleteOwn(token);
    expect(res.status).toBe(200);
    expect((await columns(userId)).deleted_at).not.toBeNull();
    expect(await sessionCount(userId)).toBe(0);
    expect(events("auth/user_self_deleted")).toEqual([
      expect.objectContaining({ actorId: userId, metadata: expect.objectContaining({ suspended: true }) }),
    ]);
  });

  test("the deletion intent admits no sign-in for an account already deleted", async () => {
    const { userId } = await signedIn();
    await remove(userId, { reason: "x" });
    const res = await signInWithOtp({ [ACCOUNT_DELETION_INTENT_HEADER]: ACCOUNT_DELETION_INTENT });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("auth/account_deleted");
    expect(await sessionCount(userId)).toBe(0);
  });

  test("a deleted account is refused with auth/account_deleted, and nothing moves", async () => {
    const { token, userId } = await signedIn();
    const held = await env.DB.prepare("select * from pithy_auth_sessions where user_id = ?")
      .bind(userId)
      .first<Record<string, unknown>>();
    if (!held) throw new Error("no session to hold");
    await remove(userId, { reason: "x" });
    const keys = Object.keys(held);
    await env.DB.prepare(
      `insert into pithy_auth_sessions (${keys.join(", ")}) values (${keys.map(() => "?").join(", ")})`,
    )
      .bind(...keys.map((key) => held[key]))
      .run();
    const res = await deleteOwn(token);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("auth/account_deleted");
  });

  test("with no credential it is a 401", async () => {
    const res = await buildApp().request(
      "/auth/account",
      { method: "DELETE", headers: { "content-type": "application/json", origin: ORIGIN }, body: '{"confirm":true}' },
      workerEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/admin/users/:userId/export", () => {
  test("one JSON document covering every composed capability's contribution, validated by its exported schema", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await env.DB.prepare(
      "insert into pithy_email_suppressions (email, reason, created_at) values ('u-1@test.com', 'complaint', 0), ('u-2@test.com', 'bounce', 0)",
    ).run();
    drafts.set("u-1", ["a draft"]);
    const res = await exportOf("u-1", "Access request 4411.");
    expect(res.status).toBe(200);
    const raw = await res.json();
    const document = AdminUserExportResponse.parse(raw);
    expect(document).toEqual(raw);
    expect(document.subject).toEqual({ type: "user", id: "u-1" });
    expect(document.capabilities.map((entry) => [entry.capability, entry.state])).toEqual([
      ["email", "exported"],
      ["auth", "exported"],
      ["silent", "not_exported"],
      ["app", "exported"],
    ]);
    // A retained part says so, and why; an erased one says that (#814).
    expect(document.capabilities.map((entry) => entry.disposition)).toEqual(["retain", "erase", "erase", "erase"]);
    expect(document.capabilities[0]?.basis).toMatch(/unsubscribe/);
    const [, authPart, , appPart] = document.capabilities;
    if (authPart?.state !== "exported" || appPart?.state !== "exported") throw new Error("expected two parts");
    expect(AuthUserExport.parse(authPart.data).user.email).toBe("u-1@test.com");
    expect(appPart.data).toEqual({ drafts: ["a draft"] });
    // Email's rows are found by the account's real address, read from its row at the step (#814).
    const emailPart = document.capabilities[0];
    if (emailPart?.state !== "exported") throw new Error("expected email's part");
    expect((emailPart.data as { suppressions: { email: string }[] }).suppressions.map((row) => row.email)).toEqual([
      "u-1@test.com",
    ]);
    // No credential crosses: not the session token, the provider tokens, or the push token.
    for (const credential of ["token-u-1", "access-u-1", "refresh-u-1", "push-u-1"]) {
      expect(JSON.stringify(raw)).not.toContain(credential);
    }
  });

  test("is audited as a disclosure, with the caller and the reason and never the data", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await exportOf("u-1", "Access request 4411.");
    expect(events("auth/admin_user_exported")).toEqual([
      expect.objectContaining({
        outcome: "success",
        actorType: "control-plane",
        actorId: SUBJECT,
        resourceId: "u-1",
        metadata: expect.objectContaining({
          reason: "Access request 4411.",
          disclosure: true,
          capabilities: ["email:exported", "auth:exported", "silent:not_exported", "app:exported"],
        }),
      }),
    ]);
    expect(JSON.stringify(events("auth/admin_user_exported"))).not.toContain("u-1@test.com");
  });

  test("an export with no reason is refused validation/invalid_input", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    const res = await exportOf("u-1", null);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("an unknown or purged account is a 404, audited", async () => {
    expect((await exportOf("nobody", "x")).status).toBe(404);
    await seedAccountFootprint(env.DB, "u-1");
    await remove("u-1", { mode: "hard", reason: "x" });
    await purge("u-1");
    expect((await exportOf("u-1", "x")).status).toBe(404);
    expect(events("auth/admin_user_exported").map((event) => event.outcome)).toEqual(["denied", "denied"]);
  });
});

describe("the scopes", () => {
  test("the export is gated by auth:users:export: auth:users:delete and auth:users:read do not open it", async () => {
    await seedAccountFootprint(env.DB, "u-1");
    await grant([AUTH_USERS_DELETE_SCOPE, AUTH_USERS_READ_SCOPE]);
    expect((await exportOf("u-1", "x", AUTH_USERS_DELETE_SCOPE)).status).toBe(403);
    expect((await exportOf("u-1", "x", AUTH_USERS_READ_SCOPE)).status).toBe(403);
    expect(events("auth/admin_user_exported")).toEqual([]);
  });

  test("deletion and restore are gated by auth:users:delete: auth:users:export and auth:users:suspend do not open them", async () => {
    await seedUser("u-1");
    await grant([AUTH_USERS_EXPORT_SCOPE, AUTH_USERS_SUSPEND_SCOPE]);
    for (const scope of [AUTH_USERS_EXPORT_SCOPE, AUTH_USERS_SUSPEND_SCOPE]) {
      expect((await remove("u-1", { reason: "x" }, scope)).status).toBe(403);
      expect((await restore("u-1", { reason: "x" }, scope)).status).toBe(403);
    }
    expect(await columns("u-1")).toEqual({ deleted_at: null, purge_after: null });
  });

  test("the guard runs before the validator: a malformed body under the wrong scope is 403, not 400", async () => {
    await seedUser("u-1");
    await grant([AUTH_USERS_READ_SCOPE]);
    expect((await remove("u-1", { mode: "Hard" }, AUTH_USERS_READ_SCOPE)).status).toBe(403);
    expect(emitted.filter((event) => event.action.startsWith("auth/admin_user_"))).toEqual([]);
  });
});
