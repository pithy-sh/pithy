// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import {
  consumeSession,
  familySessionTokens,
  findConsumedToken,
  pruneConsumedTokens,
  recordConsumedToken,
  revokeFamily,
} from "./rotation";

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

/** Insert a bare session row (raw SQL — bypasses Better Auth, so the helpers are tested in isolation). */
async function insertSession(token: string, familyId: string | null, userId = "user-1"): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_sessions (id, expires_at, token, created_at, updated_at, user_id, family_id) values (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `sess-${token}`,
      "2099-01-01T00:00:00.000Z",
      token,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      userId,
      familyId,
    )
    .run();
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    {
      database: "app",
      namespace: "auth",
      order: AUTH_MIGRATION_ORDER,
      migrations: { "0001_init": auth_0001_init },
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("consumeSession (the atomic race gate)", () => {
  test("the first call wins and returns the family; a second call on the same token loses", async () => {
    const db = authDatabase(env.DB);
    await insertSession("tok-1", "fam-1");

    const first = await consumeSession(db, "tok-1");
    expect(first).toEqual({ won: true, familyId: "fam-1" });

    const second = await consumeSession(db, "tok-1");
    expect(second).toEqual({ won: false, familyId: null });

    const remaining = await env.DB.prepare("select count(*) as n from pithy_auth_sessions where token = ?")
      .bind("tok-1")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  test("a session with no family id still consumes, reporting a null family", async () => {
    const db = authDatabase(env.DB);
    await insertSession("tok-2", null);
    expect(await consumeSession(db, "tok-2")).toEqual({ won: true, familyId: null });
  });

  test("consuming a token that never existed loses without error", async () => {
    expect(await consumeSession(authDatabase(env.DB), "ghost")).toEqual({ won: false, familyId: null });
  });
});

describe("the reuse-detection ledger", () => {
  test("a recorded token is found by family, owner, and consume time; an unrecorded one is null", async () => {
    const db = authDatabase(env.DB);
    const rotatedAt = new Date(1_750_000_000_000);
    await recordConsumedToken(db, { token: "tok-1", familyId: "fam-1", userId: "user-1", rotatedAt });

    expect(await findConsumedToken(db, "tok-1")).toEqual({ familyId: "fam-1", userId: "user-1", rotatedAt });
    expect(await findConsumedToken(db, "tok-unknown")).toBeNull();
  });

  test("recording the same token twice is idempotent — the first family wins, no error", async () => {
    const db = authDatabase(env.DB);
    await recordConsumedToken(db, { token: "tok-1", familyId: "fam-1", userId: "user-1", rotatedAt: new Date() });
    await recordConsumedToken(db, { token: "tok-1", familyId: "fam-2", userId: "user-2", rotatedAt: new Date() });
    expect(await findConsumedToken(db, "tok-1")).toMatchObject({ familyId: "fam-1", userId: "user-1" });
  });

  test("prune removes entries consumed before the cutoff and keeps newer ones", async () => {
    const db = authDatabase(env.DB);
    await recordConsumedToken(db, { token: "old", familyId: "f", userId: "u", rotatedAt: new Date(1_000) });
    await recordConsumedToken(db, { token: "fresh", familyId: "f", userId: "u", rotatedAt: new Date(9_000) });

    const removed = await pruneConsumedTokens(db, new Date(5_000));
    expect(removed).toBe(1);
    expect(await findConsumedToken(db, "old")).toBeNull();
    expect(await findConsumedToken(db, "fresh")).not.toBeNull();
  });
});

describe("family revocation", () => {
  test("familySessionTokens returns every live token sharing the family", async () => {
    const db = authDatabase(env.DB);
    await insertSession("a", "fam-1");
    await insertSession("b", "fam-1");
    await insertSession("c", "fam-2");
    expect((await familySessionTokens(db, "fam-1")).sort()).toEqual(["a", "b"]);
  });

  test("revokeFamily deletes each family session through the injected deleter and returns the count", async () => {
    const db = authDatabase(env.DB);
    await insertSession("a", "fam-1");
    await insertSession("b", "fam-1");
    await insertSession("c", "fam-2");

    const deleted: string[] = [];
    const count = await revokeFamily(db, "fam-1", async (token) => {
      deleted.push(token);
      await env.DB.prepare("delete from pithy_auth_sessions where token = ?").bind(token).run();
    });

    expect(count).toBe(2);
    expect(deleted.sort()).toEqual(["a", "b"]);
    const survivors = await env.DB.prepare("select token from pithy_auth_sessions").all<{ token: string }>();
    expect(survivors.results.map((r) => r.token)).toEqual(["c"]);
  });
});
