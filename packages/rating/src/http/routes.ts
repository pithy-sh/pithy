// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import type { RatingConfig, ResolvedRatingGame } from "../config/config";
import { resolveGame } from "../config/config";
import { ratingStore } from "../data/store";
import { ratingDatabase } from "../data/tables";
import { RatingGameNotFoundError } from "../error/errors";
import { classifyLevel } from "../experience/xp";
import { recordOutcome } from "../record/record";
import { requireAuth, requireRecordScope } from "./guard";
import { RatingGameParams, RatingPlayerParams, RecordOutcomeBody } from "./schemas";

/**
 * The rating capability's HTTP surface. Three routes, every one `requireAuth()`-gated — there is no
 * public surface:
 *
 * | Method | Path                                  | Strategy            | Validates |
 * |--------|---------------------------------------|---------------------|-----------|
 * | POST   | /rating/games/:game/outcomes          | bearer \| session + record scope | param `RatingGameParams`, json `RecordOutcomeBody` |
 * | GET    | /rating/games/:game/me                | bearer \| session   | param `RatingGameParams` |
 * | GET    | /rating/games/:game/players/:userId   | bearer \| session   | param `RatingPlayerParams` |
 *
 * Validators run **after** the guards, so an unauthenticated or unscoped caller is still denied 401/403
 * whatever it sends. A param schema bounds the segment's shape only — resolving the key against the
 * configured games stays in the handler, and an unknown game is still a `rating/game_not_found` 404.
 *
 * Recording is server-authoritative by default: a client cannot report a win. Reads honor the game's
 * `hideSkill` flag — a hidden rating returns XP, rank, and games but a `null` skill number.
 */
export interface RatingRoutesOptions {
  /** The resolved, validated games. */
  games: readonly ResolvedRatingGame[];
  /** The resolved config (for auth mode + scope). */
  config: RatingConfig;
  /** Mount the routes somewhere other than `/rating`. */
  basePath?: string;
}

/** A player-facing view of a standing. `skill` is null when the game hides it. */
interface RatingView {
  pool: string;
  userId: string;
  skill: number | null;
  xp: number;
  level: string | null;
  games: number;
  provisional: boolean;
}

export function registerRatingRoutes(options: RatingRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/rating";
  const { games, config } = options;

  return (app) => {
    app.post(
      `${base}/games/:game/outcomes`,
      requireAuth(),
      requireRecordScope(config.serverAuthoritative, config.recordScope),
      zValidator("param", RatingGameParams, validationHook),
      zValidator("json", RecordOutcomeBody, validationHook),
      async (c) => {
        const resolved = game(games, c.req.valid("param").game);
        const body = c.req.valid("json");
        const recorded = await recordOutcome(ratingStore(ratingDatabase(dbOf(c))), resolved, {
          ranks: body.ranks,
          teams: body.teams,
          sharedRoom: body.sharedRoom,
          at: new Date(),
        });
        return c.json({ game: resolved.game.key, pool: resolved.game.pool, players: recorded }, 201);
      },
    );

    app.get(
      `${base}/games/:game/me`,
      requireAuth(),
      zValidator("param", RatingGameParams, validationHook),
      async (c) => {
        const resolved = game(games, c.req.valid("param").game);
        return c.json(await view(c, resolved, userId(c)));
      },
    );

    app.get(
      `${base}/games/:game/players/:userId`,
      requireAuth(),
      zValidator("param", RatingPlayerParams, validationHook),
      async (c) => {
        const params = c.req.valid("param");
        const resolved = game(games, params.game);
        return c.json(await view(c, resolved, params.userId));
      },
    );
  };
}

/** Build a player's view for a game's pool, applying the game's `hideSkill` flag. Provisional if unrated. */
async function view(c: Context<PithyHonoEnv>, resolved: ResolvedRatingGame, player: string): Promise<RatingView> {
  const { game: cfg, algorithm, params } = resolved;
  const record = await ratingStore(ratingDatabase(dbOf(c))).get(cfg.pool, player);
  const skill = record ? record.skill : algorithm.skill(params, algorithm.initial(params));
  const xp = record?.xp ?? 0;
  return {
    pool: cfg.pool,
    userId: player,
    skill: cfg.hideSkill ? null : skill,
    xp,
    level: cfg.levels ? classifyLevel(cfg.levels, xp) : null,
    games: record?.games ?? 0,
    provisional: record === undefined,
  };
}

function game(games: readonly ResolvedRatingGame[], key: string): ResolvedRatingGame {
  const resolved = resolveGame(games, key);
  if (!resolved) throw new RatingGameNotFoundError({ detail: `No game "${key}" is configured.` });
  return resolved;
}

function userId(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) throw new InternalError({ detail: "requireAuth() must run before a handler reads the user id." });
  return auth.userId;
}

function dbOf(c: Context<PithyHonoEnv>): D1Database {
  const db = c.env.DB as D1Database | undefined;
  if (!db) throw new InternalError({ detail: "The rating routes require a `DB` D1 binding." });
  return db;
}
