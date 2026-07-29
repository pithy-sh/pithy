import { z } from "zod";

/**
 * What the matchmaking routes accept. Every schema here is named on a route line via
 * `zValidator(target, Schema, validationHook)`, so reading `routes.ts` tells you the shape of a request
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
