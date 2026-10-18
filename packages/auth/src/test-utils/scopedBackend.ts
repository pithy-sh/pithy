// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { EMAIL_MIGRATION_ORDER } from "@pithy-sh/email/src/capability";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import type { Migration } from "kysely/migration";
import { authDatabase } from "../data/tables";
import { makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";

/**
 * The fixtures a workers suite needs to put a **real** `auth()` in front of a request (#560).
 *
 * The scope gates in `leaderboard`, `rating` and `ledger` were each tested against a stub middleware that
 * wrote `c.var.auth` itself, so every one of them passed while nothing real could ever open it. A suite
 * built on this composes the actual capability through `createBackend` and signs a user in with the actual
 * Better Auth instance, so what reaches a gate is what a deployed Worker would put there.
 *
 * It holds the pieces and not the composition. Which capabilities sit beside auth is the suite's own
 * statement, and so is the probe it reads the request through.
 */

/** The session secret these suites sign with. A throwaway: it authenticates nothing anywhere. */
export const SCOPED_SESSION_SECRET = "scoped-backend-secret-please-rotate-000";

/** The origin the composed auth serves on, and the audience a caller token is minted for. */
export const SCOPED_ORIGIN = "http://localhost";

/** Auth's registry and the email link key, which every composition with `email()` resolves. */
export const SCOPED_REGISTRY = { ...authSecretsRegistry, ...emailSigningRegistry };

/** Every secret the composed backend resolves, since the shared accessor resolves the registry in one batch. */
export const SCOPED_SECRETS: SecretFixture<typeof SCOPED_REGISTRY> = {
  "auth-session-secret": SCOPED_SESSION_SECRET,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
  "email-link-signing-key": "dev-link-signing-key",
};

/** One capability's migrations, as the registry takes them, for a suite composing more than auth. */
export interface ExtraMigrations {
  namespace: string;
  order: number;
  migrations: Record<string, Migration>;
}

/**
 * Drop every table, re-run every migration the composition needs, then seed the secrets it resolves.
 *
 * Every table rather than a list of them, so a suite composing a capability beside auth does not have to
 * restate what that capability's migrations create, and a second test never meets the first one's rows.
 */
export async function prepareScopedBackend(
  env: SecretsStoreEnv & { DB: D1Database },
  extra: readonly ExtraMigrations[] = [],
): Promise<void> {
  const tables = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_cf\\_%' escape '\\'",
  ).all<{ name: string }>();
  for (const { name } of tables.results) await env.DB.prepare(`drop table if exists "${name}"`).run();
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: EMAIL_MIGRATION_ORDER, migrations: { "0001_init": email_0001_init } },
    ...extra.map((entry) => ({ database: "app", ...entry })),
  ]).app;
  if (!provider) throw new Error('expected a migration provider for database "app"');
  await runMigrations(env.DB, provider);
  await seedSecrets(env, SCOPED_REGISTRY, SCOPED_SECRETS);
}

/**
 * The Worker env one request runs against: the real `DB` and `SECRETS`, and stand-ins for the three
 * bindings this composition requires and never exercises — no email is sent and the limiter always allows.
 */
export function scopedWorkerEnv(env: Record<string, unknown>, db: unknown = env.DB): Record<string, unknown> {
  return {
    ...env,
    DB: db,
    ENVIRONMENT: "dev",
    EMAIL_SUPPRESSIONS: env.DB,
    EMAIL_SENDER: {},
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

/**
 * Sign a user in by OTP against the same database the composed backend reads, and return a bearer token.
 *
 * Directly through Better Auth rather than over HTTP: the sign-in flow is not what these suites are about,
 * and the session row it writes is exactly the one a request presenting the token resolves.
 */
export async function signInScoped(
  db: D1Database,
  address = "player@test.com",
): Promise<{ token: string; userId: string }> {
  const mailbox: { template: string; code?: string }[] = [];
  const instance = makeAuth({
    db: authDatabase(db),
    secret: SCOPED_SESSION_SECRET,
    baseURL: SCOPED_ORIGIN,
    basePath: "/auth",
    trustedOrigins: [SCOPED_ORIGIN],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (m) => {
      mailbox.push(m.template === "otp" ? { template: "otp", code: m.code } : { template: m.template });
      return { delivery: "queued" };
    },
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true },
    emit: async () => {},
    plugins: [],
  });
  await instance.api.sendVerificationOTP({ body: { email: address, type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((m) => m.template === "otp");
  if (!otp?.code) throw new Error("no OTP was mailed");
  const signedIn = await instance.api.signInEmailOTP({
    body: { email: address, otp: otp.code },
    headers: new Headers(),
  });
  return { token: signedIn.token, userId: signedIn.user.id };
}
