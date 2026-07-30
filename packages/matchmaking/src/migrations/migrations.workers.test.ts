// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { matchmaking_0001_matchmaking } from "./0001_matchmaking";

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
