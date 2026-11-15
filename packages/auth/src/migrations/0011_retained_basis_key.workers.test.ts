// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { rollbackThrough } from "../test-utils/rollbackThrough";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

/** The auth set as `pithy migrate` composes it, so `0011` runs where it will: last. */
function provider(): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function lifecycleColumns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_auth_user_lifecycle')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

describe("auth_0011_retained_basis_key", () => {
  beforeEach(async () => {
    for (const table of [
      "pithy_auth_accounts",
      "pithy_auth_app_attest_keys",
      "pithy_auth_attestation_challenges",
      "pithy_auth_devices",
      "pithy_auth_jwks",
      "pithy_auth_rate_limit",
      "pithy_auth_rotated_tokens",
      "pithy_auth_sessions",
      "pithy_auth_user_lifecycle",
      "pithy_auth_verification_outcomes",
      "pithy_auth_users",
      "pithy_auth_verifications",
      "pithy_migrations",
      "pithy_migrations_lock",
    ]) {
      await env.DB.prepare(`drop table if exists ${table}`).run();
    }
  });

  test("up adds a retained step's basis key, nullable, and a row carrying it round-trips", async () => {
    await runMigrations(env.DB, provider());
    expect(await lifecycleColumns()).toContain("basis_key");
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, reason, step, basis_key, created_at) values ('u1', 'purge_retained', 'system', 'Kept for tax records.', 'payments', 'payments/purge.retained', 5)",
    ).run();
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, created_at) values ('u2', 'purged', 'system', 6)",
    ).run();
    const rows = await authDatabase(env.DB).selectFrom("pithyAuthUserLifecycle").selectAll().orderBy("id").execute();
    expect(rows.map((row) => UserLifecycleEvent.parse(row).basisKey)).toEqual(["payments/purge.retained", null]);
  });

  test("down takes the column away, the history stays, and up again is clean", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, basis_key, created_at) values ('u1', 'purge_retained', 'system', 'payments/purge.retained', 1)",
    ).run();
    await rollbackThrough(env.DB, provider(), "0011_retained_basis_key");
    expect(await lifecycleColumns()).not.toContain("basis_key");
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_user_lifecycle").first<{ n: number }>();
    expect(left?.n).toBe(1);
    await runMigrations(env.DB, provider());
    expect(await lifecycleColumns()).toContain("basis_key");
  });
});
