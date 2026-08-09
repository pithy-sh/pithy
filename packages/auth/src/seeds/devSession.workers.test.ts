// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA } from "@pithy-sh/core/src/seed/exampleIdentities";
import type { D1SeedGroup, SeedSet } from "@pithy-sh/core/src/seed/seed";
import { collectSeededRows } from "@pithy-sh/core/src/seed/seededRows";
import { seedD1Group } from "@pithy-sh/core/src/seed/writeD1";
import { beforeEach, expect, test } from "vitest";
import { Session, User } from "../data/betterAuth";
import { authDatabase, authTables } from "../data/tables";
import { baseURLResolver } from "../http/baseUrl";
import { type AuthEmailMessage, makeAuth } from "../instance/auth";
import { AUTH_SESSION_SECRET } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { authDevSessionSeed, DEV_SESSION_COOKIE_NAME } from "./devSession";
import { authExampleSeed } from "./example";

const SECRET = "dev-secret-please-rotate-000000000000";

/** An adopter's real production origin — HTTPS, and the only base URL their config has ever held. */
const PRODUCTION_BASE_URL = "https://app.pithy.sh";

async function migrate(): Promise<void> {
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
}

/** Write a seed group through the same validated writer `pithy seed` uses. */
async function write(group: D1SeedGroup, schema: typeof User | typeof Session): Promise<void> {
  await seedD1Group(createDatabase(env.DB, authTables), group, schema);
}

/** Build an auth instance on the seeded database, with the same secret the seed signed with. */
function instance(secret = SECRET, baseURL = "http://localhost:8787") {
  const mailbox: AuthEmailMessage[] = [];
  return makeAuth({
    db: authDatabase(env.DB),
    secret,
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: ["http://localhost:8787"],
    sendEmail: async (message) => void mailbox.push(message),
    sessionExpiresIn: 60 * 60 * 24 * 7,
    sessionUpdateAge: 60 * 60 * 24,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    emit: async () => {},
  });
}

/** An adopter's own seed set — a real user of the app built on this kit, not one of the fictional cast. */
const APP_USER = {
  id: "app-jim",
  name: "Jim",
  email: "jim@pithy.sh",
  emailVerified: true,
  image: null,
  createdAt: new Date(1_800_000_000_000),
  updatedAt: new Date(1_800_000_000_000),
};
const appUserSeed: SeedSet = {
  name: "users",
  order: 900,
  environments: ["dev"],
  d1: [{ database: "app", table: "pithyAuthUsers", rows: [APP_USER] }],
};

/**
 * Run the seed sets the way `pithy seed` does: the user-creating sets write their rows, and the dev-session
 * set prepares against the same composed registry the CLI hands it.
 */
async function seedDevLogin(user: string, userSets: readonly SeedSet[] = [authExampleSeed, appUserSeed]) {
  for (const set of userSets) for (const group of set.d1 ?? []) await write(group, User);
  const hook = authDevSessionSeed.prepare;
  if (!hook) throw new Error("the dev-session set must declare a prepare hook");
  const prepared = await hook({
    env: "dev",
    project: "acme",
    secret: async (name) => (name === AUTH_SESSION_SECRET ? SECRET : undefined),
    preferences: { user },
    seeded: collectSeededRows(userSets),
  });
  for (const group of prepared.d1 ?? []) await write(group, Session);
  return prepared;
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
  await migrate();
});

test("Better Auth accepts the seeded cookie as a real session", async () => {
  const prepared = await seedDevLogin(EXAMPLE_ADA.email);
  const artifact = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));

  const session = await instance().api.getSession({
    headers: new Headers({ cookie: `${artifact.cookieName}=${artifact.cookieValue}` }),
  });

  expect(session?.user.email).toBe(EXAMPLE_ADA.email);
  expect(session?.user.id).toBe(EXAMPLE_ADA.id);
});

test("Better Auth accepts the seeded cookie for a user no example set creates", async () => {
  // The case that matters to an adopter: the dev login is their own user, and the fictional cast is absent.
  const prepared = await seedDevLogin(APP_USER.email, [appUserSeed]);
  const artifact = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));

  const session = await instance().api.getSession({
    headers: new Headers({ cookie: `${artifact.cookieName}=${artifact.cookieValue}` }),
  });

  expect(session?.user.email).toBe(APP_USER.email);
  expect(session?.user.id).toBe(APP_USER.id);
});

test("the cookie name matches the one this Better Auth version reads", async () => {
  const context = await instance().$context;
  expect(context.authCookies.sessionToken.name).toBe(DEV_SESSION_COOKIE_NAME);
});

/**
 * The invariant, at the seam where it used to be a comment: the name this seed writes is the name the
 * running composition reads, computed from one source rather than agreed by hand.
 *
 * The subject is the case that broke — a project whose config holds its real HTTPS production origin,
 * seeded and served in `dev`. Both sides are derived: the base URL from `baseURLResolver`, the seed's
 * name from `DEV_PROTOCOL`, and the arbiter is a live Better Auth instance's own cookie table.
 */
test("the seed and a dev composition on an HTTPS config name the same cookie", async () => {
  const resolved = baseURLResolver(PRODUCTION_BASE_URL, { ENVIRONMENT: "dev" })(
    new Request("http://localhost:41011/auth/get-session"),
  );
  const context = await instance(SECRET, resolved).$context;
  expect(context.authCookies.sessionToken.name).toBe(DEV_SESSION_COOKIE_NAME);
});

/** The other direction, so the mirror of Better Auth's prefix rule is pinned by more than its absence. */
test("the same config deployed reads the __Secure- cookie, and the seed's name is not it", async () => {
  const resolved = baseURLResolver(PRODUCTION_BASE_URL, { ENVIRONMENT: "prod" })(
    new Request("https://app.pithy.sh/auth/get-session"),
  );
  const context = await instance(SECRET, resolved).$context;
  expect(context.authCookies.sessionToken.name).toBe(`__Secure-${DEV_SESSION_COOKIE_NAME}`);
});

test("a cookie signed with the previous secret is rejected after a rotation", async () => {
  const prepared = await seedDevLogin(EXAMPLE_ADA.email);
  const artifact = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));

  const session = await instance(`${SECRET}-rotated`).api.getSession({
    headers: new Headers({ cookie: `${artifact.cookieName}=${artifact.cookieValue}` }),
  });

  expect(session).toBeNull();
});
