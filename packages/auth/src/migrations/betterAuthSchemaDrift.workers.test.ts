// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { getSchema } from "better-auth/db";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, expect, test } from "vitest";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./0001_init";
import { authSchemaOptions } from "./pluginTables";

/**
 * Every column Better Auth declares for the kit's own tables exists in `0001_init` (#451).
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
 * Better Auth's snake_case field names come from `CamelCasePlugin` on our side, so both halves are
 * compared in the database's own vocabulary.
 */

const SET = {
  database: "app",
  namespace: "auth",
  order: AUTH_MIGRATION_ORDER,
  migrations: { "0001_init": auth_0001_init },
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

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([SET]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** camelCase → snake_case, the one transformation `CamelCasePlugin` applies to an identifier. */
function snake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = await env.DB.prepare(`select name from pragma_table_info('${table}')`).all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of [...ALL_TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

test("every column better-auth declares for the kit's tables exists in 0001_init", async () => {
  await runMigrations(env.DB, provider());

  // The kit's own composition, which is what `authSchemaOptions([])` means: `bearer`, `jwt`,
  // `magic-link` and `emailOTP` — the four `kitPlugins` fixes, and no adopter plugin.
  const declared = getSchema(authSchemaOptions([]));
  expect(
    Object.keys(declared).length,
    "better-auth declared no models at all; the baseline is not being built",
  ).toBeGreaterThan(0);

  const missing: string[] = [];
  for (const [model, spec] of Object.entries(declared)) {
    const table = snake(model);
    const present = new Set(await columnsOf(table));
    // A model Better Auth declares and this migration creates no table for at all is its own failure,
    // and a louder one — report it as such rather than as eight missing columns.
    if (present.size === 0) {
      missing.push(`${table}: no such table`);
      continue;
    }
    for (const [field, definition] of Object.entries(spec.fields)) {
      const column = snake((definition as { fieldName?: string }).fieldName ?? field);
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }

  expect(
    missing,
    "better-auth declares a column 0001_init does not create — amend the migration and the Zod object in data/betterAuth.ts to match (#451)",
  ).toEqual([]);
});
