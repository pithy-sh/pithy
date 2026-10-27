// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * The HTTP-boundary shapes for the multiplayer routes. Declared on the route line with
 * `validate(target, Schema)`, so a malformed segment is a `validation/invalid_input` 400
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

/*
 * ## The management routes (#820)
 *
 * The `Admin*` shapes belong to the control-plane routes under `admin/`. Reads take filters and a place to resume;
 * the two acts take an idempotency key and a reason, and nothing else — a `strictObject`, so a field the route does
 * not know is a 400 rather than something a caller believes took.
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

/** A game filter. A shape check only: an unconfigured key is the handler's 404. */
const GameFilter = MultiplayerGameParams.shape.game
  .optional()
  .describe(
    "Restrict the listing to one game. An unconfigured key is `multiplayer/game_not_found`, so an operator who mistypes is told rather than shown an empty pane.",
  );

/** The sessions-in-flight query: which game, and where to resume. */
export const AdminSessionsQuery = z
  .object({ game: GameFilter, cursor: Cursor, limit: Limit })
  .describe("The sessions-in-flight query: which game, and where to resume.");
export type AdminSessionsQuery = z.output<typeof AdminSessionsQuery>;

/** The results query: which game, whether voided, and where to resume. */
export const AdminResultsQuery = z
  .object({
    game: GameFilter,
    voided: z
      .enum(["true", "false"])
      .describe("`true` or `false`.")
      .transform((value) => value === "true")
      .optional()
      .describe("`true` for voided results only, `false` for the results that count. Both when absent."),
    cursor: Cursor,
    limit: Limit,
  })
  .describe("The results query: which game, whether voided, and where to resume.");
export type AdminResultsQuery = z.output<typeof AdminResultsQuery>;

/** The longest reason an act may carry. A sentence, a ticket number — not a document. */
const MAX_REASON_LENGTH = 500;

/** What every management act sends: a key so a retry changes nothing, and why. */
export const AdminAct = z
  .strictObject({
    idempotencyKey: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "A key the client mints once per act. A retry with the same key changes nothing, emits nothing, and answers `replayed: true`. A close's key is remembered by the session it closed. A void's key is unique across results: one spent voiding another result is refused with `core/conflict`.",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(MAX_REASON_LENGTH)
      .describe(
        "Why. Required, and recorded verbatim on the audit event. A close also sends it to the session's players in its last state frame, so write it for them.",
      ),
  })
  .describe("A management act's idempotency key and reason.");
export type AdminAct = z.output<typeof AdminAct>;
