// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { MultiplayerSession } from "../session/durableObject";
import type { GameSnapshot } from "../session/state";
import type { LedgerEffect } from "./effects";
import { type GameModel, registerGameModel } from "./model";

/**
 * A minimal wagering model, registered for this test: two players each stake `stake` chips (a hold placed
 * when they bet); when both have bet, the pot goes to `players[0]` — every loser's stake captured, the
 * winner's returned and the pot credited. It exercises the wager seam end to end: a model that touches no
 * database, only declares ledger effects the DO settles through `@pithy-sh/ledger`.
 */
const WAGER_CURRENCY = "chips";
const wagerModel: GameModel<{ currency: string; stake: number }, { bets: string[] }> = {
  kind: "test-wager",
  config: z
    .object({ currency: z.string().describe("c"), stake: z.number().int().describe("s") })
    .describe("wager rules"),
  state: z.object({ bets: z.array(z.string()).describe("who bet") }).describe("wager state"),
  minPlayers: 2,
  init: () => ({ bets: [] }),
  apply(ctx, state, playerId) {
    if (state.bets.includes(playerId)) throw new Error("already bet");
    const effects: LedgerEffect[] = [
      {
        op: "hold",
        userId: playerId,
        currency: ctx.config.currency,
        amount: ctx.config.stake,
        ref: `${ctx.sessionId}:${playerId}:stake`,
      },
    ];
    return { state: { bets: [...state.bets, playerId] }, effects };
  },
  isComplete: (ctx, state) => state.bets.length === ctx.players.length,
  resolve(ctx, state) {
    const winner = ctx.players[0] as string;
    const stake = ctx.config.stake;
    const effects: LedgerEffect[] = [];
    for (const player of state.bets) {
      const ref = `${ctx.sessionId}:${player}:stake`;
      if (player === winner) effects.push({ op: "release", ref });
      else effects.push({ op: "capture", ref });
    }
    effects.push({
      op: "credit",
      userId: winner,
      currency: ctx.config.currency,
      amount: stake * (ctx.players.length - 1),
      ref: `${ctx.sessionId}:payout`,
    });
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = p === winner ? 1 : 0;
    return { outcome: { scores, winnerUserId: winner, draw: false }, effects };
  },
  redact: (_ctx, state) => ({ bets: state.bets }),
};
registerGameModel(wagerModel);

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
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  for (const t of [
    "pithy_multiplayer_results",
    "pithy_ledger_accounts",
    "pithy_ledger_transactions",
    "pithy_ledger_holds",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  await ledger_0001_accounts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const game = (stake: number): GameSnapshot => ({
  key: "duel",
  kind: "test-wager",
  mode: "match",
  players: 2,
  turnTimeoutMs: null,
  leaderboard: null,
  rules: { currency: WAGER_CURRENCY, stake },
});

describe("the wager seam — a game settles bets through the ledger", () => {
  test("both stake, the winner takes the pot, the loser loses their stake", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", WAGER_CURRENCY, 100, "seed-alice");
    await ledger.credit("bob", WAGER_CURRENCY, 100, "seed-bob");

    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game(40), "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));

    // Alice bets → 40 held.
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", {}));
    expect(await ledger.balance("alice", WAGER_CURRENCY)).toEqual({ balance: 100, held: 40, available: 60 });

    // Bob bets → both in, the session resolves and settles.
    const done = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("bob", {}));
    expect(done.phase).toBe("resolved");
    expect(done.outcome?.winnerUserId).toBe("alice");

    // Alice (winner) kept her 100 and won bob's 40; bob lost his 40. Zero-sum, nothing held.
    expect(await ledger.balance("alice", WAGER_CURRENCY)).toEqual({ balance: 140, held: 0, available: 140 });
    expect(await ledger.balance("bob", WAGER_CURRENCY)).toEqual({ balance: 60, held: 0, available: 60 });
  });

  test("a bet a player cannot cover is rejected and the game does not advance", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", WAGER_CURRENCY, 100, "seed-alice");
    await ledger.credit("bob", WAGER_CURRENCY, 10, "seed-bob"); // bob is short

    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game(50), "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", {}));

    // Bob's stake of 50 exceeds his 10 → the action fails and the game stays active with only alice's bet.
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.action("bob", {}))).rejects.toThrow(
      /insufficient_funds/,
    );
    const view = await runInDurableObject(stub, (s: MultiplayerSession) => s.view("bob"));
    expect(view.phase).toBe("active");
    expect((view.state as { bets: string[] }).bets).toEqual(["alice"]); // bob's bet never recorded
    // Alice's hold is still in place; bob's balance is untouched.
    expect((await ledger.balance("bob", WAGER_CURRENCY)).held).toBe(0);
  });
});
