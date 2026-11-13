// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { rollbackThrough } from "../test-utils/rollbackThrough";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

function provider(): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tables(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from sqlite_master where type in ('table', 'index')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

describe("auth_0009_attestation_challenges", () => {
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

  test("up creates the challenge table and its expiry index", async () => {
    await runMigrations(env.DB, provider());
    const names = await tables();
    expect(names).toContain("pithy_auth_attestation_challenges");
    expect(names).toContain("pithy_auth_attestation_challenges_expires_at_idx");
  });

  test("down takes both away, and up again is clean", async () => {
    await runMigrations(env.DB, provider());
    await rollbackThrough(env.DB, provider(), "0009_attestation_challenges");
    const names = await tables();
    expect(names).not.toContain("pithy_auth_attestation_challenges");
    expect(names).not.toContain("pithy_auth_attestation_challenges_expires_at_idx");
    await runMigrations(env.DB, provider());
    expect(await tables()).toContain("pithy_auth_attestation_challenges");
  });
});
