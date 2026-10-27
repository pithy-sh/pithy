// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { matchmaking } from "../capability";
import { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";
import { MATCHMAKING_MIGRATIONS } from "../migrations/chain";
import { MATCHMAKING_PURGE_SUMMARY, matchmakingUserPurge } from "./contribution";

/**
 * Matchmaking's part of a person's purge and export (#814), over real D1 and each configured game's real queue
 * Durable Object: rows present, exported, purged, gone — and nobody else's touched.
 */

const GAMES = ["chess", "duel"] as const;
const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB, QUEUE: env.QUEUE } });
const queue = (gameKey: string) => env.QUEUE.get(env.QUEUE.idFromName(gameKey));
const SETTINGS = MatchmakingQueueSettings.parse({});
const SNAPSHOT = MatchmakingSnapshot.parse({ kind: "connect-n", rules: {} });
const enqueue = (gameKey: string, userId: string, region: string) =>
  queue(gameKey).enqueue({ userId, skill: 1000, region, gameKey, players: 2, settings: SETTINGS, snapshot: SNAPSHOT });
/** The contribution's export, which every kit contribution declares. */
async function exportOf(input: ReturnType<typeof context>): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

const purge = matchmakingUserPurge("DB", GAMES);

async function count(table: string, column: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const game of GAMES) for (const user of ["ada", "bob", "cy"]) await queue(game).forget(user);
  // Ada waits in chess; in duel she was matched with Bob and has not polled for it. Cy waits in chess elsewhere.
  await enqueue("chess", "ada", "eu");
  await enqueue("chess", "cy", "na");
  await enqueue("duel", "ada", "eu");
  await enqueue("duel", "bob", "eu");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_matchmaking_invites");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_matchmaking_friends");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const migration of Object.values(MATCHMAKING_MIGRATIONS)) await migration.up(db);
  await env.DB.exec(
    "INSERT INTO pithy_matchmaking_invites (id, game_key, inviter_id, invitee_id, status, created_at) VALUES ('i0', 'chess', 'ada', 'cy', 'canceled', 1699999999999), ('i1', 'chess', 'ada', 'bob', 'pending', 1700000000000), ('i2', 'chess', 'cy', 'ada', 'accepted', 1700000000001), ('i3', 'chess', 'bob', 'cy', 'pending', 1700000000002)",
  );
  await env.DB.exec("UPDATE pithy_matchmaking_invites SET cancel_key = 'operator-key-1' WHERE id = 'i0'");
  await env.DB.exec(
    "INSERT INTO pithy_matchmaking_friends (user_a, user_b, status, requested_by, created_at, updated_at) VALUES ('ada', 'bob', 'accepted', 'ada', 1700000000000, 1700000000000), ('bob', 'cy', 'accepted', 'bob', 1700000000000, 1700000000000)",
  );
});

describe("the matchmaking user purge", () => {
  test("matchmaking() declares it for the user subject, with a summary and an export", () => {
    const declared = matchmaking({ games: [{ key: "chess", snapshot: { kind: "connect-n", rules: {} } }] }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(MATCHMAKING_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the person's rows, and no credential", async () => {
    const data = await exportOf(context("ada"));
    expect((data.invites as { id: string }[]).map((invite) => invite.id)).toEqual(["i0", "i1", "i2"]);
    expect(data.friends).toEqual([expect.objectContaining({ userA: "ada", userB: "bob", status: "accepted" })]);
    expect(data.queues).toEqual([
      {
        gameKey: "chess",
        waiting: { region: "eu", skill: 1000, enqueuedAt: expect.any(Number) },
        match: null,
        drops: [],
      },
      {
        gameKey: "duel",
        waiting: null,
        match: { sessionId: null, gameKey: "duel", at: expect.any(Number) },
        drops: [],
      },
    ]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("leaves out the key a management client canceled an invite with, which is the operator's", async () => {
    const [canceled] = (await exportOf(context("ada"))).invites as Record<string, unknown>[];
    expect(canceled).toMatchObject({ id: "i0", status: "canceled" });
    expect(canceled).not.toHaveProperty("cancelKey");
  });

  test("erases them, and leaves everyone else's", async () => {
    await purge.erase(context("ada"));
    expect(await count("pithy_matchmaking_invites", "inviter_id", "ada")).toBe(0);
    expect(await count("pithy_matchmaking_invites", "invitee_id", "ada")).toBe(0);
    expect(await count("pithy_matchmaking_friends", "user_a", "ada")).toBe(0);
    expect(await count("pithy_matchmaking_friends", "user_b", "ada")).toBe(0);
    expect(await exportOf(context("ada"))).toEqual({ invites: [], friends: [], queues: [] });
    expect((await queue("chess").waiting()).map((ticket) => ticket.userId)).toEqual(["cy"]);
    expect((await queue("duel").status("bob")).state).toBe("matched");
    expect(JSON.stringify(await exportOf(context("bob")))).toContain("bob");
  });

  test("without a queue binding, the step is a wiring fault and erases nothing", async () => {
    await expect(purge.erase({ subject: { type: "user", id: "ada" }, env: { DB: env.DB } })).rejects.toThrow(
      /Durable Object namespace is not bound/,
    );
    expect(await count("pithy_matchmaking_invites", "inviter_id", "ada")).toBe(2);
  });

  test("a game with nothing configured reaches no queue", async () => {
    const rowsOnly = matchmakingUserPurge("DB", []);
    await rowsOnly.erase({ subject: { type: "user", id: "ada" }, env: { DB: env.DB } });
    expect((await queue("chess").heldFor("ada")).waiting).not.toBeNull();
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });
});
