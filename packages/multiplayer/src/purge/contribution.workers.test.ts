// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { beforeEach, describe, expect, test } from "vitest";
import { multiplayer } from "../capability";
import { sessionIndex } from "../data/sessionStore";
import { resultStore } from "../data/store";
import { multiplayerDatabase } from "../data/tables";
import type { MultiplayerSession } from "../session/durableObject";
import type { GameSnapshot } from "../session/state";
import { freshMultiplayerDatabase } from "../test-utils/database";
import { MULTIPLAYER_PURGE_CLOSE_REASON, MULTIPLAYER_PURGE_SUMMARY, multiplayerUserPurge } from "./contribution";

/**
 * Multiplayer's part of a person's purge and export (#814), over real D1: the results they played in are exported,
 * then anonymized — their id gone from every column, every other player's still there.
 */

const purge = multiplayerUserPurge();
const context = (id: string) => ({
  subject: { type: "user" as const, id },
  env: { DB: env.DB, SESSIONS: env.SESSIONS } as Record<string, unknown>,
});

async function exportOf(id: string): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(context(id));
}

const RESULT =
  "INSERT INTO pithy_multiplayer_results (session_id, game_key, status, players, scores, winner_user_id, draw, created_at, resolved_at) VALUES (?, 'chess', 'resolved', ?, ?, ?, 0, ?, ?)";

beforeEach(async () => {
  await freshMultiplayerDatabase(env.DB);
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
    expect(await exportOf("ada")).toEqual({ results: [], sessionsInFlight: [] });
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

/** A tic-tac-toe snapshot, so a session can be opened for real. */
const TTT: GameSnapshot = {
  key: "chess",
  kind: "connect-n",
  mode: "match",
  players: 2,
  turnTimeoutMs: null,
  leaderboard: null,
  rules: { rows: 3, cols: 3, connect: 3 },
};

describe("the purge and the session index (#820)", () => {
  test("exports the sessions in flight the person plays in", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    const view = await runInDurableObject(stub, (session: MultiplayerSession) => session.create(TTT, "ada"));
    const data = await exportOf("ada");
    expect(data.sessionsInFlight).toEqual([expect.objectContaining({ sessionId: view.sessionId, players: ["ada"] })]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("ends a session in flight the person plays in: no result, out of the index, the others told why", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    const view = await runInDurableObject(stub, (session: MultiplayerSession) => session.create(TTT, "ada"));
    await runInDurableObject(stub, (session: MultiplayerSession) => session.join("dee"));
    await purge.erase(context("ada"));

    const db = multiplayerDatabase(env.DB);
    expect(await sessionIndex(db).get(view.sessionId)).toBeUndefined();
    expect(await resultStore(env.DB).get(view.sessionId)).toBeUndefined();
    const after = await runInDurableObject(stub, (session: MultiplayerSession) => session.inspect());
    expect(after.phase).toBe("abandoned");
    expect(after.outcome?.closedReason).toBe(MULTIPLAYER_PURGE_CLOSE_REASON);
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });

  test("a row left for a session that already ended is dropped, and the session is left alone", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    const view = await runInDurableObject(stub, (session: MultiplayerSession) => session.create(TTT, "ada"));
    await runInDurableObject(stub, (session: MultiplayerSession) => session.closeByOperator("k-1", "Stuck."));
    // The index row comes back, as a write that lost a race with the close would leave it.
    await sessionIndex(multiplayerDatabase(env.DB)).put({
      sessionId: view.sessionId,
      gameKey: "chess",
      phase: "open",
      players: ["ada"],
      openedAt: new Date(),
    });
    await purge.erase(context("ada"));
    expect(await sessionIndex(multiplayerDatabase(env.DB)).get(view.sessionId)).toBeUndefined();
    const after = await runInDurableObject(stub, (session: MultiplayerSession) => session.inspect());
    expect(after.outcome?.closedReason).toBe("Stuck.");
  });
});
