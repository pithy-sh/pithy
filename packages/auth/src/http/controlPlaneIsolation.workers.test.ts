// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CONTROLPLANE_MIGRATION_ORDER, controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/http/verify";
import { controlplane_0001_connections } from "@pithy-sh/core/src/controlPlane/migrations/0001_connections";
import {
  ANY_VERIFIED_CALLER,
  KEYS_ROTATE_SCOPE,
  MANIFEST_READ_SCOPE,
} from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { EMAIL_MIGRATION_ORDER, email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auth } from "../capability";
import { authDatabase } from "../data/tables";
import { makeAuth } from "../instance/auth";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { requireAuth } from "./middleware";

/**
 * The isolation proof: a control-plane call touches nothing auth owns, and an auth credential opens
 * nothing the control plane guards.
 *
 * Issue #80 names this as a definition-of-done item because it is the property most likely to regress
 * silently. Every check below would still pass if the seam merely *happened* not to write a row today;
 * what makes them a guard rather than a coincidence is the structural fact each one pins:
 *
 *   - The seam presents its credential on `pithy-control-plane`, and `createSessionMiddleware` only
 *     acts when a request carries `authorization` or `cookie`. So on a control-plane call the session
 *     middleware short-circuits, `getAuthInstance` is never called, no Better Auth instance is ever
 *     built, and nothing reaches the auth tables. Move the seam onto `Authorization` and every
 *     management call starts constructing Better Auth against D1 — which is what test 4 forbids.
 *   - `ControlPlaneContext` lives on its own request variable. If a control-plane call ever set
 *     `c.var.auth`, every `requireAuth()` in every capability would pass for a management client —
 *     one scope escalation across the whole tree. Tests 2 and 3 are the two directions of that.
 *
 * Everything here runs against real D1 in the Workers pool, over a real `createBackend` composing
 * `auth()` and `controlplane()` together, with tokens signed by `mintControlPlaneToken`. No fixtures:
 * a fixture token would prove the assertion and not the seam.
 */

const SECRET = "test-secret-please-rotate-0000000000";

/** The environment this Worker and the registered connection both claim. Not a `ManagedEnvironment`, so secrets resolve from injected dev values. */
const ENVIRONMENT = "dev";

/** Every table auth (and its email delivery side) owns. A control-plane call must leave all of them empty. */
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

/** Dev-mode secret values, keyed by secret name — the whole aggregated registry, since dev resolves it in one batch. */
const SECRET_ENV: Record<string, string> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": JSON.stringify({ clientId: "g", clientSecret: "g" }),
  "auth-apple-credentials": JSON.stringify({ clientId: "a", clientSecret: "a" }),
  "auth-facebook-credentials": JSON.stringify({ clientId: "f", clientSecret: "f" }),
  "auth-github-credentials": JSON.stringify({ clientId: "h", clientSecret: "h" }),
  "email-link-signing-key": "dev-link-signing-key",
};

const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ISSUER = "https://app.pithy.sh";
const KEY_ID = "cpk_isolation_1";
const SUBJECT = "ops@dashboard.test";

/**
 * A minimal in-memory KV namespace for the seam's replay set. The auth package's Workers pool binds D1
 * only, and this test may not change that config — so the one binding the control-plane capability
 * derives is supplied per request. `TypedKv` reads and writes text, which is all this answers.
 */
interface MemoryKv {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
}

function memoryKv(): MemoryKv {
  const entries = new Map<string, string>();
  return {
    get: async (name) => entries.get(name) ?? null,
    put: async (name, value) => {
      entries.set(name, value);
    },
  };
}

/**
 * The Worker env one test's requests share. `SECRETS`/`EMAIL_SUPPRESSIONS` point at the same D1 only to
 * satisfy the binding check — nothing in these tests reads either, because dev-mode secrets resolve
 * from the injected values above and no email is ever sent.
 */
function workerEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    ...SECRET_ENV,
    ENVIRONMENT,
    SECRETS: env.DB,
    EMAIL_SUPPRESSIONS: env.DB,
    EMAIL_SENDER: {},
    SECRETS_ENCRYPTION_KEYS: "unused-in-dev",
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    CONTROL_PLANE: memoryKv(),
  };
}

/** What a probe route reports back — the two request variables, and the two headers auth watches for. */
interface Probe {
  authIsNull: boolean;
  controlPlaneIsNull: boolean;
  authorization: string | null;
  cookie: string | null;
}

/**
 * Two probe routes on the app capability, one behind each gate. They exist to read the request
 * variables from inside a real, fully-composed request — the seam's own handlers report their own
 * context, which would prove nothing about the *other* seam's.
 */
const probeCapability = defineCapability({
  name: "probe",
  requiredBindings: [],
  routes: (app) => {
    app.get("/probe/control-plane", requireControlPlane(ANY_VERIFIED_CALLER), (c) =>
      c.json<Probe>({
        authIsNull: c.var.auth === null,
        controlPlaneIsNull: c.var.controlPlane === null,
        authorization: c.req.header("authorization") ?? null,
        cookie: c.req.header("cookie") ?? null,
      }),
    );
    app.get("/probe/auth", requireAuth(), (c) =>
      c.json<Probe>({
        authIsNull: c.var.auth === null,
        controlPlaneIsNull: c.var.controlPlane === null,
        authorization: c.req.header("authorization") ?? null,
        cookie: c.req.header("cookie") ?? null,
      }),
    );
  },
});

/** One backend composing both seams — the arrangement the property is actually about. */
function buildApp() {
  return createBackend({
    capabilities: [
      secrets({ registry: authSecretsRegistry }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" }),
      auth({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
      controlplane(),
    ],
    app: probeCapability,
  });
}

let signingKey: CryptoKey;

/** Register the one connection every call below authenticates against. */
async function registerConnection(publicKey: Ed25519PublicJwk): Promise<void> {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: "https://worker.example.test",
        scopes: [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE],
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

/** A real, freshly signed control-plane credential. One token, one scope, one call. */
function credential(scope: string = MANIFEST_READ_SCOPE): Promise<string> {
  return mintControlPlaneToken({
    privateKey: signingKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope,
  });
}

/** Sign a user in via OTP directly (no HTTP, no email) and return a usable session token. */
async function signIn(): Promise<{ token: string; userId: string }> {
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
    emit: async () => {},
  });
  await instance.api.sendVerificationOTP({ body: { email: "u@test.com", type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((m) => m.template === "otp");
  if (!otp?.code) throw new Error("no OTP");
  const signedIn = await instance.api.signInEmailOTP({
    body: { email: "u@test.com", otp: otp.code },
    headers: new Headers(),
  });
  return { token: signedIn.token, userId: signedIn.user.id };
}

/** Row counts straight from SQLite: `CamelCasePlugin` is a Kysely concern, so the physical names are what we query. */
async function rowCounts(tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every auth table at zero — the expected shape, written out so a failure names the table that grew. */
function allEmpty(tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(tables.map((table) => [table, 0]));
}

beforeEach(async () => {
  for (const table of [...AUTH_TABLES, "pithy_controlplane_connections", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
    { database: "app", namespace: "email", order: EMAIL_MIGRATION_ORDER, migrations: { "0001_init": email_0001_init } },
    {
      database: "app",
      namespace: "controlplane",
      order: CONTROLPLANE_MIGRATION_ORDER,
      migrations: { "0001_connections": controlplane_0001_connections },
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);

  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  await registerConnection(await exportPublicJwk(pair.publicKey));
});

afterEach(() => {
  resetSharedSecrets();
});

describe("control-plane and auth isolation", () => {
  test("a verified control-plane call creates no Better Auth user, session, or any other auth row", async () => {
    // The named definition-of-done item. A management client is not a user of the adopter's app, so a
    // successful management call must leave the adopter's identity tables byte-for-byte untouched.
    const app = buildApp();
    const before = await rowCounts(AUTH_TABLES);
    expect(before).toEqual(allEmpty(AUTH_TABLES));

    const res = await app.request(
      "/control-plane/ping",
      { headers: { [CONTROL_PLANE_HEADER]: await credential() } },
      workerEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json<{ connectionId: string; keyId: string }>()).toMatchObject({
      connectionId: CONNECTION_ID,
      keyId: KEY_ID,
    });

    expect(await rowCounts(AUTH_TABLES)).toEqual(allEmpty(AUTH_TABLES));
  });

  test("a verified control-plane call never populates c.var.auth", async () => {
    // The scope-escalation defence. `requireAuth()` reads exactly this variable, so if the seam ever
    // filled it, one management credential would satisfy every authenticated route in every composed
    // capability. Its own variable is what makes that impossible rather than merely unlikely.
    const app = buildApp();
    const res = await app.request(
      "/probe/control-plane",
      { headers: { [CONTROL_PLANE_HEADER]: await credential() } },
      workerEnv(),
    );

    expect(res.status).toBe(200);
    const probe = await res.json<Probe>();
    expect(probe.authIsNull).toBe(true);
    expect(probe.controlPlaneIsNull).toBe(false);
  });

  test("a valid control-plane credential does not open an ordinary requireAuth route", async () => {
    // The converse, and the direction an attacker would take: a management credential presented at a
    // user-facing route is simply not a credential there. 401, from `requireAuth` seeing a null context.
    const app = buildApp();
    const res = await app.request(
      "/probe/auth",
      { headers: { [CONTROL_PLANE_HEADER]: await credential() } },
      workerEnv(),
    );

    expect(res.status).toBe(401);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("auth/invalid_token");
  });

  test("a control-plane request carries neither an authorization header nor a cookie", async () => {
    // The structural reason the three assertions above hold, pinned so a future change cannot quietly
    // remove it. `createSessionMiddleware` runs its body only when the request has `authorization` or
    // `cookie`; the seam presents its token on `pithy-control-plane`, which is neither. So on a
    // management call the middleware short-circuits before `getAuthInstance`, no Better Auth instance
    // is constructed, and no auth table is read or written — which is *why* they stay empty, rather
    // than a happy accident of what the handlers do today.
    //
    // Moving the seam onto `Authorization` would fail this test first, and it is the change that would
    // make every management call build Better Auth against D1 on the way past.
    expect(CONTROL_PLANE_HEADER).not.toBe("authorization");
    expect(CONTROL_PLANE_HEADER).not.toBe("cookie");

    const app = buildApp();
    const res = await app.request(
      "/probe/control-plane",
      { headers: { [CONTROL_PLANE_HEADER]: await credential() } },
      workerEnv(),
    );

    expect(res.status).toBe(200);
    const probe = await res.json<Probe>();
    expect(probe.authorization).toBeNull();
    expect(probe.cookie).toBeNull();
  });

  test("an authenticated session request leaves c.var.controlPlane null", async () => {
    // The inverse isolation. A signed-in user's bearer token fills `c.var.auth` and nothing else — it
    // is not a management credential, and no amount of it becomes one.
    const { token, userId } = await signIn();
    const app = buildApp();

    const res = await app.request("/probe/auth", { headers: { authorization: `Bearer ${token}` } }, workerEnv());

    expect(res.status).toBe(200);
    const probe = await res.json<Probe>();
    expect(probe.authIsNull).toBe(false);
    expect(probe.controlPlaneIsNull).toBe(true);
    expect(userId).toBeTruthy();
  });
});
