// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import { seedD1Group } from "@pithy-sh/core/src/seed/writeD1";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { Session, User } from "../data/betterAuth";
import { authDatabase, authTables } from "../data/tables";
import { type AuthEmailMessage, makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { mintDevSession } from "../seeds/devSession";
import { registerDevLoginRoute } from "./devLoginRoute";

const SECRET = "test-secret-please-rotate-0000000000";

const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
};

const ADA = {
  id: "example-ada",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date(1_800_000_000_000),
  updatedAt: new Date(1_800_000_000_000),
};

function wiring(): AuthWiring {
  return {
    config: AuthConfig.parse({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
    enqueueEmail: undefined,
    turnstile: undefined,
  };
}

/** A dev composition: the one ambient environment that mounts this route at all. */
function devApp(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  registerDevLoginRoute(wiring(), { ENVIRONMENT: "dev" })(app);
  return app;
}

/** Better Auth on the same database and secret, to answer the only question that matters: am I signed in? */
function instance(secret = SECRET) {
  const mailbox: AuthEmailMessage[] = [];
  return makeAuth({
    db: authDatabase(env.DB),
    secret,
    baseURL: "http://localhost",
    basePath: "/auth",
    trustedOrigins: ["http://localhost"],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (message) => void mailbox.push(message),
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    emit: async () => {},
    plugins: [],
  });
}

/** Write the user and one minted dev session, through the same validated writer `pithy seed` uses. */
async function seedDevSession(secret = SECRET, now = new Date()): Promise<void> {
  const db = createDatabase(env.DB, authTables);
  await seedD1Group(db, { database: "app", table: "pithyAuthUsers", rows: [ADA] }, User);
  const minted = await mintDevSession({ user: { id: ADA.id, email: ADA.email }, secret, now });
  await seedD1Group(db, { database: "app", table: "pithyAuthSessions", rows: [minted.session] }, Session);
}

beforeEach(async () => {
  for (const table of [
    "pithy_auth_accounts",
    "pithy_auth_devices",
    "pithy_auth_jwks",
    "pithy_auth_rate_limit",
    "pithy_auth_rotated_tokens",
    "pithy_auth_sessions",
    "pithy_auth_users",
    "pithy_auth_verifications",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: authSecretsRegistry });
  await seedSecrets(env, authSecretsRegistry, SECRETS);
});

afterEach(() => {
  resetSharedSecrets();
});

test("redirects to the app root with a cookie Better Auth accepts as a real session", async () => {
  await seedDevSession();

  const response = await devApp().request(DEV_LOGIN_ROUTE, {}, env);

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/");
  const setCookie = response.headers.get("Set-Cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Path=/");
  // Local dev is `http://localhost`; a `Secure` cookie there is accepted and never sent back.
  expect(setCookie).not.toContain("Secure");

  const cookie = setCookie.split(";")[0] ?? "";
  const session = await instance().api.getSession({ headers: new Headers({ cookie }) });
  expect(session?.user.email).toBe(ADA.email);
});

test("the cookie value is never in the body — the browser is the only place it lands", async () => {
  await seedDevSession();

  const response = await devApp().request(DEV_LOGIN_ROUTE, {}, env);
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  const value = setCookie.split(";")[0]?.split("=")[1] ?? "";

  expect(value.length).toBeGreaterThan(0);
  expect(await response.text()).not.toContain(value);
});

test("says there is nothing seeded, and names the command that seeds one", async () => {
  const response = await devApp().request(DEV_LOGIN_ROUTE, {}, env);

  expect(response.status).toBe(404);
  const body = (await response.json()) as { error?: { message?: string; action?: string } };
  expect(body.error?.message).toContain("No dev login has been seeded");
  // In `message`. `action` is the operator's field and never crosses the wire (#344) — this route's
  // caller happens to be the operator, so the command is said where the caller can read it.
  expect(body.error?.message).toContain("pithy seed");
  expect(body.error?.action).toBeUndefined();
  expect(response.headers.get("Set-Cookie")).toBeNull();
});

test("a session minted before a secret rotation is not offered — it would sign nobody in", async () => {
  // The row is still there; the fingerprint in its token no longer matches the running secret, so
  // handing it over would set a cookie Better Auth rejects and send someone hunting through auth.
  await seedDevSession(`${SECRET}-previous`);

  const response = await devApp().request(DEV_LOGIN_ROUTE, {}, env);

  expect(response.status).toBe(404);
  expect(response.headers.get("Set-Cookie")).toBeNull();
});

test("an expired seeded session is refused rather than handed over as a dead cookie", async () => {
  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000 - 1000);
  await seedDevSession(SECRET, twoYearsAgo);

  const response = await devApp().request(DEV_LOGIN_ROUTE, {}, env);

  expect(response.status).toBe(404);
  expect(response.headers.get("Set-Cookie")).toBeNull();
});

test("no route means no handler: a staging composition 404s with nothing mounted", async () => {
  await seedDevSession();
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  registerDevLoginRoute(wiring(), { ENVIRONMENT: "staging" })(app);

  const response = await app.request(DEV_LOGIN_ROUTE, {}, env);

  expect(response.status).toBe(404);
  expect(response.headers.get("Set-Cookie")).toBeNull();
});
