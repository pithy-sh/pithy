// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { multiplayer } from "../capability";
import { multiplayer_0001_results } from "../migrations/0001_results";
import { MULTIPLAYER_PURGE_SUMMARY, multiplayerUserPurge } from "./contribution";

/**
 * Multiplayer's part of a person's purge and export (#814), over real D1: the results they played in are exported,
 * then anonymized — their id gone from every column, every other player's still there.
 */

const purge = multiplayerUserPurge();
const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB } });

async function exportOf(id: string): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(context(id));
}

const RESULT =
  "INSERT INTO pithy_multiplayer_results (session_id, game_key, status, players, scores, winner_user_id, draw, created_at, resolved_at) VALUES (?, 'chess', 'resolved', ?, ?, ?, 0, ?, ?)";

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_multiplayer_results");
  await multiplayer_0001_results.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await env.DB.prepare(RESULT).bind("s1", '["ada","bob"]', '{"ada":3,"bob":1}', "ada", 1, 2).run();
  await env.DB.prepare(RESULT).bind("s2", '["bob","cy"]', '{"bob":2,"cy":2}', null, 3, 4).run();
});

describe("the multiplayer user purge", () => {
  test("multiplayer() declares it for the user subject, with a summary and an export", () => {
    const declared =
      multiplayer({ games: [{ key: "chess", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }] }).purge ??
      [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(MULTIPLAYER_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the results the person played in, and no credential", async () => {
    const data = await exportOf("ada");
    expect(data.results).toEqual([
      expect.objectContaining({ sessionId: "s1", players: ["ada", "bob"], winnerUserId: "ada" }),
    ]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("anonymizes them, and leaves the other players and every other result as they were", async () => {
    await purge.erase(context("ada"));
    expect(await exportOf("ada")).toEqual({ results: [] });
    const results = (await exportOf("bob")).results as { sessionId: string; players: string[]; winnerUserId: string }[];
    const [first, second] = results;
    expect(first?.players[1]).toBe("bob");
    expect(first?.players[0]).toMatch(/^erased-[0-9a-f-]{36}$/);
    expect(first?.winnerUserId).toBe(first?.players[0]);
    expect(second).toEqual(expect.objectContaining({ sessionId: "s2", players: ["bob", "cy"] }));
    const raw = await env.DB.prepare("SELECT players, scores, winner_user_id FROM pithy_multiplayer_results").all();
    expect(JSON.stringify(raw.results)).not.toContain('"ada"');
  });

  test("is idempotent: a second run finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });
});
