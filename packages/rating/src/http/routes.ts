// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { adjustRating } from "../admin/acts";
import { listPools, listRatings } from "../admin/read";
import { type RatingAuditAction, RatingAuditActions } from "../audit/actions";
import type { RatingConfig, ResolvedRatingGame } from "../config/config";
import { resolveGame, resolvePool } from "../config/config";
import type { RatingAdjustment, RatingAdjustmentAct } from "../data/adjustment";
import { outcomeLog } from "../data/log";
import { ratingStore } from "../data/store";
import { ratingDatabase } from "../data/tables";
import { RatingGameNotFoundError, RatingPoolNotFoundError } from "../error/errors";
import { classifyLevel } from "../experience/xp";
import { recordOutcome } from "../record/record";
import { requireAuth, requireRecordScope } from "./guard";
import {
  RatingAdjustmentResponse,
  RatingAdminPlayerResponse,
  RatingAdminPlayersResponse,
  RatingAdminPoolsResponse,
  RatingView,
  RecordedOutcome,
} from "./responses";
import {
  AdminAdjustBody,
  AdminPageQuery,
  AdminPlayerParams,
  AdminPoolParams,
  RatingGameParams,
  RatingPlayerParams,
  RecordOutcomeBody,
} from "./schemas";
import { RATING_PLAYERS_ADJUST_SCOPE, RATING_PLAYERS_READ_SCOPE } from "./scopes";
import { adjustmentView, outcomeView, ratingView } from "./view";

/**
 * The rating capability's HTTP surface. Three player routes, every one `requireAuth()`-gated — there is
 * no public surface — and five management routes behind the control plane (#818):
 *
 * | Method | Path                                                    | Strategy            | Validates |
 * |--------|---------------------------------------------------------|---------------------|-----------|
 * | POST   | /rating/games/:game/outcomes                            | bearer \| session + record scope | param `RatingGameParams`, json `RecordOutcomeBody` |
 * | GET    | /rating/games/:game/me                                  | bearer \| session   | param `RatingGameParams` |
 * | GET    | /rating/games/:game/players/:userId                     | bearer \| session   | param `RatingPlayerParams` |
 * | GET    | /rating/admin/pools                                     | control-plane: rating:players:read   | — |
 * | GET    | /rating/admin/pools/:pool/players                       | control-plane: rating:players:read   | param `AdminPoolParams`, query `AdminPageQuery` |
 * | GET    | /rating/admin/pools/:pool/players/:userId               | control-plane: rating:players:read   | param `AdminPlayerParams`, query `AdminPageQuery` |
 * | POST   | /rating/admin/pools/:pool/players/:userId/recalculate   | control-plane: rating:players:adjust | param `AdminPlayerParams`, json `AdminAdjustBody` |
 * | POST   | /rating/admin/pools/:pool/players/:userId/reset         | control-plane: rating:players:adjust | param `AdminPlayerParams`, json `AdminAdjustBody` |
 *
 * The management routes carry `requireControlPlane` and never `requireAuth()`: a management client is not
 * a player and has no session, so the player gate would deny it forever. Each act takes an idempotency key
 * and a reason, and emits one audit event — none for a replayed key, because nothing happened.
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

export function registerRatingRoutes(options: RatingRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/rating";
  const { games, config } = options;

  return (app) => {
    // The management surface: control plane only, under `admin/`, which no player route uses.

    app.get(
      `${base}/admin/pools`,
      describeRoute({
        summary: "List every rating pool, its algorithm, and the games that rate it.",
        verification: "control-plane",
        scopes: [RATING_PLAYERS_READ_SCOPE],
        responses: { 200: RatingAdminPoolsResponse },
      }),
      requireControlPlane(RATING_PLAYERS_READ_SCOPE),
      (c) => c.json({ pools: listPools(games) } satisfies RatingAdminPoolsResponse, 200),
    );

    app.get(
      `${base}/admin/pools/:pool/players`,
      describeRoute({
        summary: "List the ratings in one pool, highest skill first, a page at a time.",
        verification: "control-plane",
        scopes: [RATING_PLAYERS_READ_SCOPE],
        responses: { 200: RatingAdminPlayersResponse },
      }),
      requireControlPlane(RATING_PLAYERS_READ_SCOPE),
      validate("param", AdminPoolParams),
      validate("query", AdminPageQuery),
      async (c) => {
        const resolved = pool(games, c.req.valid("param").pool);
        const page = await listRatings(ratingDatabase(dbOf(c)), resolved.game.pool, c.req.valid("query"));
        return c.json(
          {
            pool: resolved.game.pool,
            players: page.items.map(ratingView),
            nextCursor: page.nextCursor,
          } satisfies RatingAdminPlayersResponse,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/pools/:pool/players/:userId`,
      describeRoute({
        summary: "Read one player's rating in a pool and the outcomes behind it, newest first.",
        verification: "control-plane",
        scopes: [RATING_PLAYERS_READ_SCOPE],
        responses: { 200: RatingAdminPlayerResponse },
      }),
      requireControlPlane(RATING_PLAYERS_READ_SCOPE),
      validate("param", AdminPlayerParams),
      validate("query", AdminPageQuery),
      async (c) => {
        const params = c.req.valid("param");
        const resolved = pool(games, params.pool);
        const db = ratingDatabase(dbOf(c));
        const record = await ratingStore(db).get(resolved.game.pool, params.userId);
        const page = await outcomeLog(db).playerPage(resolved.game.pool, params.userId, c.req.valid("query"));
        // A player with no rating is an answer, not a 404: the pool exists, and they have not played it.
        return c.json(
          {
            pool: resolved.game.pool,
            userId: params.userId,
            rating: record ? ratingView(record) : null,
            outcomes: page.items.map((row) => outcomeView(row, resolved)),
            nextCursor: page.nextCursor,
          } satisfies RatingAdminPlayerResponse,
          200,
        );
      },
    );

    for (const act of ["recalculate", "reset"] as const satisfies readonly RatingAdjustmentAct[]) {
      app.post(
        `${base}/admin/pools/:pool/players/:userId/${act}`,
        describeRoute({
          summary:
            act === "recalculate"
              ? "Rebuild one player's rating by replaying their logged outcomes."
              : "Return one player's rating to the algorithm's starting state.",
          description:
            act === "recalculate"
              ? "Refused when no outcome behind the rating was logged: a rating older than its history has nothing to replay."
              : "Experience and the game count are kept. A later recalculation replays from the reset, not through it.",
          verification: "control-plane",
          scopes: [RATING_PLAYERS_ADJUST_SCOPE],
          responses: { 200: RatingAdjustmentResponse },
        }),
        requireControlPlane(RATING_PLAYERS_ADJUST_SCOPE),
        validate("param", AdminPlayerParams),
        validate("json", AdminAdjustBody),
        async (c) => {
          const params = c.req.valid("param");
          const body = c.req.valid("json");
          const result = await adjustRating(
            ratingDatabase(dbOf(c)),
            games,
            {
              act,
              pool: pool(games, params.pool),
              userId: params.userId,
              idempotencyKey: body.idempotencyKey,
              reason: body.reason,
            },
            new Date(),
          );
          if (!result.replayed) {
            await emitAdjustment(
              c,
              act === "recalculate" ? RatingAuditActions.recalculated : RatingAuditActions.reset,
              result.adjustment,
            );
          }
          return c.json(adjustmentView(result.adjustment, result.replayed) satisfies RatingAdjustmentResponse, 200);
        },
      );
    }

    // The player surface: bearer or session.

    app.post(
      `${base}/games/:game/outcomes`,
      describeRoute({
        summary: "Record the result of a rated game.",
        description: "Requires the record scope while `serverAuthoritative` is on, which is the default.",
        verification: ["bearer", "session"],
        scopes: config.serverAuthoritative ? [config.recordScope] : [],
        responses: { 201: RecordedOutcome },
      }),
      requireAuth(),
      requireRecordScope(config.serverAuthoritative, config.recordScope),
      validate("param", RatingGameParams),
      validate("json", RecordOutcomeBody),
      async (c) => {
        const resolved = game(games, c.req.valid("param").game);
        const body = c.req.valid("json");
        const recorded = await recordOutcome(ratingStore(ratingDatabase(dbOf(c))), resolved, {
          ranks: body.ranks,
          teams: body.teams,
          sharedRoom: body.sharedRoom,
          ...(body.resultId === undefined ? {} : { resultId: body.resultId }),
          at: new Date(),
        });
        return c.json(
          { game: resolved.game.key, pool: resolved.game.pool, players: recorded } satisfies RecordedOutcome,
          201,
        );
      },
    );

    app.get(
      `${base}/games/:game/me`,
      describeRoute({
        summary: "Read the caller's own standing in a game.",
        verification: ["bearer", "session"],
        responses: { 200: RatingView },
      }),
      requireAuth(),
      validate("param", RatingGameParams),
      async (c) => {
        const resolved = game(games, c.req.valid("param").game);
        return c.json(await view(c, resolved, userId(c)));
      },
    );

    app.get(
      `${base}/games/:game/players/:userId`,
      describeRoute({
        summary: "Read another player's standing in a game.",
        verification: ["bearer", "session"],
        responses: { 200: RatingView },
      }),
      requireAuth(),
      validate("param", RatingPlayerParams),
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

/** The game that speaks for a pool, or the pool's 404. */
function pool(games: readonly ResolvedRatingGame[], name: string): ResolvedRatingGame {
  const resolved = resolvePool(games, name);
  if (!resolved) throw new RatingPoolNotFoundError({ detail: `No game rates a pool "${name}".` });
  return resolved;
}

/**
 * The verified management client behind a control-plane call. `requireControlPlane()` has run on every
 * route that calls this, so a null context is a wiring mistake rather than an unverified request.
 */
function controlPlaneCaller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const caller = c.var.controlPlane;
  if (!caller) {
    throw new InternalError({
      detail: "requireControlPlane() must run before a rating management handler reads the caller.",
    });
  }
  return caller;
}

/**
 * The audit event an act emits — the connection, the player, the act, the rating before and after, and the
 * reason verbatim. Severity `warning`: it rewrites somebody's standing with no game behind it.
 */
async function emitAdjustment(
  c: Context<PithyHonoEnv>,
  action: RatingAuditAction,
  adjustment: RatingAdjustment,
): Promise<void> {
  const caller = controlPlaneCaller(c);
  await c.var.emit({
    action,
    outcome: "success",
    severity: "warning",
    actorType: "control-plane",
    actorId: caller.subject,
    resourceType: "rating",
    resourceId: `${adjustment.pool}:${adjustment.userId}`,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: {
      connectionId: caller.connectionId,
      pool: adjustment.pool,
      userId: adjustment.userId,
      act: adjustment.act,
      reason: adjustment.reason,
      idempotencyKey: adjustment.idempotencyKey,
      before: adjustment.before,
      after: adjustment.after,
    },
  });
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
