// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { auth } from "@pithy-sh/auth/src/capability";
import { authSecretsRegistry } from "@pithy-sh/auth/src/instance/secrets";
import { AUTH_MIGRATION_ORDER } from "@pithy-sh/auth/src/migrations/0001_init";
import { AUTH_MIGRATIONS } from "@pithy-sh/auth/src/migrations/set";
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
import { organization } from "../capability";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { defineRoles } from "../roles/roles";

/**
 * The acting organization survives a refresh-credential rotation, through a real `createBackend` composing auth
 * and organization: a bearer client chooses, rotates, and is still acting in what it chose on the successor.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost";
const ADDRESS = "ada@example.test";

const REGISTRY = { ...authSecretsRegistry, ...emailSigningRegistry };
const SECRETS: SecretFixture<typeof REGISTRY> = {
  "auth-session-secret": "test-secret-please-rotate-0000000000",
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
  "email-link-signing-key": "dev-link-signing-key",
};

const TABLES = [
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
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
  "pithy_migrations",
  "pithy_migrations_lock",
];

const roles = defineRoles({
  roles: {
    member: ["organization:read"],
    owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
  },
  administrativePower: "organization:manage",
});

function workerEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    ENVIRONMENT: "dev",
    EMAIL_SUPPRESSIONS: env.DB,
    EMAIL_SENDER: {},
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

function buildApp() {
  return createBackend({
    capabilities: [
      secrets({ registry: authSecretsRegistry }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: ORIGIN }),
      auth({ baseURL: ORIGIN, basePath: "/auth", trustedOrigins: [ORIGIN] }),
      organization({ roles, baseUrl: ORIGIN, sendInvitationEmail: false }),
    ],
  });
}

type App = ReturnType<typeof buildApp>;

function post(app: App, path: string, body: unknown, token?: string) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    },
    workerEnv(),
  );
}

/** Sign in by one-time code, the way a native client does, and answer the raw session token and the user. */
async function signIn(app: App): Promise<{ token: string; userId: string }> {
  expect((await post(app, "/auth/email-otp/send-verification-otp", { email: ADDRESS, type: "sign-in" })).status).toBe(
    200,
  );
  const job = await env.DB.prepare(
    "select payload from pithy_email_jobs where to_address = ? and template = 'otp' order by rowid desc limit 1",
  )
    .bind(ADDRESS)
    .first<{ payload: string }>();
  const otp = (JSON.parse(job?.payload ?? "{}") as { code?: string }).code;
  if (!otp) throw new Error("no one-time code was mailed");
  const signedIn = await post(app, "/auth/sign-in/email-otp", { email: ADDRESS, otp });
  expect(signedIn.status).toBe(200);
  const body = await signedIn.json<{ token: string; user: { id: string } }>();
  return { token: body.token, userId: body.user.id };
}

async function seatIn(userId: string): Promise<void> {
  const now = new Date();
  const db = organizationDatabase(env.DB);
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
  ] as const) {
    await db
      .insertInto(ORGANIZATIONS_TABLE)
      .values(Organization.encode({ id, name: slug, slug, logo: null, createdAt: now, updatedAt: now }))
      .execute();
    await db
      .insertInto(MEMBERSHIPS_TABLE)
      .values(Membership.encode({ id: crypto.randomUUID(), organizationId: id, userId, role: "owner", createdAt: now }))
      .execute();
  }
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: EMAIL_MIGRATION_ORDER, migrations: { "0001_init": email_0001_init } },
    {
      database: "app",
      namespace: "emailsuppressions",
      order: EMAIL_MIGRATION_ORDER + 10,
      migrations: { "0001_suppressions": email_0001_suppressions },
    },
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: ORGANIZATION_MIGRATIONS,
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  await seedSecrets(env, REGISTRY, SECRETS);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("the acting organization across a token rotation", () => {
  test("a bearer client that chose an organization is still acting in it on the rotated credential", async () => {
    const app = buildApp();
    const { token, userId } = await signIn(app);
    await seatIn(userId);

    expect((await post(app, "/organizations/acting", { organizationId: BETA }, token)).status).toBe(200);

    const rotated = await app.request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      workerEnv(),
    );
    expect(rotated.status).toBe(200);
    const { refreshToken } = await rotated.json<{ refreshToken: string }>();

    const listed = await app.request(
      "/organizations",
      { headers: { authorization: `Bearer ${refreshToken}` } },
      workerEnv(),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ acting: BETA, chosen: true });

    // One selection, on the successor. The spent session left nothing behind.
    const rows = await env.DB.prepare("select count(*) as n from pithy_organization_acting").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});
