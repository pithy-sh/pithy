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
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { AUTH_SESSION_SECRET } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { authDevSessionSeed, DEV_SESSION_COOKIE_NAME, verifyDevLoginClaim } from "./devSession";
import { authExampleSeed } from "./example";

const SECRET = "dev-secret-please-rotate-000000000000";

/** An adopter's real production origin — HTTPS, and the only base URL their config has ever held. */
const PRODUCTION_BASE_URL = "https://app.pithy.sh";

async function migrate(): Promise<void> {
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
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
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (message) => void mailbox.push(message),
    sessionExpiresIn: 60 * 60 * 24 * 7,
    sessionUpdateAge: 60 * 60 * 24,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true },
    emit: async () => {},
    plugins: [],
  });
}

/** An adopter's own seed set — a real user of the app built on this kit, not one of the fictional cast. */
const APP_USER = {
  id: "app-jim",
  name: "Jim",
  email: "jim@pithy.sh",
  emailVerified: true,
  image: null,
  locale: null,
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
    // What the CLI hands a checkout with no port block, and what this set reads either way.
    origin: null,
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

test("the seeded claim names the user it was minted for", async () => {
  // **This asserted that the artifact's cookie signed you in, and there is no cookie in it any more —
  // `#572`.** The artifact carries a claim about *who*; the route is what turns one into a session, and
  // `http/devLoginRoute.workers.test.ts` is where that end-to-end assertion lives now. What is this
  // file's to prove is that the seed signs a claim the running secret verifies, naming the right person.
  const prepared = await seedDevLogin(EXAMPLE_ADA.email);
  const artifact = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));

  expect(artifact.email).toBe(EXAMPLE_ADA.email);
  expect(await verifyDevLoginClaim(artifact.claim, SECRET)).toEqual({
    userId: EXAMPLE_ADA.id,
    expiresAt: artifact.expiresAt,
  });
});

test("the seeded claim names a user no example set creates", async () => {
  // The case that matters to an adopter: the dev login is their own user, and the fictional cast is absent.
  const prepared = await seedDevLogin(APP_USER.email, [appUserSeed]);
  const artifact = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));

  expect(artifact.email).toBe(APP_USER.email);
  expect(await verifyDevLoginClaim(artifact.claim, SECRET)).toEqual({
    userId: APP_USER.id,
    expiresAt: artifact.expiresAt,
  });
});

test("**the seed writes no session — nothing is in that table until somebody signs in**", async () => {
  // The whole of `#572` in one assertion. A row here was what the product's own sign-out revoked, and
  // what every surface built over `pithy_auth_sessions` drew as a device nobody used.
  await seedDevLogin(EXAMPLE_ADA.email);

  const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
  expect(sessions?.n).toBe(0);
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

test("a claim signed with the previous secret is refused after a rotation", async () => {
  // Rotating the signing secret invalidates the claim, and reseeding is what mints a fresh one. That is
  // the cost `#572` accepted deliberately: surviving a rotation would have meant a durable marker, and a
  // marker means a table in every adopter's production schema for a `dev`-only affordance.
  const prepared = await seedDevLogin(EXAMPLE_ADA.email);
  const artifact = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));

  expect(await verifyDevLoginClaim(artifact.claim, SECRET)).not.toBeNull();
  expect(await verifyDevLoginClaim(artifact.claim, `${SECRET}-rotated`)).toBeNull();
});
