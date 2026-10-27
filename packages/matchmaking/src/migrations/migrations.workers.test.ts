// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { matchmaking_0001_matchmaking } from "./0001_matchmaking";
import { matchmaking_0002_invite_moderation } from "./0002_invite_moderation";

function db(): Kysely<unknown> {
  return createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
}

async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_matchmaking_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  for (const t of ["pithy_matchmaking_invites", "pithy_matchmaking_friends"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});

describe("matchmaking_0001_matchmaking", () => {
  test("up creates the invites and friends tables and their indexes", async () => {
    await matchmaking_0001_matchmaking.up(db());
    expect(await catalog()).toEqual([
      "pithy_matchmaking_friends",
      "pithy_matchmaking_friends_by_user_b",
      "pithy_matchmaking_friends_pair_idx",
      "pithy_matchmaking_invites",
      "pithy_matchmaking_invites_invitee_idx",
    ]);
  });

  test("down is the exact inverse — nothing of the migration survives", async () => {
    await matchmaking_0001_matchmaking.up(db());
    await matchmaking_0001_matchmaking.down?.(db());
    expect(await catalog()).toEqual([]);
  });

  test("up then down then up again is clean (rollback is re-runnable)", async () => {
    await matchmaking_0001_matchmaking.up(db());
    await matchmaking_0001_matchmaking.down?.(db());
    await matchmaking_0001_matchmaking.up(db());
    expect(await catalog()).toContain("pithy_matchmaking_invites");
  });
});

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("matchmaking_0002_invite_moderation", () => {
  test("up adds the cancel key, its unique index, and the pending-by-age index", async () => {
    await matchmaking_0001_matchmaking.up(db());
    await matchmaking_0002_invite_moderation.up(db());
    expect(await columns("pithy_matchmaking_invites")).toContain("cancel_key");
    expect(await catalog()).toEqual(
      expect.arrayContaining([
        "pithy_matchmaking_invites_cancel_key_idx",
        "pithy_matchmaking_invites_status_created_idx",
      ]),
    );
  });

  test("the cancel key is unique, and any number of invites carry none", async () => {
    await matchmaking_0001_matchmaking.up(db());
    await matchmaking_0002_invite_moderation.up(db());
    const insert = (id: string, key: string | null) =>
      env.DB.prepare(
        "INSERT INTO pithy_matchmaking_invites (id, game_key, inviter_id, invitee_id, status, created_at, cancel_key) VALUES (?, 'duel', 'a', 'b', 'pending', 1, ?)",
      )
        .bind(id, key)
        .run();
    await insert("i1", null);
    await insert("i2", null);
    await insert("i3", "k1");
    await expect(insert("i4", "k1")).rejects.toThrow(/UNIQUE/);
  });

  test("down is the exact inverse of up", async () => {
    await matchmaking_0001_matchmaking.up(db());
    const before = await catalog();
    await matchmaking_0002_invite_moderation.up(db());
    await matchmaking_0002_invite_moderation.down?.(db());
    expect(await catalog()).toEqual(before);
    expect(await columns("pithy_matchmaking_invites")).not.toContain("cancel_key");
  });
});
