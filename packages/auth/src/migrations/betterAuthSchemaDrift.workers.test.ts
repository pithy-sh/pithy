// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { getSchema } from "better-auth/db";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { type ActualColumn, schemaDrift } from "../test-utils/schemaDrift";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./0001_init";
import { auth_0002_session_authenticated_at } from "./0002_session_authenticated_at";
import { authSchemaOptions } from "./pluginTables";
import { AUTH_MIGRATIONS } from "./set";

/**
 * The shipped migration chain holds exactly what Better Auth writes to the kit's own tables (#451, #787).
 *
 * **This is the gate that was missing, and its absence cost a silent break.** `@pithy-sh/auth` declared
 * `better-auth: ^1.6.29` while `1.7.1` was published, so an adopter installing the package resolved a
 * version nothing here had ever run. 1.7's `jwt` plugin added `alg` and `crv` to its `jwks` model;
 * `0001_init` did not have them; and every sign-in that minted a signing key died on
 * `table pithy_auth_jwks has no column named alg` — twenty-two suites at once, none of which could say
 * why, because no test compared what Better Auth asks for against what this package creates.
 *
 * The comparison is cheap and nothing else does it. `pluginSchemaDelta` asks `getSchema` the same
 * question for an *adopter's* plugin, subtracting the kit baseline to find what to `ALTER TABLE` — so
 * the baseline itself is the one schema in this package that nothing checks. That is the schema this
 * reads.
 *
 * **It is a `pragma_table_info` read rather than a Zod comparison** because the table is what a query
 * hits. A Zod object agreeing with Better Auth while the DDL lags is exactly the failure above: `Jwks`
 * would have been right and the insert would still have thrown.
 *
 * **And the reverse, which #787 is the price of.** A `NOT NULL` column with no default that Better Auth
 * never writes breaks every insert into its table just as surely. 1.7.3 stopped writing
 * `pithy_auth_accounts.issuer`, `0001_init` still required it, and every email OTP sign-in answered 500
 * while this test, then one direction only, stayed green. `../test-utils/schemaDrift` holds both halves.
 *
 * **Then Better Auth is asked itself.** Since 1.7.3 it compares the same two things at initialization.
 * The kit turns that runtime check off, because it would run on every request (`../instance/auth.ts`),
 * so this runs it here instead, through the same instance the capability builds.
 *
 * Both run at whatever version is installed: the lockfile's in the `Tests` job, and the newest the range
 * admits in `Auth at the newest Better Auth`.
 */

const SET = {
  database: "app",
  namespace: "auth",
  order: AUTH_MIGRATION_ORDER,
  migrations: AUTH_MIGRATIONS,
} as const;

const ALL_TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

function provider(
  migrations: typeof SET.migrations | Partial<typeof SET.migrations> = SET.migrations,
): MigrationProvider {
  const registry = createMigrationRegistry([{ ...SET, migrations: migrations as typeof SET.migrations }]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** Every column of every `pithy_auth_*` table, as SQLite reports it. */
async function actualTables(): Promise<Record<string, ActualColumn[]>> {
  const tables: Record<string, ActualColumn[]> = {};
  for (const table of ALL_TABLES) {
    const rows = await env.DB.prepare(`select name, "notnull", dflt_value from pragma_table_info('${table}')`).all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    if (rows.results.length === 0) continue;
    tables[table] = rows.results.map((row) => ({
      name: row.name,
      notNull: row.notnull === 1,
      hasDefault: row.dflt_value !== null,
    }));
  }
  return tables;
}

/** The kit's own instance, over this database, as `getAuthInstance` builds it bar the request. */
function kitInstance() {
  return makeAuth({
    db: authDatabase(env.DB),
    secret: "test-secret-please-rotate-0000000000",
    baseURL: "http://localhost",
    basePath: "/auth",
    trustedOrigins: ["http://localhost"],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async () => ({ delivery: "queued" }),
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true },
    emit: async () => undefined,
    plugins: [],
  });
}

/** Better Auth's own schema check, run explicitly. Resolves when it finds nothing. */
async function betterAuthsCheck(): Promise<void> {
  const ctx = await kitInstance().$context;
  if (!ctx.explicitSchemaCheck) throw new Error("this Better Auth offers no schema check for the kysely adapter");
  await ctx.explicitSchemaCheck();
}

beforeEach(async () => {
  for (const table of [...ALL_TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("the migration chain against what Better Auth writes", () => {
  test("every column better-auth declares exists, and every column it never writes accepts its absence", async () => {
    await runMigrations(env.DB, provider());

    // The kit's own composition, which is what `authSchemaOptions([])` means: `bearer`, `jwt`,
    // `magic-link` and `emailOTP` — the four `kitPlugins` fixes, and no adopter plugin.
    const declared = getSchema(authSchemaOptions([]));
    expect(
      Object.keys(declared).length,
      "better-auth declared no models at all; the baseline is not being built",
    ).toBeGreaterThan(0);

    expect(
      schemaDrift(declared, await actualTables()),
      "the auth tables and better-auth disagree — add a migration, and match the Zod object in data/betterAuth.ts (#451, #787)",
    ).toEqual([]);
  });

  test("the chain before 0003 is the drift #787 shipped, and the reverse half names it", async () => {
    // The gate has to be able to fail. This is the schema every Worker held on 1.7.1, read at the version
    // installed now, and the one finding is the column that broke sign-in.
    await runMigrations(
      env.DB,
      provider({ "0001_init": auth_0001_init, "0002_session_authenticated_at": auth_0002_session_authenticated_at }),
    );
    expect(schemaDrift(getSchema(authSchemaOptions([])), await actualTables())).toEqual([
      "pithy_auth_accounts.issuer: required, and Better Auth never writes it",
    ]);
  });

  test("Better Auth's own initialization check finds no mismatch on the kit's tables", async () => {
    await runMigrations(env.DB, provider());
    await expect(betterAuthsCheck()).resolves.toBeUndefined();
  });

  test("Better Auth's own check refuses the chain before 0003, naming issuer", async () => {
    await runMigrations(
      env.DB,
      provider({ "0001_init": auth_0001_init, "0002_session_authenticated_at": auth_0002_session_authenticated_at }),
    );
    await expect(betterAuthsCheck()).rejects.toThrow(/pithy_auth_accounts\.issuer/);
  });
});
