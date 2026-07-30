// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { RatingAlgorithm } from "../algorithm/algorithm";
import { algorithmBounds, registeredAlgorithmIds, resolveAlgorithm } from "../algorithm/registry";
import {
  RatingInvalidParamsError,
  RatingUnknownAlgorithmError,
  RatingUnsupportedPlayerCountError,
} from "../error/errors";

/**
 * The rating capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field is
 * `.describe()`d: the descriptions feed the self-documenting CLI (CLAUDE.md §Config).
 *
 * A game names a rating **algorithm** by id (`elo`, `glicko`, `trueskill`, or one an adopter registered),
 * carries that algorithm's own `algoParams` tuning, and points at a named **pool** it reads and writes.
 * The tracker holds two distinct numbers per player per pool — a skill rating (MMR, the matchmaking
 * input) and a monotonic experience total (XP, the visible progression). This config is validated at
 * assembly by {@link validateRatingGames}, the same way multiplayer's `validateGames` rejects a bad game.
 */

/** A game key / pool name is a URL path segment, so it is kebab-case and lowercase. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const RatingXpAward = z
  .object({
    win: z.number().nonnegative().describe("Experience the winner is awarded."),
    draw: z.number().nonnegative().describe("Experience each player is awarded on a draw."),
    loss: z
      .number()
      .nonnegative()
      .describe("Experience a non-winner is awarded — often 0, but a participation point is fine."),
  })
  .describe("Experience awarded per outcome, folded into each player's monotonic XP total.");
export type RatingXpAward = z.output<typeof RatingXpAward>;

export const RatingLevel = z
  .object({
    key: z.string().min(1).describe("The level's stable id — a rank label like `bronze` or `veteran`."),
    from: z
      .number()
      .int()
      .nonnegative()
      .describe("The XP total at which this level begins. Levels list worst to best."),
  })
  .describe("One rung of the XP level ladder — the label a player earns once their XP total reaches `from`.");
export type RatingLevel = z.output<typeof RatingLevel>;

export const RatingGame = z
  .object({
    key: z
      .string()
      .regex(KEY_PATTERN, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe(
        "The game's stable id, unique across the app. It is a URL path segment and the outcome's game reference.",
      ),
    algorithm: z
      .string()
      .min(1)
      .describe(
        "Which rating algorithm rates this game: a built-in (`elo` — 1v1, transparent; `glicko` — Glicko-2, 1v1 with uncertainty; `trueskill` — any format, teams) or an id registered with `registerRatingAlgorithm`.",
      ),
    algoParams: z
      .unknown()
      .optional()
      .describe(
        "The chosen algorithm's tuning block (K-factor, volatility constraint, prior μ/σ). Validated at assembly by the algorithm; omit to take its defaults.",
      ),
    players: z
      .number()
      .int()
      .min(2)
      .default(2)
      .describe(
        "How many players a rated result of this game has (default 2). The chosen algorithm constrains the range — `elo`/`glicko` are 1v1 only, `trueskill` is any count.",
      ),
    teams: z
      .boolean()
      .default(false)
      .describe(
        "Whether a result carries a team grouping, so the rating pools each team's skill. Only `trueskill` supports teams; wiring it to another algorithm fails at assembly.",
      ),
    pool: z
      .string()
      .regex(KEY_PATTERN, "A pool name is lowercase, digits, and dashes.")
      .optional()
      .describe(
        "The rating pool this game reads and writes. Defaults to the game key (a rating per game). Set a shared name (e.g. `global`) to pool ratings across several games or modes.",
      ),
    sharedRoomCounts: z
      .boolean()
      .default(false)
      .describe(
        "Whether games played in a shared room with a friend count toward the ranked ladder (XP / rank). Off by default, so friends cannot farm each other to climb. Skill rating (MMR) always updates from a real result regardless of this flag.",
      ),
    hideSkill: z
      .boolean()
      .default(false)
      .describe(
        "Whether the skill rating (MMR) is hidden from players. When on, a player-facing read returns XP, rank, and games but not the raw skill number; matchmaking still uses it internally.",
      ),
    xp: RatingXpAward.optional().describe(
      "Experience awarded per outcome. Omit for a game that grants no XP (rating only).",
    ),
    levels: z
      .array(RatingLevel)
      .optional()
      .describe("An optional XP level ladder, listed worst to best, deriving a rank/level from the XP total."),
  })
  .describe("One rated game: its algorithm, roster, pool, and experience awards.");
export type RatingGame = z.output<typeof RatingGame>;

export const RatingConfig = z
  .object({
    games: z
      .array(RatingGame)
      .min(1, "A rating capability needs at least one game — configure at least one.")
      .describe("The rated games. Each names an algorithm, a pool, and its experience awards."),
    serverAuthoritative: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), recording an outcome requires the record scope — only a trusted server may write ratings. A client cannot report that it won.",
      ),
    recordScope: z
      .string()
      .min(1)
      .default("rating:record")
      .describe("The scope a caller must hold to record an outcome when `serverAuthoritative` is on."),
  })
  .describe("The rating capability's configuration — its games and how outcomes are authorized.")
  .check((ctx) => {
    const seen = new Set<string>();
    for (const game of ctx.value.games) {
      if (seen.has(game.key)) {
        ctx.issues.push({
          code: "custom",
          input: game.key,
          path: ["games"],
          message: `Duplicate game key "${game.key}" — each game key must be unique.`,
        });
      }
      seen.add(game.key);
    }
  });
export type RatingConfig = z.output<typeof RatingConfig>;
export type RatingConfigInput = z.input<typeof RatingConfig>;

/** A game whose algorithm is resolved and whose params are parsed — the runtime-ready form. */
export interface ResolvedRatingGame {
  /** The game's config (with `pool` defaulted to the key). */
  game: RatingGame & { pool: string };
  /** The resolved algorithm instance. */
  algorithm: RatingAlgorithm;
  /** The parsed, defaulted algorithm params. */
  params: unknown;
}

/**
 * Validate every game against the algorithm registry — the assembly-time gate, mirroring multiplayer's
 * `validateGames`. An unknown algorithm, a roster outside the algorithm's supported player count, a team
 * format on an algorithm that cannot rate teams, or invalid `algoParams` all fail here, on deploy, not on
 * the first recorded game. Requires the built-ins (or an adopter's algorithms) to be registered first.
 */
export function validateRatingGames(config: RatingConfig): ResolvedRatingGame[] {
  return config.games.map((game) => {
    const algorithm = resolveAlgorithm(game.algorithm);
    if (!algorithm) {
      throw new RatingUnknownAlgorithmError({
        message: `Game "${game.key}" uses unknown algorithm "${game.algorithm}".`,
        action: `Use one of: ${registeredAlgorithmIds().join(", ") || "(none registered)"}, or register one with registerRatingAlgorithm().`,
        detail: `No rating algorithm registered for id "${game.algorithm}".`,
      });
    }
    assertPlayerCount(game, algorithm);
    if (game.teams && !algorithm.supportsTeams) {
      throw new RatingUnsupportedPlayerCountError({
        message: `Game "${game.key}" is a team format, but "${algorithm.id}" cannot rate teams.`,
        action: "Use `trueskill` for team games.",
        detail: `Algorithm "${algorithm.id}" has supportsTeams=false.`,
      });
    }
    const params = parseParams(game, algorithm);
    return { game: { ...game, pool: game.pool ?? game.key }, algorithm, params };
  });
}

/** The roster size must fall within the algorithm's supported range. */
function assertPlayerCount(game: RatingGame, algorithm: RatingAlgorithm): void {
  const { min, max } = algorithmBounds(algorithm);
  if (game.players < min || game.players > max) {
    const upper = max === Number.POSITIVE_INFINITY ? "" : `–${max}`;
    throw new RatingUnsupportedPlayerCountError({
      message: `Game "${game.key}" sets ${game.players} players, but "${algorithm.id}" supports ${min}${upper}.`,
      action: "Use `trueskill` for N-player or team games; `elo` and `glicko` are 1v1 only.",
      detail: `Algorithm "${algorithm.id}" player bounds [${min}, ${max}] exclude ${game.players}.`,
    });
  }
}

/** Parse the `algoParams` block against the algorithm's schema, surfacing a Zod failure as a config error. */
function parseParams(game: RatingGame, algorithm: RatingAlgorithm): unknown {
  const parsed = algorithm.params.safeParse(game.algoParams ?? {});
  if (!parsed.success) {
    throw new RatingInvalidParamsError({
      message: `Game "${game.key}" has invalid algoParams for "${algorithm.id}".`,
      action: "Fix the game's `algoParams` block in pithy.config.ts.",
      detail: `algoParams failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.`,
    });
  }
  return parsed.data;
}

/** The resolved game for a key, or undefined. */
export function resolveGame(games: readonly ResolvedRatingGame[], key: string): ResolvedRatingGame | undefined {
  return games.find((g) => g.game.key === key);
}

/** Every distinct pool name the configured games read or write. */
export function configuredPools(games: readonly ResolvedRatingGame[]): string[] {
  return [...new Set(games.map((g) => g.game.pool))];
}
