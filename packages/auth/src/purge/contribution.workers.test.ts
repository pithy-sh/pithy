// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { twoFactor } from "better-auth/plugins/two-factor";
import { beforeEach, describe, expect, test } from "vitest";
import { AuthUserExport } from "../http/responses";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { authPluginPlan } from "../migrations/pluginTables";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { footprintCounts, seedAccountFootprint } from "../test-utils/accountFootprint";
import { AUTH_PURGE_SUMMARY, authPurgeContribution } from "./contribution";

/**
 * Auth's own purge contribution against real D1 (#622): every `pithy_auth_*` row keyed to the account goes,
 * its history stays, somebody else's rows are untouched, and a second run succeeds having found nothing.
 */

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_user_lifecycle",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "two_factor",
];

const SUBJECT = { type: "user", id: "u1" } as const;
const ENV = env as unknown as Record<string, unknown>;

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("auth's purge contribution", () => {
  const contribution = authPurgeContribution("DB");

  test("says what it erases, in the sentence the purge records", () => {
    expect(contribution.subject).toBe("user");
    expect(contribution.summary).toBe(AUTH_PURGE_SUMMARY);
  });

  test("erases every pithy_auth_* row keyed to the account and leaves its history", async () => {
    await seedAccountFootprint(env.DB, "u1");
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, created_at) values ('u1', 'deleted', 'control-plane', 1)",
    ).run();
    await contribution.erase({ subject: SUBJECT, env: ENV });
    expect(await footprintCounts(env.DB, "u1")).toEqual({
      pithy_auth_users: 0,
      pithy_auth_sessions: 0,
      pithy_auth_accounts: 0,
      pithy_auth_devices: 0,
      pithy_auth_rotated_tokens: 0,
      pithy_auth_verifications: 0,
      pithy_auth_user_lifecycle: 1,
    });
  });

  test("leaves every other account's rows exactly where they were, an address that contains this one included", async () => {
    await seedAccountFootprint(env.DB, "u1", "sam@test.com");
    // An address that ends with the subject's, and one with a wildcard where the subject's has a letter: a
    // LIKE that was not anchored and escaped would take either.
    await seedAccountFootprint(env.DB, "u2", "xsam@test.com");
    await seedAccountFootprint(env.DB, "u3", "sam@test_com");
    await contribution.erase({ subject: SUBJECT, env: ENV });
    for (const [id, email] of [
      ["u2", "xsam@test.com"],
      ["u3", "sam@test_com"],
    ] as const) {
      const counts = await footprintCounts(env.DB, id, email);
      expect(counts.pithy_auth_users, id).toBe(1);
      expect(counts.pithy_auth_sessions, id).toBe(1);
      expect(counts.pithy_auth_verifications, id).toBe(2);
    }
  });

  test("a second run finds nothing and succeeds — the contract's idempotency", async () => {
    await seedAccountFootprint(env.DB, "u1");
    await contribution.erase({ subject: SUBJECT, env: ENV });
    await expect(contribution.erase({ subject: SUBJECT, env: ENV })).resolves.toBeUndefined();
    await expect(contribution.erase({ subject: { type: "user", id: "never" }, env: ENV })).resolves.toBeUndefined();
  });

  test("a missing binding is a wiring fault that fails the step, never a silent success", async () => {
    await expect(authPurgeContribution("NOT_BOUND").erase({ subject: SUBJECT, env: ENV })).rejects.toBeInstanceOf(
      PithyError,
    );
  });

  test("exports the account with its sessions, providers, devices and history, and no credential", async () => {
    await seedAccountFootprint(env.DB, "u1");
    const exported = await contribution.export?.({ subject: SUBJECT, env: ENV });
    const parsed = AuthUserExport.parse(exported);
    expect(parsed.user).toMatchObject({ id: "u1", email: "u1@test.com", deletedAt: null });
    expect(parsed.sessions.map((session) => session.id)).toEqual(["s-u1"]);
    expect(parsed.providers.map((provider) => provider.providerId)).toEqual(["google"]);
    expect(parsed.devices.map((device) => device.id)).toEqual(["d-u1"]);
    const wire = JSON.stringify(exported);
    for (const credential of ["token-u1", "access-u1", "refresh-u1", "push-u1"]) {
      expect(wire).not.toContain(credential);
    }
  });

  test("an account that is not there exports nothing", async () => {
    expect(await contribution.export?.({ subject: { type: "user", id: "never" }, env: ENV })).toEqual({});
  });
});

describe("auth's purge contribution, with a Better Auth plugin that keeps rows about the account", () => {
  const plan = authPluginPlan([twoFactor()]);
  const contribution = authPurgeContribution("DB", plan.userTables);

  beforeEach(async () => {
    for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
      await env.DB.prepare(`drop table if exists ${table}`).run();
    }
    const provider = createMigrationRegistry([
      {
        database: "app",
        namespace: "auth",
        order: AUTH_MIGRATION_ORDER,
        migrations: { ...AUTH_MIGRATIONS, ...plan.migrations },
      },
    ]).app;
    if (!provider) throw new Error('expected a provider for database "app"');
    await runMigrations(env.DB, provider);
    for (const id of ["u1", "u2"]) {
      await seedAccountFootprint(env.DB, id);
      await env.DB.prepare(
        "insert into two_factor (id, secret, backup_codes, user_id, verified) values (?, ?, ?, ?, 1)",
      )
        .bind(`tf-${id}`, `totp-secret-${id}`, `backup-codes-${id}`, id)
        .run();
    }
  });

  const twoFactorRows = async (userId: string) =>
    (await env.DB.prepare("select count(*) as n from two_factor where user_id = ?").bind(userId).first<{ n: number }>())
      ?.n;

  test("the plugin's user-keyed table is erased with auth's own, and nobody else's row in it goes", async () => {
    expect(plan.userTables).toEqual(["twoFactor"]);
    await contribution.erase({ subject: SUBJECT, env: ENV });
    expect(await twoFactorRows("u1")).toBe(0);
    expect(await twoFactorRows("u2")).toBe(1);
    expect((await footprintCounts(env.DB, "u1")).pithy_auth_users).toBe(0);
    await expect(contribution.erase({ subject: SUBJECT, env: ENV })).resolves.toBeUndefined();
  });

  test("the export carries the plugin's rows, without the secret or the backup codes", async () => {
    const exported = await contribution.export?.({ subject: SUBJECT, env: ENV });
    const parsed = AuthUserExport.parse(exported);
    expect(parsed.plugins).toEqual({ twoFactor: [expect.objectContaining({ id: "tf-u1", verified: 1 })] });
    const wire = JSON.stringify(exported);
    expect(wire).not.toContain("totp-secret-u1");
    expect(wire).not.toContain("backup-codes-u1");
    expect(wire).not.toContain("tf-u2");
  });
});
