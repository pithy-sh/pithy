// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * HTTP-boundary shapes for the rating routes. Declared on the route line with
 * `validate(target, Schema)`, so a malformed request becomes a
 * `validation/invalid_input` 400 before any handler runs, never an unhandled throw.
 *
 * The param schemas are **shape** checks, not existence checks: they bound what may reach a store or a
 * config lookup. Resolving a game key against the configured games stays in the handler, and an unknown
 * game is still a `rating/game_not_found` 404.
 */

/**
 * A game key is a URL path segment, so it is lowercase, digits, and dashes — the same shape
 * `RatingGame.key` enforces at config assembly. A key that cannot be configured cannot resolve, so
 * bounding the segment here rejects it a step earlier without narrowing what already works.
 */
const GAME_KEY = /^[a-z0-9][a-z0-9-]*$/;

export const RatingGameParams = z
  .object({
    game: z
      .string()
      .max(64)
      .regex(GAME_KEY, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The configured game the request addresses. Resolved against the games in the handler."),
  })
  .describe("The path params of a game-scoped rating route.");
export type RatingGameParams = z.output<typeof RatingGameParams>;

export const RatingPlayerParams = z
  .object({
    game: z
      .string()
      .max(64)
      .regex(GAME_KEY, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The configured game the request addresses. Resolved against the games in the handler."),
    userId: z
      .string()
      .min(1)
      .max(200)
      .describe("The player whose standing is read. Opaque to this capability — bounded, not parsed."),
  })
  .describe("The path params of a read of one player's standing in a game.");
export type RatingPlayerParams = z.output<typeof RatingPlayerParams>;

export const RecordOutcomeBody = z
  .object({
    ranks: z
      .record(z.string(), z.number().int().min(1))
      .describe("Each player's finishing place, keyed by user id — 1 is the winner, ties share a place."),
    teams: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional team grouping (player id → team id), for a team format."),
    sharedRoom: z
      .boolean()
      .optional()
      .describe("Whether the game was played in a shared room with a friend. Gates XP/rank, never the skill rating."),
    resultId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "The id of the result this outcome comes from — a multiplayer session result, or your own. Kept on the outcome log, so voiding the result takes this outcome back out of every rating it moved.",
      ),
  })
  .describe("The body of a record-outcome request — the result of one rated game.");
export type RecordOutcomeBody = z.output<typeof RecordOutcomeBody>;

// --- The control-plane management surface (#818) ---

/** A pool name, shape-checked. Whether a game configures it stays the handler's 404. */
const PoolName = z
  .string()
  .max(64)
  .regex(GAME_KEY, "A pool name is lowercase, digits, and dashes — it is a URL path segment.");

/** A player id as a path segment — opaque to rating, which never issues one. */
const PlayerId = z.string().min(1).max(200);

/** Where a keyset page resumes. Opaque; a malformed one is a first page rather than an error. */
const Cursor = z
  .string()
  .max(512)
  .optional()
  .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page.");

/** How many rows one page returns. */
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`How many rows to return, from 1 to ${MAX_PAGE_SIZE}. Defaults to a page a dashboard can render.`);

export const AdminPoolParams = z
  .object({
    pool: PoolName.describe(
      "The rating pool — the `:pool` path segment. A shape check only; a pool no game rates is the handler's 404.",
    ),
  })
  .describe("The `:pool` path segment on the pool-scoped management routes.");
export type AdminPoolParams = z.output<typeof AdminPoolParams>;

export const AdminPlayerParams = z
  .object({
    pool: PoolName.describe(
      "The rating pool — the `:pool` path segment. A shape check only; a pool no game rates is the handler's 404.",
    ),
    userId: PlayerId.describe("The player — the `:userId` path segment. Opaque to rating: bounded, not parsed."),
  })
  .describe("The `(pool, userId)` pair that addresses one rating — the key the ratings table is on.");
export type AdminPlayerParams = z.output<typeof AdminPlayerParams>;

export const AdminPageQuery = z
  .object({ cursor: Cursor, limit: Limit })
  .describe("Where a management listing resumes, and how much of it to return.");
export type AdminPageQuery = z.output<typeof AdminPageQuery>;

/** The longest reason an act records. A sentence or two for the audit trail, not a document. */
export const MAX_ADJUSTMENT_REASON_LENGTH = 500;

export const AdminAdjustBody = z
  .strictObject({
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "The client's key for this act. A retry with the same key changes nothing and answers with what the first request did; a key spent on a different act is refused.",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(MAX_ADJUSTMENT_REASON_LENGTH)
      .describe("Why — a dispute, a support ticket, a bug. Required, and recorded verbatim on the audit event."),
  })
  .describe("The body of a recalculate or reset: the act's idempotency key and the reason for it.");
export type AdminAdjustBody = z.output<typeof AdminAdjustBody>;
