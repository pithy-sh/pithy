import { z } from "zod";

/**
 * The HTTP-boundary shapes for the multiplayer routes. Declared on the route line with
 * `zValidator(target, Schema, validationHook)`, so a malformed segment is a `validation/invalid_input` 400
 * before any handler runs, never an unbounded string handed to a config lookup or a Durable Object id parse.
 *
 * Both are **param** schemas, and both are shape checks rather than existence checks. Resolving a game key
 * against the configured games stays in the handler (an unknown game is still a `multiplayer/game_not_found`
 * 404), and deciding whether a session id names a real Durable Object stays in `idFromString` (an unparseable
 * id is still a `multiplayer/session_not_found` 404).
 *
 * There is deliberately no body schema here. The one route that reads a body — `POST /sessions/:id/action` —
 * forwards it untouched to the game's model, which is the only thing that knows an action's shape; see the
 * routes docblock.
 */

/**
 * A game key is a URL path segment, so it is lowercase, digits, and dashes — the same shape
 * `MultiplayerGame.key` enforces at config assembly. A key that cannot be configured cannot resolve, so
 * bounding the segment here rejects it a step earlier without narrowing what already works.
 */
const GAME_KEY = /^[a-z0-9][a-z0-9-]*$/;

export const MultiplayerGameParams = z
  .object({
    game: z
      .string()
      .max(64)
      .regex(GAME_KEY, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The configured game a session is created for. Resolved against the games in the handler."),
  })
  .describe("The path params of a game-scoped multiplayer route.");
export type MultiplayerGameParams = z.output<typeof MultiplayerGameParams>;

export const MultiplayerSessionParams = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "The session's Durable Object id. Bounded, not parsed: a real id is 64 hex characters, but the id a client sent is judged by `idFromString`, which answers an unparseable one with a 404. A hex regex here would make that a 400 and leave the handler's catch unreachable.",
      ),
  })
  .describe("The path params of a session-scoped multiplayer route.");
export type MultiplayerSessionParams = z.output<typeof MultiplayerSessionParams>;
