// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { VerificationOutcome } from "../data/verificationOutcome";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

/** The auth set as `pithy migrate` composes it, so `0006` runs where it will: last. */
function provider(): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const TABLE = "pithy_auth_verification_outcomes";

async function columns(): Promise<{ name: string; type: string; notnull: number }[]> {
  const rows = await env.DB.prepare(`select name, type, "notnull" from pragma_table_info('${TABLE}')`).all<{
    name: string;
    type: string;
    notnull: number;
  }>();
  return rows.results;
}

async function tableExists(table: string): Promise<boolean> {
  const row = await env.DB.prepare("select name from sqlite_master where type = 'table' and name = ?")
    .bind(table)
    .first<{ name: string }>();
  return row !== null;
}

describe("auth_0006_verification_outcomes", () => {
  beforeEach(async () => {
    for (const table of [
      "pithy_auth_accounts",
      "pithy_auth_devices",
      "pithy_auth_jwks",
      "pithy_auth_rate_limit",
      "pithy_auth_rotated_tokens",
      "pithy_auth_sessions",
      "pithy_auth_user_lifecycle",
      "pithy_auth_users",
      "pithy_auth_verification_outcomes",
      "pithy_auth_verifications",
      "pithy_migrations",
      "pithy_migrations_lock",
    ]) {
      await env.DB.prepare(`drop table if exists ${table}`).run();
    }
  });

  test("up creates the ledger: dates as integers, the user, job and use nullable", async () => {
    await runMigrations(env.DB, provider());
    const found = await columns();
    const column = (name: string) => found.find((row) => row.name === name);
    expect(found.map((row) => row.name).sort()).toEqual([
      "email_job_id",
      "expires_at",
      "id",
      "issued_at",
      "type",
      "used_at",
      "user_id",
      "verification_id",
    ]);
    for (const name of ["issued_at", "expires_at", "used_at"]) expect(column(name)?.type.toLowerCase()).toBe("integer");
    for (const name of ["user_id", "email_job_id", "used_at"]) expect(column(name)?.notnull, name).toBe(0);
    for (const name of ["verification_id", "type", "issued_at", "expires_at"])
      expect(column(name)?.notnull, name).toBe(1);
  });

  test("up indexes the window, the verification and the user", async () => {
    await runMigrations(env.DB, provider());
    const rows = await env.DB.prepare("select name from sqlite_master where type = 'index' and tbl_name = ?")
      .bind(TABLE)
      .all<{ name: string }>();
    expect(rows.results.map((row) => row.name).sort()).toEqual(
      [
        "pithy_auth_verification_outcomes_issued_at_idx",
        "pithy_auth_verification_outcomes_user_id_idx",
        "pithy_auth_verification_outcomes_verification_id_idx",
      ].sort(),
    );
  });

  test("a row round-trips through its schema", async () => {
    await runMigrations(env.DB, provider());
    const db = authDatabase(env.DB);
    const issuedAt = new Date("2026-10-26T12:00:00.000Z");
    const expiresAt = new Date("2026-10-26T12:05:00.000Z");
    const value = {
      verificationId: "v-1",
      type: "otp" as const,
      userId: null,
      emailJobId: "job-1",
      issuedAt,
      expiresAt,
      usedAt: null,
    };
    const { id: _omit, ...record } = VerificationOutcome.encode({ id: 0, ...value });
    await db.insertInto("pithyAuthVerificationOutcomes").values(record).execute();
    const row = await db.selectFrom("pithyAuthVerificationOutcomes").selectAll().executeTakeFirstOrThrow();
    expect(VerificationOutcome.parse(row)).toEqual({ id: row.id, ...value });
  });

  test("down drops the table, leaving everything before it intact", async () => {
    await runMigrations(env.DB, provider());
    // `0008` and `0007` sit above it in the chain, so they come down first.
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    expect(await tableExists(TABLE)).toBe(false);
    expect(await tableExists("pithy_auth_users")).toBe(true);
    expect(await tableExists("pithy_auth_user_lifecycle")).toBe(true);
  });

  test("down, then up again, is clean — the inverse is exact", async () => {
    await runMigrations(env.DB, provider());
    // `0008` and `0007` sit above it in the chain, so they come down first.
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await runMigrations(env.DB, provider());
    expect(await tableExists(TABLE)).toBe(true);
  });
});
