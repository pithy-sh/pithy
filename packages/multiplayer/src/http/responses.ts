// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SessionResultStatus } from "../data/result";

/**
 * What the multiplayer routes return, as Zod objects a client can validate against and the OpenAPI
 * contract can describe.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, so a date is the ISO-8601 string `c.json` writes, and nothing here carries a codec or a
 * transform: parsing a response hands back exactly what went in, which is what lets
 * `routes.workers.test.ts` parse a real answer and compare it with the original.
 *
 * Every session route answers with `SessionView`, the one shape that ever leaves the session's Durable
 * Object. It is defined once, beside the session state it is built from, and re-exported here so the
 * routes name every response from one file.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

export { SessionView } from "../session/view";

/** A session's durable result, as the result route returns it. */
export const SessionResult = z
  .object({
    id: z.number().int().describe("The result row's internal id. Address a result by `sessionId`, not this."),
    sessionId: z.string().describe("The id of the session this result belongs to."),
    gameKey: z.string().describe("The game the session played."),
    status: SessionResultStatus.describe("The terminal state: `resolved` or `abandoned`."),
    players: z.array(z.string()).describe("The members' user ids, in join order."),
    scores: z
      .record(z.string(), z.number())
      .nullable()
      .describe("Each player's final score, keyed by user id. Null when the session was abandoned."),
    winnerUserId: z.string().nullable().describe("The winner's user id. Null on a draw and on an abandoned session."),
    draw: z.boolean().describe("Whether the session ended level. False on an abandoned session."),
    createdAt: z.iso.datetime().describe("When the session was created, ISO-8601."),
    resolvedAt: z.iso.datetime().describe("When the session reached its terminal state, ISO-8601."),
  })
  .describe("The durable record of how a finished session ended.");
export type SessionResult = z.infer<typeof SessionResult>;
