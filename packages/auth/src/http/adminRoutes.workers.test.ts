// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CONTROLPLANE_MIGRATION_ORDER, controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import { controlplane_0001_init } from "@pithy-sh/core/src/controlPlane/migrations/0001_init";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { EMAIL_MIGRATION_ORDER, email } from "@pithy-sh/email/src/capability";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { auth } from "../capability";
import { Session, User } from "../data/betterAuth";
import { Device } from "../data/device";
import { authDatabase } from "../data/tables";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import {
  AUTH_DEVICES_READ_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_USERS_READ_SCOPE,
} from "./guards";
import {
  AdminDeviceRevokeResponse,
  AdminDevicesResponse,
  AdminRevokeResponse,
  AdminUserResponse,
  AdminUsersResponse,
} from "./responses";

/**
 * The admin handlers, actually executed — against real D1, a real `createBackend`, and tokens signed by
 * `mintControlPlaneToken`.
 *
 * `routeContract.test.ts` calls each route with no credential and asserts 403, which proves the gate
 * runs and nothing else: every handler body was unreached. That leaves the two things that matter most
 * here unproven. **The projections** — a session token or a device push token slipping into a response
 * is a leak no route-table check can see, and every one of these is a credential the recipient could
 * use. And **the scope separation** — five scopes are worth nothing unless holding one is genuinely not
 * holding another, which only a verified call with the wrong scope can demonstrate.
 *
 * No fixtures on the credential side: a fixture token would prove the assertion and not the seam.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const SECRET = "test-secret-please-rotate-0000000000";
const ENVIRONMENT = "dev";
const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3399";
const ISSUER = "https://app.pithy.sh";
const KEY_ID = "cpk_admin_1";
const SUBJECT = "ops@dashboard.test";

/** The device's push token — an APNs credential, seeded so a response carrying it fails loudly. */
const PUSH_TOKEN = "apns-push-credential-must-not-leak";
/** A provider OAuth access token, for the same reason. */
const OAUTH_ACCESS_TOKEN = "ya29.provider-access-token-must-not-leak";

/** The registry the composed backend aggregates: auth's slice plus the one email declares. */
const REGISTRY = { ...authSecretsRegistry, ...emailSigningRegistry };

/** Every secret the composed backend resolves — all of them, since the accessor resolves in one batch. */
const SECRETS: SecretFixture<typeof REGISTRY> = {
  "auth-session-secret": SECRET,
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
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
];

let signingKey: CryptoKey;
let emitted: AuditEventInput[] = [];

/** A minimal in-memory KV for the seam's replay set; this pool binds D1 only. */
function memoryKv() {
  const entries = new Map<string, string>();
  return {
    get: async (name: string) => entries.get(name) ?? null,
    put: async (name: string, value: string) => void entries.set(name, value),
  };
}

/**
 * The Worker env every call carries. `SECRETS` and `SECRETS_ENCRYPTION_KEYS` come from the pool's own
 * bindings and are the real ones: every secret here is a `d1` entry, read from the row `beforeEach`
 * seeded rather than from anything on the env (#153).
 */
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

/**
 * A capability whose only job is to replace the audit `emit` seam with a capturing one.
 *
 * Composed as the `app`, so its middleware runs after core seeds `noopEmit` and after auth's, but
 * before any route — which is the window in which a handler's `c.var.emit` is decided.
 */
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

function buildApp() {
  return createBackend({
    capabilities: [
      secrets({ registry: authSecretsRegistry }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" }),
      auth({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
      controlplane(),
    ],
    app: captureCapability,
  });
}

/** Register the one connection every call authenticates against, granting exactly `scopes`. */
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

/** One request carrying a freshly minted, body-bound control-plane token. */
async function call(method: string, path: string, scope: ControlPlaneScope, body?: unknown): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: signingKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
  });
  return buildApp().request(
    path,
    { method, headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token }, body: payload },
    workerEnv(),
  );
}

const db = () => authDatabase(env.DB);

async function seedUser(id: string, email: string, ageMinutes: number): Promise<void> {
  const at = new Date(NOW.getTime() - ageMinutes * 60_000);
  await db()
    .insertInto("pithyAuthUsers")
    .values(
      User.encode({
        id,
        name: "Ada Lovelace",
        email,
        emailVerified: true,
        image: null,
        locale: null,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

async function seedSession(id: string, userId: string, deviceId: string | null = null): Promise<string> {
  const token = `session-token-${id}`;
  await db()
    .insertInto("pithyAuthSessions")
    .values(
      Session.encode({
        id,
        token,
        userId,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        ipAddress: "203.0.113.7",
        userAgent: "PithyTest/1.0",
        deviceId,
        familyId: null,
      }),
    )
    .execute();
  return token;
}

async function seedDevice(id: string, userId: string): Promise<void> {
  await db()
    .insertInto("pithyAuthDevices")
    .values(
      Device.encode({
        id,
        userId,
        platform: "ios",
        name: "Ada's phone",
        model: "iPhone",
        osVersion: "26.0",
        appVersion: "1.2.3",
        pushToken: PUSH_TOKEN,
        lastIp: "203.0.113.7",
        lastSeenAt: NOW,
        createdAt: NOW,
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

async function deviceCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from pithy_auth_devices where user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

/** Grant every scope, so a test that is not about authorization is not accidentally about it. */
const ALL_SCOPES: readonly ControlPlaneScope[] = [
  AUTH_USERS_READ_SCOPE,
  AUTH_DEVICES_READ_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
];

async function grant(scopes: readonly ControlPlaneScope[]): Promise<void> {
  await env.DB.prepare("delete from pithy_controlplane_connections").run();
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  await registerConnection(await exportPublicJwk(pair.publicKey), scopes);
}

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
    {
      database: "app",
      namespace: "auth",
      order: AUTH_MIGRATION_ORDER,
      migrations: { "0001_init": auth_0001_init },
    },
    { database: "app", namespace: "email", order: EMAIL_MIGRATION_ORDER, migrations: { "0001_init": email_0001_init } },
    {
      database: "app",
      namespace: "controlplane",
      order: CONTROLPLANE_MIGRATION_ORDER,
      migrations: {
        "0001_init": controlplane_0001_init,
      },
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  // The backend composes `secrets`, whose `compose` hook configures the shared accessor with the real
  // resolver at startup — so the values have to be real rows, written before the first request.
  await seedSecrets(env, REGISTRY, SECRETS);

  emitted = [];
  await grant(ALL_SCOPES);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("GET /auth/admin/users", () => {
  test("lists users newest first and pages with a cursor", async () => {
    await seedUser("u-old", "old@example.test", 300);
    await seedUser("u-new", "new@example.test", 1);

    const first = await call("GET", "/auth/admin/users?limit=1", AUTH_USERS_READ_SCOPE);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ users: { id: string }[]; nextCursor: string | null }>();
    expect(firstBody.users.map((u) => u.id)).toEqual(["u-new"]);
    expect(firstBody.nextCursor).not.toBeNull();

    await grant(ALL_SCOPES);
    const second = await call(
      "GET",
      `/auth/admin/users?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      AUTH_USERS_READ_SCOPE,
    );
    expect((await second.json<{ users: { id: string }[] }>()).users.map((u) => u.id)).toEqual(["u-old"]);
  });

  test("searches by email", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedUser("u-2", "grace@example.test", 20);
    const response = await call("GET", "/auth/admin/users?search=grace", AUTH_USERS_READ_SCOPE);
    expect((await response.json<{ users: { id: string }[] }>()).users.map((u) => u.id)).toEqual(["u-2"]);
  });

  test("a devices-read credential cannot list users", async () => {
    // The whole point of five scopes. A fleet-inventory tool must not carry every customer's address.
    await grant([AUTH_DEVICES_READ_SCOPE]);
    const response = await call("GET", "/auth/admin/users", AUTH_DEVICES_READ_SCOPE);
    expect(response.status).toBe(403);
  });

  test("a revoke credential cannot read users either", async () => {
    await grant([AUTH_SESSIONS_REVOKE_SCOPE]);
    expect((await call("GET", "/auth/admin/users", AUTH_SESSIONS_REVOKE_SCOPE)).status).toBe(403);
  });

  test("the listing is audited as a control-plane read, without the search term", async () => {
    // A read of other people's data is the larger half of an exfiltration incident, so it is recorded.
    // The term is not: on this route it is usually somebody's email address, and the trail outlives the
    // pane that displayed it.
    await seedUser("u-1", "ada@example.test", 10);
    await call("GET", "/auth/admin/users?search=ada", AUTH_USERS_READ_SCOPE);

    const event = emitted.find((e) => e.action === "auth/admin_users_listed");
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe(SUBJECT);
    expect((event?.metadata as { connectionId?: string } | undefined)?.connectionId).toBe(CONNECTION_ID);
    expect(JSON.stringify(event?.metadata)).not.toContain("ada");
  });
});

describe("GET /auth/admin/users/:userId", () => {
  test("returns the user with their sessions, devices, and providers", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedSession("s-1", "u-1", "d-1");
    await seedDevice("d-1", "u-1");
    await db()
      .insertInto("pithyAuthAccounts")
      .values({
        id: "acct-1",
        accountId: "google-sub",
        issuer: "https://accounts.google.com",
        providerId: "google",
        userId: "u-1",
        accessToken: OAUTH_ACCESS_TOKEN,
        refreshToken: "1//refresh-must-not-leak",
        idToken: "eyJ.id.must-not-leak",
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: "openid email",
        password: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .execute();

    const response = await call("GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE);
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).toContain("ada@example.test");
    expect(text).toContain("s-1");
    expect(text).toContain("google");
    expect(text).toContain('"truncated":false');
  });

  test("and never the session token, the push token, or an OAuth token", async () => {
    // Each of these is a live credential. The session token would let the reader act *as* the user —
    // the impersonation this surface deliberately does not offer; the push token would let them put a
    // notification on the user's lock screen under the adopter's app identity; the OAuth tokens are
    // the adopter's users' access to a third party.
    await seedUser("u-1", "ada@example.test", 10);
    const sessionToken = await seedSession("s-1", "u-1", "d-1");
    await seedDevice("d-1", "u-1");
    await db()
      .insertInto("pithyAuthAccounts")
      .values({
        id: "acct-1",
        accountId: "google-sub",
        issuer: "https://accounts.google.com",
        providerId: "google",
        userId: "u-1",
        accessToken: OAUTH_ACCESS_TOKEN,
        refreshToken: "1//refresh-must-not-leak",
        idToken: "eyJ.id.must-not-leak",
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: "openid email",
        password: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .execute();

    const text = await (await call("GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE)).text();
    expect(text).not.toContain(sessionToken);
    expect(text).not.toContain(PUSH_TOKEN);
    expect(text).not.toContain(OAUTH_ACCESS_TOKEN);
    expect(text).not.toContain("refresh-must-not-leak");
    expect(text).not.toContain("must-not-leak");
  });

  test("a user nobody has is a 404, not an empty body", async () => {
    const response = await call("GET", "/auth/admin/users/nobody", AUTH_USERS_READ_SCOPE);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
  });

  test("reading one user is audited, naming the user as the resource", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await call("GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE);
    const event = emitted.find((e) => e.action === "auth/admin_user_read");
    expect(event?.resourceId).toBe("u-1");
    expect(event?.actorType).toBe("control-plane");
  });
});

describe("GET /auth/admin/devices", () => {
  test("walks the registry and never carries a push token", async () => {
    await seedDevice("d-1", "u-1");
    await seedDevice("d-2", "u-2");
    const response = await call("GET", "/auth/admin/devices", AUTH_DEVICES_READ_SCOPE);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("d-1");
    expect(text).toContain("d-2");
    expect(text).not.toContain(PUSH_TOKEN);
  });

  test("filters to one user", async () => {
    await seedDevice("d-1", "u-1");
    await seedDevice("d-2", "u-2");
    const response = await call("GET", "/auth/admin/devices?userId=u-1", AUTH_DEVICES_READ_SCOPE);
    const body = await response.json<{ devices: { id: string }[] }>();
    expect(body.devices.map((d) => d.id)).toEqual(["d-1"]);
  });

  test("a users-read credential cannot walk the fleet", async () => {
    await grant([AUTH_USERS_READ_SCOPE]);
    expect((await call("GET", "/auth/admin/devices", AUTH_USERS_READ_SCOPE)).status).toBe(403);
  });
});

describe("POST /auth/admin/sessions/revoke", () => {
  test("removes the session and audits it, without naming the owner in the response", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedSession("s-1", "u-1");
    await seedSession("s-2", "u-1");

    const response = await call("POST", "/auth/admin/sessions/revoke", AUTH_SESSIONS_REVOKE_SCOPE, {
      sessionId: "s-1",
    });
    expect(response.status).toBe(200);
    expect(await response.json<{ revoked: number }>()).toEqual({ revoked: 1 });
    // Targeted: the person's other sign-ins keep working, which is what separates this from a logout.
    expect(await sessionCount("u-1")).toBe(1);

    const event = emitted.find((e) => e.action === "auth/admin_session_revoked");
    expect(event?.resourceId).toBe("s-1");
    expect((event?.metadata as { userId?: string } | undefined)?.userId).toBe("u-1");
  });

  test("the response tells the caller nothing about whose session it was", async () => {
    // Holding a revoke scope is not a license to read the user table, so the owner reaches the trail
    // and not the caller.
    await seedUser("u-1", "ada@example.test", 10);
    await seedSession("s-1", "u-1");
    const text = await (
      await call("POST", "/auth/admin/sessions/revoke", AUTH_SESSIONS_REVOKE_SCOPE, { sessionId: "s-1" })
    ).text();
    expect(text).not.toContain("u-1");
    expect(text).not.toContain("ada@example.test");
  });

  test("revoking a session that is already gone is a success, not a 404", async () => {
    // Idempotent, because a retried job is the normal shape of automated incident response.
    const response = await call("POST", "/auth/admin/sessions/revoke", AUTH_SESSIONS_REVOKE_SCOPE, {
      sessionId: "s-missing",
    });
    expect(response.status).toBe(200);
    expect(await response.json<{ revoked: number }>()).toEqual({ revoked: 0 });
  });

  test("a users-logout credential cannot revoke one named session", async () => {
    await seedSession("s-1", "u-1");
    await grant([AUTH_USERS_LOGOUT_SCOPE]);
    const response = await call("POST", "/auth/admin/sessions/revoke", AUTH_USERS_LOGOUT_SCOPE, { sessionId: "s-1" });
    expect(response.status).toBe(403);
    expect(await sessionCount("u-1")).toBe(1);
  });

  test("a malformed body is still refused before it is read, when the scope is wrong", async () => {
    await grant([AUTH_USERS_READ_SCOPE]);
    const response = await call("POST", "/auth/admin/sessions/revoke", AUTH_USERS_READ_SCOPE, { nonsense: true });
    expect(response.status).toBe(403);
  });

  test("and rejected as invalid input when the scope is right", async () => {
    const response = await call("POST", "/auth/admin/sessions/revoke", AUTH_SESSIONS_REVOKE_SCOPE, { nonsense: true });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });
});

describe("POST /auth/admin/users/:userId/sessions/revoke", () => {
  test("signs the user out everywhere and leaves everybody else alone", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedSession("s-1", "u-1");
    await seedSession("s-2", "u-1");
    await seedSession("s-3", "u-2");

    const response = await call("POST", "/auth/admin/users/u-1/sessions/revoke", AUTH_USERS_LOGOUT_SCOPE);
    expect(response.status).toBe(200);
    expect(await response.json<{ revoked: number }>()).toEqual({ revoked: 2 });
    expect(await sessionCount("u-1")).toBe(0);
    expect(await sessionCount("u-2")).toBe(1);

    const event = emitted.find((e) => e.action === "auth/admin_user_sessions_revoked");
    expect(event?.resourceId).toBe("u-1");
    expect(event?.actorId).toBe(SUBJECT);
  });

  test("a user with nothing to revoke is a success, not a 404", async () => {
    const response = await call("POST", "/auth/admin/users/nobody/sessions/revoke", AUTH_USERS_LOGOUT_SCOPE);
    expect(response.status).toBe(200);
    expect(await response.json<{ revoked: number }>()).toEqual({ revoked: 0 });
  });

  test("a sessions-revoke credential cannot sign a user out everywhere", async () => {
    // The blast-radius split, asserted in the direction that matters: killing one stolen token must not
    // come with the ability to sign the whole customer base out one account at a time.
    await seedSession("s-1", "u-1");
    await grant([AUTH_SESSIONS_REVOKE_SCOPE]);
    const response = await call("POST", "/auth/admin/users/u-1/sessions/revoke", AUTH_SESSIONS_REVOKE_SCOPE);
    expect(response.status).toBe(403);
    expect(await sessionCount("u-1")).toBe(1);
  });
});

describe("POST /auth/admin/users/:userId/devices/revoke", () => {
  test("signs the device's sessions out and drops its registration", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedDevice("d-1", "u-1");
    await seedSession("s-1", "u-1", "d-1");
    await seedSession("s-2", "u-1", null);

    const response = await call("POST", "/auth/admin/users/u-1/devices/revoke", AUTH_DEVICES_REVOKE_SCOPE, {
      deviceId: "d-1",
    });
    expect(response.status).toBe(200);
    expect(await response.json<{ revoked: number; removed: boolean }>()).toEqual({ revoked: 1, removed: true });
    expect(await deviceCount("u-1")).toBe(0);
    // The session not bound to that device survives — this revokes a device, not the person.
    expect(await sessionCount("u-1")).toBe(1);
  });

  test("a device id belonging to somebody else touches nothing", async () => {
    // The composite `(userId, id)` key doing its job: a client-generated device id is unique only per
    // user, so naming one under the wrong user must not reach a stranger's phone.
    await seedDevice("shared-id", "u-1");
    await seedDevice("shared-id", "u-2");
    await seedSession("s-1", "u-2", "shared-id");

    const response = await call("POST", "/auth/admin/users/u-1/devices/revoke", AUTH_DEVICES_REVOKE_SCOPE, {
      deviceId: "shared-id",
    });
    expect(await response.json<{ revoked: number; removed: boolean }>()).toEqual({ revoked: 0, removed: true });
    expect(await deviceCount("u-2")).toBe(1);
    expect(await sessionCount("u-2")).toBe(1);
  });

  test("a devices-read credential cannot revoke one", async () => {
    await seedDevice("d-1", "u-1");
    await grant([AUTH_DEVICES_READ_SCOPE]);
    const response = await call("POST", "/auth/admin/users/u-1/devices/revoke", AUTH_DEVICES_READ_SCOPE, {
      deviceId: "d-1",
    });
    expect(response.status).toBe(403);
    expect(await deviceCount("u-1")).toBe(1);
  });
});

describe("the admin surface stays outside the user surface", () => {
  test("a control-plane credential still opens nothing that requireAuth guards", async () => {
    // `controlPlaneIsolation.workers.test.ts` proves this for a probe route; this proves the admin
    // routes did not change it for auth's own user-facing ones.
    const response = await call("GET", "/auth/devices", AUTH_USERS_READ_SCOPE);
    expect(response.status).toBe(401);
  });

  test("no admin call writes a user, session, device, or account row of its own", async () => {
    // A management call is not a sign-in. If reading the admin surface created any auth row, the
    // control plane would have a footprint in the adopter's identity data — which is the property
    // issue #80 named as a definition-of-done item.
    await call("GET", "/auth/admin/users", AUTH_USERS_READ_SCOPE);
    await grant(ALL_SCOPES);
    await call("GET", "/auth/admin/devices", AUTH_DEVICES_READ_SCOPE);

    for (const table of ["pithy_auth_users", "pithy_auth_sessions", "pithy_auth_devices", "pithy_auth_accounts"]) {
      const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
  });
});

describe("the exported response schemas against the live routes", () => {
  /**
   * The binding between what a route returns and what a management client is told it returns.
   *
   * Parsing alone would not do it: a Zod object strips unknown keys, so a handler that grew a field
   * would still parse. Comparing the parsed value with the raw body fails in both directions — a field
   * the schema does not know about is dropped and shows as a difference, and a field it declares
   * wrongly fails the parse. That is what stops the two from drifting silently, and it is why the
   * dashboard can import these objects instead of hand-writing a mirror of each.
   */
  async function contract<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    scope: ControlPlaneScope,
    body?: unknown,
  ): Promise<T> {
    const response = await call(method, path, scope, body);
    expect(response.status, path).toBe(200);
    const raw = await response.json();
    expect(schema.parse(raw), path).toEqual(raw);
    await grant(ALL_SCOPES);
    return schema.parse(raw);
  }

  test("every admin route returns exactly its declared envelope", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedUser("u-2", "grace@example.test", 20);
    await seedSession("s-1", "u-1", "d-1");
    await seedDevice("d-1", "u-1");
    await db()
      .insertInto("pithyAuthAccounts")
      .values({
        id: "acct-1",
        accountId: "google-sub",
        issuer: "https://accounts.google.com",
        providerId: "google",
        userId: "u-1",
        accessToken: OAUTH_ACCESS_TOKEN,
        refreshToken: "1//refresh-must-not-leak",
        idToken: "eyJ.id.must-not-leak",
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: "openid email",
        password: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .execute();

    // A limit of one, so the paged branch is the one under test — a cursor is null on the last page,
    // and a schema proven only there says nothing about the field a client actually pages with.
    const users = await contract(AdminUsersResponse, "GET", "/auth/admin/users?limit=1", AUTH_USERS_READ_SCOPE);
    expect(users.nextCursor).not.toBeNull();

    const user = await contract(AdminUserResponse, "GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE);
    expect(user.providers).toEqual({ state: "read", items: ["google"] });
    expect(user.sessions.state === "read" && user.sessions.items).toHaveLength(1);
    expect(user.devices.state === "read" && user.devices.items).toHaveLength(1);

    await contract(AdminDevicesResponse, "GET", "/auth/admin/devices", AUTH_DEVICES_READ_SCOPE);

    await contract(AdminRevokeResponse, "POST", "/auth/admin/sessions/revoke", AUTH_SESSIONS_REVOKE_SCOPE, {
      sessionId: "s-1",
    });
    await contract(AdminRevokeResponse, "POST", "/auth/admin/users/u-1/sessions/revoke", AUTH_USERS_LOGOUT_SCOPE);
    await contract(
      AdminDeviceRevokeResponse,
      "POST",
      "/auth/admin/users/u-1/devices/revoke",
      AUTH_DEVICES_REVOKE_SCOPE,
      {
        deviceId: "d-1",
      },
    );
  });
});

/**
 * **A list that will not read costs its own pane, not the page (#380).**
 *
 * `GET /admin/users/:userId` fans out over three independent tables and used to `Promise.all` them.
 * One D1 read failing threw out of the handler and 500'd the whole request — so a support agent looking
 * at an account that is already in trouble saw nothing at all: not the user, not their sessions, not
 * the devices that did read.
 *
 * The plant is a real one: the table is dropped, so the query against it genuinely fails. Nothing here
 * stubs the handler.
 */
describe("GET /auth/admin/users/:userId — one sub-read that fails", () => {
  test("the page still renders, and the list that failed says so rather than saying none", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedSession("s-1", "u-1", null);
    await env.DB.prepare("drop table pithy_auth_devices").run();

    const response = await call("GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE);
    expect(response.status).toBe(200);
    const body = AdminUserResponse.parse(await response.json());

    expect(body.user.email).toBe("ada@example.test");
    expect(body.sessions).toEqual({ state: "read", items: [expect.objectContaining({ id: "s-1" })], truncated: false });
    expect(body.providers.state).toBe("read");
    // Not an empty array. "No registered devices" is a finding; this is nobody having looked.
    expect(body.devices).toEqual({ state: "unavailable" });
  });

  test("the unavailable list carries no reason — the query and the table stay on this side", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await env.DB.prepare("drop table pithy_auth_devices").run();

    const text = await (await call("GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE)).text();
    expect(text).not.toContain("pithy_auth_devices");
    expect(text).not.toContain("no such table");
  });

  test("the audit trail records null for the list nobody read, never zero", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await env.DB.prepare("drop table pithy_auth_devices").run();

    await call("GET", "/auth/admin/users/u-1", AUTH_USERS_READ_SCOPE);
    const event = emitted.find((candidate) => candidate.action === "auth/admin_user_read");
    expect(event?.metadata).toMatchObject({ sessions: 0, devices: null });
  });

  test("the user itself is the subject, not a contributor — a missing one is still a 404", async () => {
    // The gate must not be derived from its own subject. `getUser` stays unguarded: there is no pane to
    // degrade when the thing the pane is about does not exist.
    const response = await call("GET", "/auth/admin/users/nobody", AUTH_USERS_READ_SCOPE);
    expect(response.status).toBe(404);
  });
});
