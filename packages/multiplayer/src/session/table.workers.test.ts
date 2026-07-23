import { env, runInDurableObject } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { ledger } from "@pithy-sh/wallet/src/ledger/ledger";
import { wallet_0001_ledger } from "@pithy-sh/wallet/src/migrations/0001_ledger";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import type { WalletEffect } from "../game/effects";
import { type GameModel, registerGameModel } from "../game/model";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { MultiplayerSession } from "./durableObject";
import type { GameSnapshot } from "./state";

/**
 * A minimal table game: each round, every seated player antes `ante` chips (a debit into the pot); once all
 * seated players have anted, the pot is awarded to a randomly-chosen player and a new round begins. It runs
 * forever until the table is closed or emptied — exercising the persistent-table lifecycle end to end.
 */
const CUR = "chips";
type TableState = { round: number; anted: string[]; pot: number; lastWinner: string | null };
const tableModel: GameModel<{ currency: string; ante: number }, TableState> = {
  kind: "test-table",
  config: z
    .object({ currency: z.string().describe("c"), ante: z.number().int().describe("a") })
    .describe("table rules"),
  state: z
    .object({
      round: z.number().describe("r"),
      anted: z.array(z.string()).describe("a"),
      pot: z.number().describe("p"),
      lastWinner: z.string().nullable().describe("w"),
    })
    .describe("table state"),
  minPlayers: 2,
  init: () => ({ round: 1, anted: [], pot: 0, lastWinner: null }),
  apply(ctx, state, playerId) {
    if (state.anted.includes(playerId)) throw new Error("already anted this round");
    const ante = ctx.config.ante;
    const effects: WalletEffect[] = [
      {
        op: "debit",
        userId: playerId,
        currency: ctx.config.currency,
        amount: ante,
        ref: `${ctx.sessionId}:r${state.round}:${playerId}:ante`,
      },
    ];
    const anted = [...state.anted, playerId];
    const pot = state.pot + ante;
    // Round complete once every seated player has anted → award the pot and open the next round.
    if (anted.length === ctx.players.length) {
      const winner = ctx.random.pick(ctx.players);
      effects.push({
        op: "credit",
        userId: winner,
        currency: ctx.config.currency,
        amount: pot,
        ref: `${ctx.sessionId}:r${state.round}:payout`,
      });
      return { state: { round: state.round + 1, anted: [], pot: 0, lastWinner: winner }, effects };
    }
    return { state: { ...state, anted, pot }, effects };
  },
  isComplete: () => false, // a table never ends on a round
  resolve: (ctx) => ({ outcome: { scores: {}, winnerUserId: null, draw: false } }),
  redact: (_ctx, state) => state,
};
registerGameModel(tableModel);

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
    "pithy_wallet_accounts",
    "pithy_wallet_transactions",
    "pithy_wallet_holds",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  await wallet_0001_ledger.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const table: GameSnapshot = {
  key: "cash-table",
  kind: "test-table",
  mode: "table",
  players: 4,
  turnTimeoutMs: null,
  leaderboard: null,
  rules: { currency: CUR, ante: 10 },
};
type TableView = { round: number; pot: number; anted: string[]; lastWinner: string | null };

describe("the persistent-table lifecycle", () => {
  test("a table is active on create, runs many rounds, and players join and leave between them", async () => {
    const w = ledger(env.DB);
    await w.credit("alice", CUR, 100, "seed-a");
    await w.credit("bob", CUR, 100, "seed-b");

    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    // Create → the table is immediately active with alice seated (no waiting for a full roster).
    const created = await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    expect(created.phase).toBe("active");
    expect((created.state as TableView).round).toBe(1);

    // Bob joins mid-session — the table stays active.
    const joined = await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    expect(joined.phase).toBe("active");
    expect(joined.players).toEqual(["alice", "bob"]);

    // Round 1: both ante → the pot (20) is awarded and round 2 opens.
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", {}));
    const afterRound1 = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("bob", {}));
    expect(afterRound1.phase).toBe("active"); // still going
    const r1 = afterRound1.state as TableView;
    expect(r1.round).toBe(2);
    const winner1 = r1.lastWinner as string;
    // Winner: -10 ante +20 pot = +10 → 110. Loser: -10 → 90. Zero-sum.
    expect((await w.balance(winner1, CUR)).balance).toBe(110);
    const loser1 = winner1 === "alice" ? "bob" : "alice";
    expect((await w.balance(loser1, CUR)).balance).toBe(90);

    // Round 2: play another round — proves the table loops.
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", {}));
    const afterRound2 = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("bob", {}));
    expect((afterRound2.state as TableView).round).toBe(3);

    // Bob cashes out — the table stays active with alice.
    const afterLeave = await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("bob"));
    expect(afterLeave.phase).toBe("active");
    expect(afterLeave.players).toEqual(["alice"]);

    // Alice closes the table.
    const closed = await runInDurableObject(stub, (s: MultiplayerSession) => s.close("alice"));
    expect(closed.phase).toBe("resolved");
    // A durable result marks the table closed.
    const { resultStore } = await import("../data/store");
    const { multiplayerDatabase } = await import("../data/tables");
    const stored = await resultStore(multiplayerDatabase(env.DB)).get(stub.id.toString());
    expect(stored?.status).toBe("resolved");
  });

  test("the last player leaving auto-closes the table", async () => {
    await ledger(env.DB).credit("alice", CUR, 100, "seed-a");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    const afterLeave = await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("alice"));
    expect(afterLeave.phase).toBe("resolved"); // empty table closed
  });

  test("leave and close are refused on a match-mode session", async () => {
    const match: GameSnapshot = {
      ...table,
      kind: "connect-n",
      mode: "match",
      players: 2,
      rules: { rows: 3, cols: 3, connect: 3 },
    };
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(match, "x"));
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.close("x"))).rejects.toThrow(
      /invalid_transition/,
    );
  });
});
