// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../../data/tables";
import { AUTH_MIGRATION_ORDER } from "../../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../../migrations/set";
import { advanceAppAttestCounter, findAppAttestKey, storeAppAttestKey } from "./keys";

const db = () => authDatabase(env.DB);
const T0 = new Date("2026-11-13T12:00:00.000Z");
const KEY = {
  keyId: new Uint8Array(32).fill(1),
  publicKey: new Uint8Array(65).fill(4),
  appId: "ABCDE12345.com.example.app",
  environment: "production" as const,
};

beforeEach(async () => {
  for (const row of (
    await env.DB.prepare("select name from sqlite_master where type = 'table' and name like 'pithy_%'").all<{
      name: string;
    }>()
  ).results) {
    await env.DB.prepare(`drop table if exists ${row.name}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error("no provider");
  await runMigrations(env.DB, provider);
});

describe("App Attest key storage", () => {
  test("a stored key reads back by its id, at counter zero and never used", async () => {
    expect(await storeAppAttestKey(db(), KEY, T0)).toBe(true);
    const found = await findAppAttestKey(db(), KEY.keyId);
    expect(found).toEqual({
      id: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      publicKey: expect.stringMatching(/^BAQE/),
      appId: KEY.appId,
      environment: "production",
      counter: 0,
      createdAt: T0,
      lastUsedAt: null,
    });
  });

  test("a key is registered once: a second registration of the same id is refused and changes nothing", async () => {
    await storeAppAttestKey(db(), KEY, T0);
    await advanceAppAttestCounter(db(), KEY.keyId, 4, T0);
    expect(await storeAppAttestKey(db(), { ...KEY, publicKey: new Uint8Array(65).fill(9) }, T0)).toBe(false);
    expect((await findAppAttestKey(db(), KEY.keyId))?.counter).toBe(4);
  });

  test("an unknown key is not found", async () => {
    expect(await findAppAttestKey(db(), new Uint8Array(32))).toBeUndefined();
  });

  test("the counter only moves up, and the last use moves with it", async () => {
    await storeAppAttestKey(db(), KEY, T0);
    const later = new Date(T0.getTime() + 1000);
    expect(await advanceAppAttestCounter(db(), KEY.keyId, 2, later)).toBe(true);
    expect(await advanceAppAttestCounter(db(), KEY.keyId, 2, later)).toBe(false);
    expect(await advanceAppAttestCounter(db(), KEY.keyId, 1, later)).toBe(false);
    const found = await findAppAttestKey(db(), KEY.keyId);
    expect(found?.counter).toBe(2);
    expect(found?.lastUsedAt).toEqual(later);
  });

  test("two racing assertions on one counter: exactly one moves it", async () => {
    await storeAppAttestKey(db(), KEY, T0);
    const results = await Promise.all([
      advanceAppAttestCounter(db(), KEY.keyId, 1, T0),
      advanceAppAttestCounter(db(), KEY.keyId, 1, T0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
