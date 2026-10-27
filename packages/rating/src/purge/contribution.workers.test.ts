// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import "../algorithm/builtins";
import { adjustRating } from "../admin/acts";
import { RATING_MIGRATION_ORDER, rating } from "../capability";
import { RatingConfig, resolveGame, resolvePool, validateRatingGames } from "../config/config";
import { ratingStore } from "../data/store";
import { ratingDatabase } from "../data/tables";
import { voidResult } from "../history/void";
import { rating_0001_rating } from "../migrations/0001_rating";
import { rating_0002_outcome_log } from "../migrations/0002_outcome_log";
import { recordOutcome } from "../record/record";
import { RATING_PURGE_SUMMARY, ratingUserPurge } from "./contribution";

/**
 * Rating's part of a person's purge and export (#814), over real D1: rows present, exported, purged,
 * gone — and nobody else's touched. The outcome log (#818) is anonymized rather than erased, so every
 * opponent's history still replays exactly.
 */

const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB } });
/** The contribution's export, which every kit contribution declares. */
async function exportOf(input: ReturnType<typeof context>): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

const purge = ratingUserPurge();

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "rating",
      order: RATING_MIGRATION_ORDER,
      migrations: { "0001_rating": rating_0001_rating, "0002_outcome_log": rating_0002_outcome_log },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

const TABLES = [
  "pithy_rating_ratings",
  "pithy_rating_outcomes",
  "pithy_rating_outcome_players",
  "pithy_rating_adjustments",
  "pithy_migrations",
  "pithy_migrations_lock",
];

const GAMES = validateRatingGames(
  RatingConfig.parse({
    games: [
      { key: "elo", algorithm: "elo", xp: { win: 20, draw: 10, loss: 5 } },
      { key: "teams", algorithm: "trueskill", players: 4, teams: true },
    ],
  }),
);
const db = () => ratingDatabase(env.DB);
const at = new Date("2026-10-20T12:00:00.000Z");

function game(key: string) {
  const found = resolveGame(GAMES, key);
  if (!found) throw new Error(`no game ${key}`);
  return found;
}

function pool(name: string) {
  const found = resolvePool(GAMES, name);
  if (!found) throw new Error(`no pool ${name}`);
  return found;
}

async function play(
  key: string,
  ranks: Record<string, number>,
  extra: { resultId?: string; teams?: Record<string, string> } = {},
) {
  return recordOutcome(ratingStore(db()), game(key), { ranks, at, ...extra });
}

async function count(table: string, column: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function raw(table: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all<Record<string, unknown>>()).results;
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await runMigrations(env.DB, provider());
  await play("elo", { ada: 1, bob: 2 }, { resultId: "r1" });
  await play("elo", { bob: 1, cy: 2 }, { resultId: "r2" });
  await play("elo", { ada: 1, cy: 2 }, { resultId: "r3" });
  await play("teams", { ada: 1, bob: 1, cy: 2, dee: 2 }, { teams: { ada: "a", bob: "a", cy: "b", dee: "b" } });
  await adjustRating(
    db(),
    GAMES,
    { act: "reset", pool: pool("elo"), userId: "ada", idempotencyKey: "key-ada", reason: "smurf" },
    at,
  );
  await adjustRating(
    db(),
    GAMES,
    { act: "reset", pool: pool("elo"), userId: "bob", idempotencyKey: "key-bob", reason: "smurf" },
    at,
  );
});

describe("the rating user purge", () => {
  test("rating() declares it for the user subject, with a summary and an export", () => {
    const declared = rating({ games: [{ key: "ranked", algorithm: "elo" }] }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(RATING_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the person's ratings, their outcomes and the acts on them, and no credential", async () => {
    const data = await exportOf(context("ada"));
    expect(data.ratings).toEqual([
      expect.objectContaining({ pool: "elo", userId: "ada" }),
      expect.objectContaining({ pool: "teams", userId: "ada" }),
    ]);
    const outcomes = data.outcomes as { resultId: string | null; ranks: Record<string, number> }[];
    expect(outcomes.map((outcome) => outcome.resultId)).toEqual(["r1", "r3", null]);
    expect(outcomes[0]?.ranks).toEqual({ ada: 1, bob: 2 });
    expect(data.outcomePlayers).toEqual([
      expect.objectContaining({ userId: "ada", pool: "elo" }),
      expect.objectContaining({ userId: "ada", pool: "elo" }),
      expect.objectContaining({ userId: "ada", pool: "teams" }),
    ]);
    expect(data.adjustments).toEqual([expect.objectContaining({ act: "reset", userId: "ada", reason: "smurf" })]);
    // The idempotency key is the operator's, not the person's.
    expect(JSON.stringify(data.adjustments)).not.toContain("key-ada");
    expect(credentialFields(data)).toEqual([]);
  });

  test("erases the ratings and the acts, and anonymizes the outcome log, leaving everyone else's", async () => {
    await purge.erase(context("ada"));
    expect(await count("pithy_rating_ratings", "user_id", "ada")).toBe(0);
    expect(await count("pithy_rating_adjustments", "user_id", "ada")).toBe(0);
    expect(await count("pithy_rating_outcome_players", "user_id", "ada")).toBe(0);
    expect(await exportOf(context("ada"))).toEqual({ ratings: [], outcomes: [], outcomePlayers: [], adjustments: [] });

    const outcomes = await raw("pithy_rating_outcomes");
    const players = await raw("pithy_rating_outcome_players");
    expect(JSON.stringify(outcomes)).not.toContain('"ada"');
    expect(JSON.stringify(players)).not.toContain('"ada"');

    // One stand-in per outcome, the same in the player row, the ranks and the teams.
    const standIns = players.map((row) => String(row.user_id)).filter((id) => id.startsWith("erased-"));
    expect(standIns).toHaveLength(3);
    expect(new Set(standIns).size).toBe(3);
    for (const id of standIns) expect(id).toMatch(/^erased-[0-9a-f-]{36}$/);
    for (const row of players.filter((player) => String(player.user_id).startsWith("erased-"))) {
      const outcome = outcomes.find((candidate) => candidate.id === row.outcome_id);
      expect(Object.keys(JSON.parse(String(outcome?.ranks)))).toContain(row.user_id);
      if (outcome?.teams) expect(JSON.parse(String(outcome.teams))[String(row.user_id)]).toBe("a");
    }

    expect(await count("pithy_rating_ratings", "user_id", "bob")).toBe(2);
    expect(await count("pithy_rating_adjustments", "user_id", "bob")).toBe(1);
    expect(JSON.stringify(await exportOf(context("bob")))).toContain("bob");
    const untouched = outcomes.find((outcome) => outcome.result_id === "r2");
    expect(JSON.parse(String(untouched?.ranks))).toEqual({ bob: 1, cy: 2 });
  });

  test("an opponent's recalculation still lands where live application left them", async () => {
    const elo = await ratingStore(db()).get("elo", "cy");
    const teams = await ratingStore(db()).get("teams", "cy");
    await purge.erase(context("ada"));
    const recalculated = await adjustRating(
      db(),
      GAMES,
      { act: "recalculate", pool: pool("elo"), userId: "cy", idempotencyKey: "key-cy", reason: "audit" },
      at,
    );
    expect(recalculated.adjustment.after.state).toEqual(elo?.state);
    const team = await adjustRating(
      db(),
      GAMES,
      { act: "recalculate", pool: pool("teams"), userId: "cy", idempotencyKey: "key-cy-teams", reason: "audit" },
      at,
    );
    expect(team.adjustment.after.state).toEqual(teams?.state);
  });

  test("a void after the purge recalculates the opponents and gives the erased player no rating back", async () => {
    await purge.erase(context("ada"));
    const report = await voidResult(db(), GAMES, "r1", at);
    expect(report.outcomes).toBe(1);
    expect(report.players.map((player) => player.userId)).toEqual(["bob"]);
    const ratings = await raw("pithy_rating_ratings");
    expect(ratings.some((row) => String(row.user_id).startsWith("erased-"))).toBe(false);
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    const once = await raw("pithy_rating_outcome_players");
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
    expect(await raw("pithy_rating_outcome_players")).toEqual(once);
  });
});
