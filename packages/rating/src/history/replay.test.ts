// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { RatingAlgorithm } from "../algorithm/algorithm";
import type { ResolvedRatingGame } from "../config/config";
import type { RatingOutcome, RatingOutcomePlayer } from "../data/outcome";
import type { RatingRecord } from "../data/rating";
import type { AppliedOutcome, RatingStore } from "../data/store";
import { recordOutcome } from "../record/record";
import { type ReplayHistory, replayPlayer } from "./replay";

/**
 * The replay, without D1. The workers suite proves the same thing end to end against each built-in
 * algorithm; this proves the walk itself — what it skips, where it starts, and when it refuses — with an
 * algorithm whose every step depends on the opponent's state, so a replay that fed an opponent the wrong
 * state would land somewhere else.
 */

type Stub = { n: number };
const Coupled: RatingAlgorithm<Stub, Record<string, never>> = {
  id: "coupled",
  params: z.object({}).describe("No parameters."),
  state: z.object({ n: z.number().describe("The stub's number.") }).describe("The stub's state."),
  minPlayers: 2,
  maxPlayers: 2,
  supportsTeams: false,
  initial: () => ({ n: 100 }),
  update: (_params, entries, outcome) => {
    const [a, b] = entries;
    if (!a || !b) throw new Error("two players");
    const delta = (winner: Stub, loser: Stub) => 10 + Math.round((loser.n - winner.n) / 7);
    const aWon = (outcome.ranks[a.playerId] ?? 0) < (outcome.ranks[b.playerId] ?? 0);
    const d = aWon ? delta(a.state, b.state) : delta(b.state, a.state);
    return aWon
      ? { [a.playerId]: { n: a.state.n + d }, [b.playerId]: { n: b.state.n - d } }
      : { [a.playerId]: { n: a.state.n - d }, [b.playerId]: { n: b.state.n + d } };
  },
  skill: (_params, state) => state.n,
};

const DUEL: ResolvedRatingGame = {
  algorithm: Coupled as RatingAlgorithm,
  params: {},
  game: {
    key: "duel",
    algorithm: "coupled",
    players: 2,
    teams: false,
    hideSkill: false,
    sharedRoomCounts: false,
    pool: "duel",
    xp: { win: 20, draw: 10, loss: 5 },
  } as ResolvedRatingGame["game"],
};

/** A store that keeps the log the way D1 does — ids rising, a participant row per player. */
function loggingStore() {
  const rows = new Map<string, RatingRecord>();
  const outcomes: RatingOutcome[] = [];
  const players: RatingOutcomePlayer[] = [];
  const store: RatingStore = {
    async get(pool, userId) {
      return rows.get(`${pool}:${userId}`);
    },
    async getMany(pool, userIds) {
      return userIds.map((id) => rows.get(`${pool}:${id}`)).filter((row): row is RatingRecord => row !== undefined);
    },
    async upsert(record) {
      rows.set(`${record.pool}:${record.userId}`, record);
    },
    async apply(outcome: AppliedOutcome, records) {
      const id = outcomes.length + 1;
      outcomes.push({
        id,
        pool: outcome.pool,
        game: outcome.game,
        resultId: outcome.resultId,
        ranks: outcome.ranks,
        teams: outcome.teams,
        sharedRoom: outcome.sharedRoom,
        voidedAt: null,
        at: outcome.at,
      });
      for (const player of outcome.players) {
        players.push({ id: players.length + 1, outcomeId: id, pool: outcome.pool, ...player });
      }
      for (const record of records) rows.set(`${record.pool}:${record.userId}`, record);
    },
  };
  /** What a replay of `userId` is handed, read off the log as the D1 reads would. */
  const history = (userId: string, floorEntry?: number): ReplayHistory => {
    const entries = players.filter((row) => row.userId === userId);
    const ids = new Set(entries.map((row) => row.outcomeId));
    return {
      entries,
      outcomes: new Map(outcomes.filter((row) => ids.has(row.id)).map((row) => [row.id, row])),
      participants: players.filter((row) => ids.has(row.outcomeId)),
      floorEntry,
    };
  };
  return { store, rows, outcomes, players, history };
}

const at = new Date("2026-10-01T00:00:00.000Z");
const resolve = (key: string) => (key === "duel" ? DUEL : undefined);

describe("replayPlayer", () => {
  test("lands exactly where live application did, opponents' states and all", async () => {
    const log = loggingStore();
    const games: [string, string][] = [
      ["ada", "bob"],
      ["bob", "cy"],
      ["ada", "cy"],
      ["cy", "ada"],
      ["bob", "ada"],
    ];
    for (const [winner, loser] of games) {
      await recordOutcome(log.store, DUEL, { ranks: { [winner]: 1, [loser]: 2 }, at });
    }
    for (const userId of ["ada", "bob", "cy"]) {
      const live = log.rows.get(`duel:${userId}`);
      const replayed = replayPlayer({ userId, pool: DUEL, resolve, history: log.history(userId) });
      expect(replayed, userId).toEqual({
        algorithm: "coupled",
        state: live?.state,
        skill: live?.skill,
        xp: live?.xp,
        games: live?.games,
      });
    }
  });

  test("a voided outcome moves nothing: no skill, no experience, no game", async () => {
    const log = loggingStore();
    await recordOutcome(log.store, DUEL, { ranks: { ada: 1, bob: 2 }, at });
    await recordOutcome(log.store, DUEL, { ranks: { ada: 1, bob: 2 }, at });
    const second = log.outcomes[1];
    if (second) second.voidedAt = at;

    const replayed = replayPlayer({ userId: "ada", pool: DUEL, resolve, history: log.history("ada") });
    expect(replayed).toEqual({ algorithm: "coupled", state: { n: 110 }, skill: 110, xp: 20, games: 1 });
  });

  test("a reset is a floor: skill replays from the starting state, experience and games still count", async () => {
    const log = loggingStore();
    await recordOutcome(log.store, DUEL, { ranks: { ada: 1, bob: 2 }, at });
    const floor = log.players.length;
    // Live, the reset returned ada to the starting state and kept her experience and game count.
    const ada = log.rows.get("duel:ada");
    if (ada) log.rows.set("duel:ada", { ...ada, state: { n: 100 }, skill: 100 });
    await recordOutcome(log.store, DUEL, { ranks: { ada: 1, bob: 2 }, at });

    const live = log.rows.get("duel:ada");
    const replayed = replayPlayer({ userId: "ada", pool: DUEL, resolve, history: log.history("ada", floor) });
    expect(replayed.state).toEqual(live?.state);
    expect(replayed.xp).toBe(40);
    expect(replayed.games).toBe(2);
  });

  test("a rating older than its log starts from the standing its first logged game found", async () => {
    const log = loggingStore();
    log.rows.set("duel:ada", {
      id: 1,
      pool: "duel",
      userId: "ada",
      algorithm: "coupled",
      state: { n: 140 },
      skill: 140,
      xp: 75,
      games: 9,
      updatedAt: at,
    });
    await recordOutcome(log.store, DUEL, { ranks: { ada: 2, bob: 1 }, at });

    const live = log.rows.get("duel:ada");
    const replayed = replayPlayer({ userId: "ada", pool: DUEL, resolve, history: log.history("ada") });
    expect(replayed).toEqual({ algorithm: "coupled", state: live?.state, skill: live?.skill, xp: 80, games: 10 });
  });

  test("an outcome whose game is gone replays with the pool's algorithm", async () => {
    const log = loggingStore();
    await recordOutcome(log.store, DUEL, { ranks: { ada: 1, bob: 2 }, at });
    const replayed = replayPlayer({ userId: "ada", pool: DUEL, resolve: () => undefined, history: log.history("ada") });
    expect(replayed.skill).toBe(log.rows.get("duel:ada")?.skill);
  });

  test("a player with no logged outcome is refused, naming that the rating predates its history", () => {
    const empty: ReplayHistory = { entries: [], outcomes: new Map(), participants: [] };
    expect(() => replayPlayer({ userId: "ada", pool: DUEL, resolve, history: empty })).toThrow(/predates its history/);
  });
});
