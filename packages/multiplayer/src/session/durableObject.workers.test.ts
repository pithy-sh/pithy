// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { resultStore } from "../data/store";
import { multiplayerDatabase } from "../data/tables";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { MultiplayerSession } from "./durableObject";
import type { GameSnapshot } from "./state";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "multiplayer",
      order: MULTIPLAYER_MIGRATION_ORDER,
      migrations: { "0001_results": multiplayer_0001_results },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

beforeEach(async () => {
  for (const t of ["pithy_multiplayer_results", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

/** A commit-reveal battle snapshot: pick 3 offense/defense from 4. */
function battle(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    key: "battle",
    kind: "battle",
    mode: "match",
    players: 2,
    turnTimeoutMs: null,
    leaderboard: null,
    rules: {
      offense: {
        pick: 3,
        moves: [
          { name: "fire", power: 10 },
          { name: "ice", power: 8 },
          { name: "wind", power: 6 },
          { name: "stone", power: 4 },
        ],
      },
      defense: {
        pick: 3,
        moves: [
          { name: "guard-fire", blocks: "fire" },
          { name: "guard-ice", blocks: "ice" },
          { name: "guard-wind", blocks: "wind" },
          { name: "guard-stone", blocks: "stone" },
        ],
      },
    },
    ...over,
  };
}

/** A tic-tac-toe snapshot. */
function tictactoe(over: Partial<GameSnapshot> = {}): GameSnapshot {
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

function newSession() {
  const id = env.SESSIONS.newUniqueId();
  return { id, stub: env.SESSIONS.get(id) };
}

type SimultaneousView = {
  phase: string;
  you: { submission: unknown; submitted: boolean };
  opponents: { userId: string; submitted: boolean; submission: unknown }[];
};

describe("commit-reveal, end to end (the flagship example)", () => {
  test("two players secretly pick, neither sees the other, the server resolves and writes D1", async () => {
    const { id, stub } = newSession();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(battle(), "alice"));
    const joined = await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    expect(joined.phase).toBe("active");

    const aliceCommit = { offense: ["fire", "ice", "wind"], defense: ["guard-stone", "guard-fire", "guard-ice"] };
    const afterAlice = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", aliceCommit));
    const aliceState = afterAlice.state as SimultaneousView;
    expect(aliceState.you.submission).toEqual(aliceCommit);
    expect(aliceState.opponents[0]?.submission).toBeNull(); // bob's moves hidden
    expect(afterAlice.phase).toBe("active");

    // Bob sees that alice has committed but not what.
    const bobView = await runInDurableObject(stub, (s: MultiplayerSession) => s.view("bob"));
    expect((bobView.state as SimultaneousView).opponents[0]?.submitted).toBe(true);
    expect((bobView.state as SimultaneousView).opponents[0]?.submission).toBeNull();

    const bobCommit = { offense: ["fire", "ice", "stone"], defense: ["guard-fire", "guard-ice", "guard-wind"] };
    const afterBob = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("bob", bobCommit));
    expect(afterBob.phase).toBe("resolved");
    expect(afterBob.outcome?.scores).toEqual({ alice: 0, bob: 0 }); // mutual full block → draw
    expect(afterBob.outcome?.draw).toBe(true);

    // The reveal: alice now sees bob's commit.
    const aliceAfter = await runInDurableObject(stub, (s: MultiplayerSession) => s.view("alice"));
    expect((aliceAfter.state as SimultaneousView).opponents[0]?.submission).toEqual(bobCommit);

    const stored = await resultStore(multiplayerDatabase(env.DB)).get(id.toString());
    expect(stored?.status).toBe("resolved");
    expect(stored?.players).toEqual(["alice", "bob"]);
    expect(stored?.draw).toBe(true);
  });

  test("a non-member cannot act; a full session cannot be joined; committing twice is rejected", async () => {
    const { stub } = newSession();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(battle(), "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    const commit = { offense: ["fire", "ice", "wind"], defense: ["guard-fire", "guard-ice", "guard-wind"] };

    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.action("mallory", commit))).rejects.toThrow(
      /multiplayer\/not_a_member/,
    );
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.join("carol"))).rejects.toThrow(
      /multiplayer\/session_full/,
    );
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", commit));
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", commit))).rejects.toThrow(
      /multiplayer\/invalid_transition/,
    );
  });
});

type GridView = { turn: string; yourTurn: boolean; game: { board: (string | null)[][]; moves: number } };

describe("sequential (tic-tac-toe), end to end", () => {
  test("players take turns on a visible board and a line of three wins, recorded in D1", async () => {
    const { id, stub } = newSession();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(tictactoe(), "x"));
    const joined = await runInDurableObject(stub, (s: MultiplayerSession) => s.join("o"));
    expect(joined.phase).toBe("active");
    // The board is open — both see it, x moves first.
    expect((joined.state as GridView).turn).toBe("x");

    const move = (player: string, row: number, col: number) =>
      runInDurableObject(stub, (s: MultiplayerSession) => s.action(player, { row, col }));
    await move("x", 0, 0);
    await move("o", 1, 0);
    await move("x", 0, 1);
    await move("o", 1, 1);
    const win = await move("x", 0, 2); // x completes the top row
    expect(win.phase).toBe("resolved");
    expect(win.outcome?.winnerUserId).toBe("x");
    expect(win.outcome?.draw).toBe(false);

    const stored = await resultStore(multiplayerDatabase(env.DB)).get(id.toString());
    expect(stored?.winnerUserId).toBe("x");
  });

  test("moving out of turn and onto a taken cell are rejected", async () => {
    const { stub } = newSession();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(tictactoe(), "x"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("o"));
    // o tries to move first — not their turn.
    await expect(
      runInDurableObject(stub, (s: MultiplayerSession) => s.action("o", { row: 0, col: 0 })),
    ).rejects.toThrow(/multiplayer\/invalid_transition/);
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("x", { row: 0, col: 0 }));
    // o claims a taken cell.
    await expect(
      runInDurableObject(stub, (s: MultiplayerSession) => s.action("o", { row: 0, col: 0 })),
    ).rejects.toThrow(/multiplayer\/invalid_move/);
  });
});

describe("the action deadline alarm (game-agnostic)", () => {
  test("a session whose deadline passes with the game unfinished is abandoned", async () => {
    const { id, stub } = newSession();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(battle({ turnTimeoutMs: 1000 }), "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("alice", { offense: ["fire", "ice", "wind"], defense: ["guard-fire", "guard-ice", "guard-wind"] }),
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const view = await runInDurableObject(stub, (s: MultiplayerSession) => s.view("alice"));
    expect(view.phase).toBe("abandoned");
    const stored = await resultStore(multiplayerDatabase(env.DB)).get(id.toString());
    expect(stored?.status).toBe("abandoned");
  });

  test("the alarm is idempotent — a resolved session is not clobbered", async () => {
    const { stub } = newSession();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(tictactoe({ turnTimeoutMs: 1000 }), "x"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("o"));
    const move = (p: string, r: number, c: number) =>
      runInDurableObject(stub, (s: MultiplayerSession) => s.action(p, { row: r, col: c }));
    await move("x", 0, 0);
    await move("o", 1, 0);
    await move("x", 0, 1);
    await move("o", 1, 1);
    await move("x", 0, 2); // x wins
    await runInDurableObject(stub, (s: MultiplayerSession) => s.alarm());
    const view = await runInDurableObject(stub, (s: MultiplayerSession) => s.view("x"));
    expect(view.phase).toBe("resolved");
    expect(view.outcome?.winnerUserId).toBe("x");
  });
});

describe("provably-fair randomness", () => {
  test("the seed hash is committed from the start and the seed is revealed only when terminal", async () => {
    const { stub } = newSession();
    const created = await runInDurableObject(stub, (s: MultiplayerSession) => s.create(tictactoe(), "x"));
    // Commitment present up front; the seed itself is withheld while live.
    expect(created.fairness.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.fairness.seed).toBeNull();

    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("o"));
    const move = (p: string, r: number, c: number) =>
      runInDurableObject(stub, (s: MultiplayerSession) => s.action(p, { row: r, col: c }));
    await move("x", 0, 0);
    await move("o", 1, 0);
    await move("x", 0, 1);
    await move("o", 1, 1);
    const done = await move("x", 0, 2); // x wins → terminal

    // Now the seed is revealed and verifiably matches the commitment.
    expect(done.fairness.seed).toMatch(/^[0-9a-f]{32}$/);
    const seedBytes = Uint8Array.from((done.fairness.seed?.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seedBytes));
    expect([...digest].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(done.fairness.seedHash);
  });
});

describe("leaderboard publish is best-effort", () => {
  test("a failing publish (no leaderboard table) still resolves and records the result", async () => {
    const { id, stub } = newSession();
    const game = battle({
      leaderboard: { board: "wins", direction: "desc", aggregation: "sum", points: { win: 3, draw: 1, loss: 0 } },
    });
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("alice", { offense: ["fire", "ice", "wind"], defense: ["guard-fire", "guard-ice", "guard-wind"] }),
    );
    const done = await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("bob", { offense: ["ice", "wind", "stone"], defense: ["guard-ice", "guard-wind", "guard-stone"] }),
    );
    expect(done.phase).toBe("resolved");
    const stored = await resultStore(multiplayerDatabase(env.DB)).get(id.toString());
    expect(stored?.status).toBe("resolved");
  });
});
