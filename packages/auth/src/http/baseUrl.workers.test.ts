// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA } from "@pithy-sh/core/src/seed/exampleIdentities";
import type { SeedSet } from "@pithy-sh/core/src/seed/seed";
import { collectSeededRows } from "@pithy-sh/core/src/seed/seededRows";
import { seedD1Group } from "@pithy-sh/core/src/seed/writeD1";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { auth } from "../capability";
import { Session, User } from "../data/betterAuth";
import { authTables } from "../data/tables";
import { AUTH_SESSION_SECRET, authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { authDevSessionSeed } from "../seeds/devSession";
import { authExampleSeed } from "../seeds/example";

/**
 * The invariant, end to end: **the cookie name the dev seed writes is the cookie name the running
 * composition reads.**
 *
 * The subject is a project whose `baseURL` is its real production origin — HTTPS, because production is
 * — running under `pithy dev`, where there is no TLS at all. Everything here is the real thing: the
 * capability composed the way `createBackend` composes it, the dev-session set prepared the way `pithy
 * seed` prepares it, the cookie it wrote handed to Better Auth's own `get-session`.
 *
 * It fails against a base URL that is not resolved per environment, in both halves the issue names: the
 * seeded cookie is unprefixed and Better Auth is looking for `__Secure-`, and the same-origin gate is
 * holding `https://app.pithy.sh` against a request from `http://localhost:<port>`.
 */

const SECRET = "test-secret-please-rotate-0000000000";

/** The adopter's real production origin, and the only base URL their config has ever held. */
const PRODUCTION_BASE_URL = "https://app.pithy.sh";

const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
};

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
  "pithy_migrations",
  "pithy_migrations_lock",
];

/** The worker env a request runs with: the real bindings, plus an allowing tier-1 limiter. */
function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

/**
 * Compose the capability the way `createBackend` does — middleware in order, then routes — plus one
 * route of the adopter's own behind the zero-argument same-origin gate.
 */
function compose(environment: string | undefined): Hono<PithyHonoEnv> {
  if (environment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = environment;

  const emailCapability = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  const capability = auth({ baseURL: PRODUCTION_BASE_URL });
  capability.compose?.({ capabilities: [emailCapability] });

  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  for (const middleware of capability.middleware ?? []) middleware(app);
  app.post("/organizations", requireSameOrigin(), (c) => c.text("ok"));
  capability.routes?.(app);
  return app;
}

/** Run the dev-login seed exactly as `pithy seed` does, and hand back the artifact it wrote. */
async function seedDevLogin(): Promise<DevLogin> {
  const database = createDatabase(env.DB, authTables);
  const userSets: readonly SeedSet[] = [authExampleSeed];
  for (const set of userSets) for (const group of set.d1 ?? []) await seedD1Group(database, group, User);

  const prepare = authDevSessionSeed.prepare;
  if (!prepare) throw new Error("the dev-session set must declare a prepare hook");
  const prepared = await prepare({
    env: "dev",
    project: "acme",
    // What the CLI hands a checkout with no port block, and what this set reads either way.
    origin: null,
    secret: async (name) => (name === AUTH_SESSION_SECRET ? SECRET : undefined),
    preferences: { user: EXAMPLE_ADA.email },
    seeded: collectSeededRows(userSets),
  });
  for (const group of prepared.d1 ?? []) await seedD1Group(database, group, Session);
  return DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: authSecretsRegistry });
  await seedSecrets(env, authSecretsRegistry, SECRETS);
});

afterEach(() => {
  resetSharedSecrets();
  delete process.env.ENVIRONMENT;
});

test("a dev composition with an HTTPS baseURL reads the session the dev seed wrote", async () => {
  const login = await seedDevLogin();
  const app = compose("dev");

  const response = await app.request(
    "http://localhost:9339/auth/get-session",
    { headers: { cookie: `${login.cookieName}=${login.cookieValue}` } },
    appEnv(),
  );

  expect(response.status).toBe(200);
  const session = await response.json<{ user: { email: string } } | null>();
  expect(session?.user.email).toBe(EXAMPLE_ADA.email);
});

test("the seeded cookie follows the port, whichever one this run was assigned", async () => {
  const login = await seedDevLogin();
  const app = compose("dev");

  for (const port of [9339, 41011, 8787]) {
    const response = await app.request(
      `http://localhost:${port}/auth/get-session`,
      { headers: { cookie: `${login.cookieName}=${login.cookieValue}` } },
      appEnv(),
    );
    const session = await response.json<{ user: { email: string } } | null>();
    expect(session?.user.email, `port ${port}`).toBe(EXAMPLE_ADA.email);
  }
});

test("a mutating cookie route passes the same-origin gate in dev, with nothing in trustedOrigins", async () => {
  const app = compose("dev");

  const response = await app.request(
    "http://localhost:9339/organizations",
    { method: "POST", headers: { cookie: "session=t", origin: "http://localhost:9339" } },
    appEnv(),
  );

  expect(response.status).toBe(200);
});

test("a dev composition still refuses a foreign origin", async () => {
  const app = compose("dev");

  const response = await app.request(
    "http://localhost:9339/organizations",
    { method: "POST", headers: { cookie: "session=t", origin: "https://evil.example.com" } },
    appEnv(),
  );

  expect(response.status).toBe(403);
});

test("production is untouched: the configured origin passes and the local one does not", async () => {
  const app = compose("prod");

  const allowed = await app.request(
    "https://app.pithy.sh/organizations",
    { method: "POST", headers: { cookie: "session=t", origin: PRODUCTION_BASE_URL } },
    appEnv(),
  );
  expect(allowed.status).toBe(200);

  const refused = await app.request(
    "http://localhost:9339/organizations",
    { method: "POST", headers: { cookie: "session=t", origin: "http://localhost:9339" } },
    appEnv(),
  );
  expect(refused.status).toBe(403);
});
