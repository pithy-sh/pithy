// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { reencryptJwks } from "./jwksReencryption";

const ONE = "jwks-test-version-one-000000000000000000000";
const TWO = "jwks-test-version-two-000000000000000000000";
const versions = { currentVersion: "2", versions: { "1": ONE, "2": TWO } };
const config = (current: number) => ({
  keys: new Map([
    [1, ONE],
    [2, TWO],
  ]),
  currentVersion: current,
});

async function insertKey(id: string, privateKey: string): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_jwks (id, public_key, private_key, created_at) values (?, '{}', ?, '2026-10-18T00:00:00.000Z')",
  )
    .bind(id, JSON.stringify(privateKey))
    .run();
}

async function storedKey(id: string): Promise<string> {
  const row = await env.DB.prepare("select private_key from pithy_auth_jwks where id = ?")
    .bind(id)
    .first<{ private_key: string }>();
  return JSON.parse(row?.private_key ?? '""') as string;
}

beforeEach(async () => {
  for (const table of ["pithy_auth_jwks", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  for (const table of [
    "pithy_auth_accounts",
    "pithy_auth_devices",
    "pithy_auth_rate_limit",
    "pithy_auth_rotated_tokens",
    "pithy_auth_sessions",
    "pithy_auth_users",
    "pithy_auth_verifications",
  ]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("reencryptJwks (#602)", () => {
  test("moves a key sealed under the previous version, and a bare one from before versions, under the current one", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    await insertKey("bare", await symmetricEncrypt({ key: ONE, data: "private-bare" }));
    await insertKey("current", await symmetricEncrypt({ key: config(2), data: "private-current" }));

    expect(await reencryptJwks(authDatabase(env.DB), versions)).toEqual({ moved: 2, current: 1, unopenable: 0 });
    for (const [id, plain] of [
      ["enveloped", "private-enveloped"],
      ["bare", "private-bare"],
      ["current", "private-current"],
    ] as const) {
      const sealed = await storedKey(id);
      expect(sealed).toMatch(/^\$ba\$2\$/);
      // Opens with version 2 alone: version 1 can now be retired.
      expect(await symmetricDecrypt({ key: { keys: new Map([[2, TWO]]), currentVersion: 2 }, data: sealed })).toBe(
        plain,
      );
    }
  });

  test("a key no retained version opens is left exactly as it was, and counted", async () => {
    const foreign = await symmetricEncrypt({ key: "a-secret-nobody-here-holds-00000000000000", data: "lost" });
    await insertKey("lost", foreign);
    expect(await reencryptJwks(authDatabase(env.DB), versions)).toEqual({ moved: 0, current: 0, unopenable: 1 });
    expect(await storedKey("lost")).toBe(foreign);
  });

  test("a second pass moves nothing", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    await reencryptJwks(authDatabase(env.DB), versions);
    expect(await reencryptJwks(authDatabase(env.DB), versions)).toEqual({ moved: 0, current: 1, unopenable: 0 });
  });
});
