// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The phases a session in flight can be in. A terminal session has no index row. */
export const LiveSessionPhase = z
  .enum(["open", "active"])
  .describe("A live session's phase: `open` while its roster fills, `active` once play is underway.");
export type LiveSessionPhase = z.infer<typeof LiveSessionPhase>;

/**
 * One session in flight — the row in `pithy_multiplayer_sessions` (#820).
 *
 * The index a management client lists sessions from. A session is a Durable Object addressed by its id, so
 * without this nothing can say what is in flight without already knowing every id. The session writes the row when
 * it opens, rewrites it when its roster or phase moves, and deletes it when it ends. The Durable Object stays the
 * authority: this row is what the in-flight read lists, never what a move is judged against.
 */
export const MultiplayerSessionEntry = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only; a session is addressed by sessionId."),
    sessionId: z.string().describe("The session's Durable Object id (hex). Unique."),
    gameKey: z.string().describe("The game the session plays, from `games` in pithy.config.ts."),
    phase: LiveSessionPhase.describe("The session's phase when it last changed."),
    players: sqliteJson(z.array(z.string())).describe("The members' user ids, in join order, as of the last change."),
    openedAt: SQLiteDate.describe("When the session opened."),
  })
  .describe("One session in flight — the row in `pithy_multiplayer_sessions`.");
export type MultiplayerSessionEntry = z.output<typeof MultiplayerSessionEntry>;
