// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { sessionIndex } from "../data/sessionStore";
import { resultStore } from "../data/store";
import { multiplayerDatabase } from "../data/tables";
import "../game/builtins";
import { type GameModel, registerGameModel } from "../game/model";
import { freshMultiplayerDatabase } from "../test-utils/database";
import type { MultiplayerSession } from "./durableObject";
import type { GameSnapshot } from "./state";

/**
 * The session index, written by the session itself (#820): a row when it opens, rewritten as its roster and phase
 * move, and gone when it ends — however it ends. And the close a management client asks for, from the inside.
 */

beforeEach(async () => {
  await freshMultiplayerDatabase(env.DB);
});

/** A table that records who it settled out, so a close can be seen settling every seat. */
const LEDGERED_TABLE: GameModel = {
  kind: "test-index-table",
  config: z.object({}).describe("No rules."),
  state: z.object({ settled: z.array(z.string()).describe("Who was settled out.") }).describe("The table."),
  init: () => ({ settled: [] }),
  apply: (_ctx, state) => ({ state }),
  onLeave: (_ctx, state, userId) => {
    const current = state as { settled: string[] };
    return { state: { settled: [...current.settled, userId] } };
  },
  isComplete: () => false,
  resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: false } }),
  redact: (_ctx, state) => state,
};
registerGameModel(LEDGERED_TABLE);

function ttt(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    key: "ttt",
    kind: "connect-n",
    mode: "match",
    players: 2,
    turnTimeoutMs: null,
    leaderboard: null,
    rules: { rows: 3, cols: 3, connect: 3 },
    ...over,
  };
}

const TABLE: GameSnapshot = { ...ttt(), key: "table", kind: "test-index-table", mode: "table", players: 4, rules: {} };

function session() {
  const id = env.SESSIONS.newUniqueId();
  return { sessionId: id.toString(), stub: env.SESSIONS.get(id) };
}

const run = <T>(stub: DurableObjectStub<MultiplayerSession>, call: (s: MultiplayerSession) => Promise<T>) =>
  runInDurableObject(stub, call);

/** `d1`, with every statement it runs waiting a beat first — the width of a real D1 round trip. */
function slowD1(d1: D1Database): D1Database {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
  const slow = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        if (key === "bind") return (...args: unknown[]) => slow(target.bind(...args));
        return async (...args: unknown[]) => {
          await wait();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return new Proxy(d1, {
    get(target, key) {
      if (key === "prepare") return (query: string) => slow(target.prepare(query));
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const indexed = (sessionId: string) => sessionIndex(multiplayerDatabase(env.DB)).get(sessionId);

describe("the session index", () => {
  test("a session writes its row when it opens, and rewrites it as its roster fills", async () => {
    const { sessionId, stub } = session();
    await run(stub, (s) => s.create(ttt(), "ada"));
    expect(await indexed(sessionId)).toMatchObject({ gameKey: "ttt", phase: "open", players: ["ada"] });
    await run(stub, (s) => s.join("bo"));
    expect(await indexed(sessionId)).toMatchObject({ phase: "active", players: ["ada", "bo"] });
  });

  test("a session that resolves leaves the index", async () => {
    const { sessionId, stub } = session();
    await run(stub, (s) => s.create(ttt(), "x"));
    await run(stub, (s) => s.join("o"));
    for (const [player, row, col] of [
      ["x", 0, 0],
      ["o", 1, 0],
      ["x", 0, 1],
      ["o", 1, 1],
      ["x", 0, 2],
    ] as const) {
      await run(stub, (s) => s.action(player, { row, col }));
    }
    expect(await indexed(sessionId)).toBeUndefined();
    expect(await resultStore(env.DB).get(sessionId)).toBeDefined();
  });

  test("a session abandoned by its deadline leaves the index", async () => {
    const { sessionId, stub } = session();
    await run(stub, (s) => s.create(ttt({ turnTimeoutMs: 60_000 }), "x"));
    await run(stub, (s) => s.join("o"));
    expect(await indexed(sessionId)).toBeDefined();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await indexed(sessionId)).toBeUndefined();
    expect((await resultStore(env.DB).get(sessionId))?.status).toBe("abandoned");
  });

  test("a table follows its seats, and leaves the index when its last player leaves or a player closes it", async () => {
    const left = session();
    await run(left.stub, (s) => s.create(TABLE, "ada"));
    expect(await indexed(left.sessionId)).toMatchObject({ phase: "active", players: ["ada"] });
    await run(left.stub, (s) => s.join("bo"));
    await run(left.stub, (s) => s.leave("ada"));
    expect(await indexed(left.sessionId)).toMatchObject({ players: ["bo"] });
    await run(left.stub, (s) => s.leave("bo"));
    expect(await indexed(left.sessionId)).toBeUndefined();

    const closed = session();
    await run(closed.stub, (s) => s.create(TABLE, "ada"));
    await run(closed.stub, (s) => s.close("ada"));
    expect(await indexed(closed.sessionId)).toBeUndefined();
  });

  test("a player closing a table settles every seat out first", async () => {
    const { stub } = session();
    await run(stub, (s) => s.create(TABLE, "ada"));
    await run(stub, (s) => s.join("bo"));
    const view = await run(stub, (s) => s.close("ada"));
    expect(view.state).toEqual({ settled: ["ada", "bo"] });
  });

  test("two joins racing for a match's last seat: one gets in, the other is told it is full, and the row agrees", async () => {
    const { sessionId, stub } = session();
    await run(stub, (s) => s.create(ttt(), "ada"));
    // The index write is D1, outside I/O: other events run while it is in flight. A slow D1 makes the window wide.
    await run(stub, async (s) => {
      const held = s as unknown as { env: { DB: D1Database } };
      held.env = { ...held.env, DB: slowD1(held.env.DB) };
    });
    const joins = await Promise.allSettled([run(stub, (s) => s.join("bo")), run(stub, (s) => s.join("cy"))]);
    const admitted = joins.filter((join) => join.status === "fulfilled");
    const refused = joins.filter((join) => join.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult | undefined)?.reason)).toContain("multiplayer/session_full");
    const inspected = await run(stub, (s) => s.inspect());
    expect(inspected.players).toHaveLength(2);
    expect((await indexed(sessionId))?.players).toEqual(inspected.players);
  });
});

describe("closeByOperator", () => {
  test("ends a session in flight with no result, the reason in its outcome, and the index row gone", async () => {
    const { sessionId, stub } = session();
    await run(stub, (s) => s.create(ttt({ turnTimeoutMs: 60_000 }), "ada"));
    await run(stub, (s) => s.join("bo"));
    const outcome = await run(stub, (s) => s.closeByOperator("k1", "Stuck."));
    expect(outcome.replayed).toBe(false);
    expect(outcome.session).toMatchObject({
      phase: "abandoned",
      players: ["ada", "bo"],
      deadline: null,
      outcome: { status: "abandoned", scores: null, winnerUserId: null, draw: false, closedReason: "Stuck." },
    });
    expect(await indexed(sessionId)).toBeUndefined();
    expect(await resultStore(env.DB).get(sessionId)).toBeUndefined();
    // The deadline went with it: no alarm is left to abandon the session again.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    // A player reads the reason on their own view.
    expect((await run(stub, (s) => s.view("ada"))).outcome?.closedReason).toBe("Stuck.");
  });

  test("settles every seat at a table out before it ends", async () => {
    const { stub } = session();
    await run(stub, (s) => s.create(TABLE, "ada"));
    await run(stub, (s) => s.join("bo"));
    await run(stub, (s) => s.closeByOperator("k1", "Closing the room."));
    expect((await run(stub, (s) => s.view("ada"))).state).toEqual({ settled: ["ada", "bo"] });
  });

  test("the same key replays; another key on a closed session, or any key on a missing one, is refused", async () => {
    const { stub } = session();
    await run(stub, (s) => s.create(ttt(), "ada"));
    await run(stub, (s) => s.closeByOperator("k1", "Stuck."));
    expect((await run(stub, (s) => s.closeByOperator("k1", "Stuck."))).replayed).toBe(true);
    await expect(run(stub, (s) => s.closeByOperator("k2", "Again."))).rejects.toThrow(/invalid_transition/);
    const missing = session();
    await expect(run(missing.stub, (s) => s.closeByOperator("k1", "x"))).rejects.toThrow(/session_not_found/);
  });

  test("inspect never carries the game's state, and names who is connected", async () => {
    const { stub } = session();
    await run(stub, (s) => s.create(ttt(), "ada"));
    const inspected = await run(stub, (s) => s.inspect());
    expect(inspected).not.toHaveProperty("state");
    expect(inspected.connected).toEqual([]);
    expect(inspected.openedAt).toMatch(/Z$/);
  });
});
