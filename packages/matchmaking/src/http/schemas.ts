// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * What the matchmaking routes accept. Every schema here is named on a route line via
 * `validate(target, Schema)`, so reading `routes.ts` tells you the shape of a request
 * without opening a handler.
 *
 * Path params are **shape** checks, not existence checks. A game key, a room code, an invite id and a
 * user id are all bounded here so an unbounded string never reaches a store or a KV key; whether the
 * value *resolves* stays with the code that owns that answer — `resolveMatchmakingGame` still raises its
 * 404 for an unconfigured game, `normalizeCode` still raises `matchmaking/invalid_code` for a code that
 * is the wrong shape, and the invite store still raises `matchmaking/invite_not_found`. Building a param
 * schema out of the configured game keys would move a 404 to a 400 and leak the config to the caller.
 */

/** A game key on the path. Shape only — `resolveMatchmakingGame` owns the 404 for an unconfigured key. */
export const GameParams = z
  .object({
    game: z
      .string()
      .min(1)
      .max(64)
      .describe("The matchmaking game key from the path, resolved against the configured `games` list."),
  })
  .describe("The path params of a per-game route: which game the caller is addressing.");
export type GameParams = z.infer<typeof GameParams>;

/**
 * A room code on the path. Deliberately tolerant: `normalizeCode` uppercases, strips whitespace, and
 * accepts the dashless `WXYZ1234` as well as the canonical `WXYZ-1234`, so this is a length sanity bound
 * only. `normalizeCode` still runs and still throws `matchmaking/invalid_code` for a genuinely bad code.
 */
export const RoomCodeParams = z
  .object({
    code: z.string().min(1).max(32).describe("The shareable room code from the path, before normalization."),
  })
  .describe("The path params of the room-code join route.");
export type RoomCodeParams = z.infer<typeof RoomCodeParams>;

/** An invite id on the path. Invite ids are minted with `crypto.randomUUID()`, so the shape is a UUID. */
export const InviteParams = z
  .object({
    id: z.uuid().describe("The invite's UUID from the path — the externally-referenced invite id."),
  })
  .describe("The path params of an invite accept/decline route.");
export type InviteParams = z.infer<typeof InviteParams>;

/** The other user on a friend route. Auth user ids are opaque text, so this is a length bound only. */
export const FriendParams = z
  .object({
    userId: z.string().min(1).max(255).describe("The other user in the friendship, as an auth user id."),
  })
  .describe("The path params of a friend-graph route: whom the friendship is with.");
export type FriendParams = z.infer<typeof FriendParams>;

/**
 * Whom to invite. `resolveInvitee` re-checks the same exclusive-or for direct, non-HTTP callers — this
 * schema is the HTTP boundary's copy of that rule, and answers a 400 instead of the resolver's 404.
 */
export const InviteBody = z
  .object({
    email: z.string().email().optional().describe("The invitee's email — the reliable, unique identity key."),
    name: z.string().min(1).optional().describe("The invitee's screen name — best-effort, may be ambiguous."),
  })
  .refine((b) => (b.email ? 1 : 0) + (b.name ? 1 : 0) === 1, {
    message: "Provide exactly one of `email` or `name`.",
  })
  .describe("Whom to invite: an email or a screen name.");
export type InviteBody = z.infer<typeof InviteBody>;

/*
 * ## The management routes
 *
 * The `Admin*` shapes belong to the control-plane routes under `admin/`. Reads take filters and a place to
 * resume; the two acts take an idempotency key and a reason, and nothing else — a `strictObject`, so a field the
 * route does not know is a 400 rather than something a caller believes took.
 */

/** Where a page resumes. Opaque; a malformed one is a first page rather than an error. */
const Cursor = z
  .string()
  .max(1024)
  .optional()
  .describe("Where to resume, from the previous page's `nextCursor`. Opaque; hand it back verbatim.");

/** How many rows one page returns. Bounded, because a verified client can still have a bug. */
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`How many rows to return, from 1 to ${MAX_PAGE_SIZE}. Defaults to a page a dashboard can render.`);

/** The open-rooms query: where to resume. */
export const AdminRoomsQuery = z
  .object({ cursor: Cursor, limit: Limit })
  .describe("The open-rooms query: where to resume, and how many codes to read.");
export type AdminRoomsQuery = z.infer<typeof AdminRoomsQuery>;

/** The pending-invites query: which game, and where to resume. */
export const AdminInvitesQuery = z
  .object({
    game: GameParams.shape.game
      .optional()
      .describe(
        "Restrict the listing to one game. A shape check only; an unconfigured key is the handler's 404, so an operator who mistypes is told rather than shown an empty pane.",
      ),
    cursor: Cursor,
    limit: Limit,
  })
  .describe("The pending-invites query: which game, and where to resume.");
export type AdminInvitesQuery = z.infer<typeof AdminInvitesQuery>;

/** The player a drop names, in the game whose queue it is. */
export const AdminQueuePlayerParams = z
  .object({
    game: GameParams.shape.game,
    userId: FriendParams.shape.userId.describe("The waiting player to drop, as an auth user id."),
  })
  .describe("The path params of a queue drop: which game's queue, and which player.");
export type AdminQueuePlayerParams = z.infer<typeof AdminQueuePlayerParams>;

/** The longest reason an act may carry. A sentence, a ticket number — not a document. */
const MAX_REASON_LENGTH = 500;

/** What every management act sends: a key so a retry changes nothing, and why. */
export const AdminModeration = z
  .strictObject({
    idempotencyKey: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "A key the client mints once per act. A retry with the same key changes nothing, emits nothing, and answers `replayed: true`. A drop's key is remembered for a day, in that game's queue. A key already spent canceling another invite, or dropping another player from the same game's queue, is refused with `core/conflict`.",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(MAX_REASON_LENGTH)
      .describe(
        "Why. Required, and recorded verbatim on the audit event. A queue drop also sends it to the dropped player, so write it for them.",
      ),
  })
  .describe("A management act's idempotency key and reason.");
export type AdminModeration = z.infer<typeof AdminModeration>;
