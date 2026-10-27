// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SessionResultStatus } from "../data/result";
import { SessionInspection } from "../session/view";

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

export { SessionInspection, SessionView } from "../session/view";

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
    voidedAt: z.iso
      .datetime()
      .nullable()
      .optional()
      .describe(
        "When a management client voided the result, ISO-8601, or null while it counts. A voided result no longer counts toward a leaderboard or a rating. Absent from a Worker that predates voiding.",
      ),
  })
  .describe("The durable record of how a finished session ended.");
export type SessionResult = z.infer<typeof SessionResult>;

/*
 * ## The management routes (#820)
 *
 * What the control-plane routes under `admin/` answer. Each is read by a management client across a version
 * boundary, so every field added after this lands is `.optional()`.
 */

/** Where the next page starts. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page starts — hand it back as `cursor`. Null on the last page.");

/** One session in flight, as the index lists it. */
export const AdminSessionListItem = z
  .object({
    sessionId: z.string().describe("The session id. Read one with `GET …/admin/sessions/:id`."),
    gameKey: z.string().describe("The game the session plays."),
    phase: z.enum(["open", "active"]).describe("`open` while the roster fills, `active` once play is underway."),
    players: z.array(z.string()).describe("The members' user ids, in join order, as of the session's last change."),
    openedAt: z.iso.datetime().describe("When the session opened, ISO-8601."),
    ageSeconds: z.number().int().describe("How long the session has been open, in whole seconds."),
  })
  .describe("One session in flight, as the index lists it.");
export type AdminSessionListItem = z.infer<typeof AdminSessionListItem>;

/** A page of sessions in flight, newest first. */
export const AdminSessionList = z
  .object({
    sessions: z.array(AdminSessionListItem).describe("Sessions in flight, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of sessions in flight, newest first.");
export type AdminSessionList = z.infer<typeof AdminSessionList>;

/** What one consumer of a void did. */
export const VoidConsumerOutcome = z
  .object({
    consumer: z.string().describe("The composed capability the void called: `leaderboard` or `rating`."),
    status: z
      .enum(["pending", "done", "failed"])
      .describe(
        "`done` when the consumer took the result back; `failed` when it threw, is too old to void, or is no longer composed. `pending` only on a replay of a void or a retry still running, or one that stopped before the consumer answered — void again with a new key to run it, once 15 minutes have passed since the key holding the void was spent; before that, a new key is `core/conflict`.",
      ),
    error: z
      .object({
        code: z.string().describe("The failure's error code."),
        message: z.string().describe("The failure's public message."),
      })
      .nullable()
      .describe("Why the consumer failed, or null when it did not."),
    report: z
      .unknown()
      .optional()
      .describe(
        "What the consumer did, in its own shape, on the request that ran it: `LeaderboardVoidReport` from `@pithy-sh/leaderboard/src/entry/voidReport` (the entries removed and adjusted), or `RatingVoidReport` from `@pithy-sh/rating/src/http/responses` (each player before and after). Absent on a replay and on a failure.",
      ),
  })
  .describe("One composed consumer's part in a void. A consumer that failed is named, never folded into success.");
export type VoidConsumerOutcome = z.infer<typeof VoidConsumerOutcome>;

/** A result, as the management surface reads it. */
export const AdminResultView = SessionResult.omit({ id: true, voidedAt: true })
  .extend({
    voidedAt: z.iso.datetime().nullable().describe("When the result was voided, ISO-8601, or null while it counts."),
    consumers: z
      .array(
        VoidConsumerOutcome.omit({ report: true }).describe(
          "One consumer's part in the void, as the result records it.",
        ),
      )
      .describe("What each consumer did with the void, as recorded. Empty while the result counts."),
  })
  .describe("One session's result, with whether it was voided and what each consumer did.");
export type AdminResultView = z.infer<typeof AdminResultView>;

/** A page of results, most recently ended first. */
export const AdminResultList = z
  .object({
    results: z.array(AdminResultView).describe("Results, most recently ended first."),
    nextCursor: NextCursor,
  })
  .describe("A page of results, most recently ended first.");
export type AdminResultList = z.infer<typeof AdminResultList>;

/** What closing a session in flight did. */
export const AdminSessionClosed = z
  .object({
    session: SessionInspection.describe("The session as it now stands: `abandoned`, with the reason in its outcome."),
    replayed: z
      .boolean()
      .describe("True when the idempotency key already closed this session: nothing changed this time."),
  })
  .describe("What closing a session in flight did.");
export type AdminSessionClosed = z.infer<typeof AdminSessionClosed>;

/** What voiding a result did, consumer by consumer. */
export const AdminResultVoided = z
  .object({
    result: AdminResultView.describe("The result as it now stands."),
    replayed: z
      .boolean()
      .describe(
        "True when nothing changed this time: the key was already spent on this void, or the result was void already with every consumer done.",
      ),
    consumers: z
      .array(VoidConsumerOutcome)
      .describe(
        "Each consumer this request called, with its report, or on a replay each consumer as recorded. A consumer not composed in this Worker is absent.",
      ),
  })
  .describe("What voiding a result did, consumer by consumer.");
export type AdminResultVoided = z.infer<typeof AdminResultVoided>;
