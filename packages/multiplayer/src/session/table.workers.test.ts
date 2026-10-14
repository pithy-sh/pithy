// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MULTIPLAYER_MIGRATION_ORDER, multiplayer } from "../capability";
import type { LedgerEffect } from "../game/effects";
import { type GameModel, registerGameModel } from "../game/model";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { MultiplayerSession } from "./durableObject";
import { USER_HEADER } from "./protocol";
import type { GameSnapshot } from "./state";

// The composition an adopter's `createEntrypoint` performs at load (#645): every capability's `compose` hook over
// the whole set. It is what hands the session its ledger and its leaderboard, which the session never imports;
// the Durable Object runs in this isolate, so it reads what this composed.
const composed = [
  ledger({ currencies: [{ code: "chips", name: "Chips" }] }),
  leaderboard({ boards: [{ key: "wins", direction: "desc", aggregation: "sum" }] }),
  multiplayer({ games: [{ key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }] }),
];
for (const capability of composed) capability.compose?.({ capabilities: composed });

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
    const effects: LedgerEffect[] = [
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
  resolve: (_ctx) => ({ outcome: { scores: {}, winnerUserId: null, draw: false } }),
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
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", CUR, 100, "seed-a");
    await ledger.credit("bob", CUR, 100, "seed-b");

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
    expect((await ledger.balance(winner1, CUR)).balance).toBe(110);
    const loser1 = winner1 === "alice" ? "bob" : "alice";
    expect((await ledger.balance(loser1, CUR)).balance).toBe(90);

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
    await openLedger(env.DB).credit("alice", CUR, 100, "seed-a");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    const afterLeave = await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("alice"));
    expect(afterLeave.phase).toBe("resolved"); // empty table closed
  });

  test("the session remembers everyone who ever joined, across a leave, and reads only for them", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", CUR, 100, "seed-a");
    await ledger.credit("bob", CUR, 100, "seed-b");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));

    // A stranger's leave is a refusal, not an idempotent view of the table.
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.leave("mallory"))).rejects.toThrow(
      /not_a_member/,
    );

    await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("bob"));
    // The leaver is out of the live view, and a retried leave is idempotent without showing the table.
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.view("bob"))).rejects.toThrow(/not_a_member/);
    const retried = await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("bob"));
    expect(retried).toMatchObject({ phase: "active", players: [], outcome: null, state: null });

    await runInDurableObject(stub, (s: MultiplayerSession) => s.close("alice"));
    // The result row names only the members at the end, so the session's own record is what admits bob.
    const forBob = await runInDurableObject(stub, (s: MultiplayerSession) => s.result("bob"));
    expect(forBob?.players).toEqual(["alice"]);
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.result("mallory"))).rejects.toThrow(
      /not_a_member/,
    );
  });

  test("leaving closes the leaver's socket, and no later state reaches it", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", CUR, 100, "seed-a");
    await ledger.credit("bob", CUR, 100, "seed-b");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));

    const res = await stub.fetch(
      new Request("https://do/socket", { headers: { upgrade: "websocket", [USER_HEADER]: "bob" } }),
    );
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    const frames: string[] = [];
    ws.addEventListener("message", (event) => {
      frames.push(event.data as string);
    });
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
    ws.accept();

    await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("bob"));
    expect(await closed).toBe(1000);
    const seen = frames.length;
    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", {}));
    expect(frames.length).toBe(seen);
    expect(await runInDurableObject(stub, (s: MultiplayerSession) => s.connectedUserIds())).toEqual([]);
  });

  test("a session from before the record still admits a player who leaves it", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", CUR, 100, "seed-a");
    await ledger.credit("bob", CUR, 100, "seed-b");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    // Stored as a kit without `joined` stored it.
    await runInDurableObject(stub, async (_s: MultiplayerSession, state) => {
      const { joined: _joined, ...legacy } = (await state.storage.get("meta")) as Record<string, unknown>;
      await state.storage.put("meta", legacy);
    });

    await runInDurableObject(stub, (s: MultiplayerSession) => s.leave("bob"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.close("alice"));
    expect((await runInDurableObject(stub, (s: MultiplayerSession) => s.result("bob")))?.status).toBe("resolved");
  });

  test("a socket whose user is no longer a member gets no state, pushed or asked for", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", CUR, 100, "seed-a");
    await ledger.credit("bob", CUR, 100, "seed-b");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(table, "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
    const res = await stub.fetch(
      new Request("https://do/socket", { headers: { upgrade: "websocket", [USER_HEADER]: "bob" } }),
    );
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    const frames: string[] = [];
    ws.addEventListener("message", (event) => {
      frames.push(event.data as string);
    });
    ws.accept();
    await runInDurableObject(stub, (s: MultiplayerSession) => s.connectedUserIds()); // the snapshot has landed
    // Bob is off the roster while his socket stays open — the case where the close on leave did not land.
    await runInDurableObject(stub, async (_s: MultiplayerSession, state) => {
      const meta = (await state.storage.get("meta")) as { members: string[] };
      await state.storage.put("meta", { ...meta, members: ["alice"] });
    });
    const seen = frames.length;

    await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", {}));
    expect(frames.length).toBe(seen);

    const answer = new Promise<string>((resolve) =>
      ws.addEventListener("message", (event) => resolve(event.data as string), { once: true }),
    );
    ws.send(JSON.stringify({ type: "state" }));
    expect(await answer).toContain("multiplayer/not_a_member");
  });

  test("a stranger is refused as a stranger before the session says what mode it is", async () => {
    const match: GameSnapshot = {
      ...table,
      kind: "connect-n",
      mode: "match",
      players: 2,
      rules: { rows: 3, cols: 3, connect: 3 },
    };
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(match, "x"));
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.leave("mallory"))).rejects.toThrow(
      /not_a_member/,
    );
    await expect(runInDurableObject(stub, (s: MultiplayerSession) => s.close("mallory"))).rejects.toThrow(
      /not_a_member/,
    );
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
