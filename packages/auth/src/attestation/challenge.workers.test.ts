// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { consumeChallenge, issueChallenge } from "./challenge";

const db = () => authDatabase(env.DB);
const T0 = new Date("2026-11-13T12:00:00.000Z");
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_auth_attestation_challenges").run();
  await env.DB.prepare("drop table if exists pithy_migrations").run();
  await env.DB.prepare("drop table if exists pithy_migrations_lock").run();
  for (const row of (
    await env.DB.prepare("select name from sqlite_master where type = 'table' and name like 'pithy_auth_%'").all<{
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

describe("attestation challenges", () => {
  test("an issued challenge is 32 random bytes, unpadded base64url, and expires after its lifetime", async () => {
    const issued = await issueChallenge(db(), { now: T0, expiresIn: 300 });
    expect(issued.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toEqual(later(300));
    expect((await issueChallenge(db(), { now: T0, expiresIn: 300 })).challenge).not.toBe(issued.challenge);
  });

  test("the challenge itself is never stored, only its digest", async () => {
    const { challenge } = await issueChallenge(db(), { now: T0, expiresIn: 300 });
    const rows = await env.DB.prepare("select id from pithy_auth_attestation_challenges").all<{ id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.id).not.toBe(challenge);
  });

  test("a live challenge is consumed once, and a second use is refused", async () => {
    const { challenge } = await issueChallenge(db(), { now: T0, expiresIn: 300 });
    expect(await consumeChallenge(db(), challenge, later(10))).toEqual({ ok: true });
    expect(await consumeChallenge(db(), challenge, later(11))).toEqual({
      ok: false,
      reason: expect.stringContaining("already used or never issued"),
    });
  });

  test("a challenge used after it expires is refused, and spent", async () => {
    const { challenge } = await issueChallenge(db(), { now: T0, expiresIn: 60 });
    expect(await consumeChallenge(db(), challenge, later(60))).toEqual({
      ok: false,
      reason: expect.stringContaining("expired"),
    });
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_attestation_challenges").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  test("an unknown challenge is refused", async () => {
    expect((await consumeChallenge(db(), "never-issued", T0)).ok).toBe(false);
  });

  test("issuing prunes the challenges that have run out, and keeps the live ones", async () => {
    await issueChallenge(db(), { now: T0, expiresIn: 60 });
    const live = await issueChallenge(db(), { now: T0, expiresIn: 600 });
    await issueChallenge(db(), { now: later(120), expiresIn: 60 });
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_attestation_challenges").first<{
      n: number;
    }>();
    expect(left?.n).toBe(2);
    expect(await consumeChallenge(db(), live.challenge, later(121))).toEqual({ ok: true });
  });
});
