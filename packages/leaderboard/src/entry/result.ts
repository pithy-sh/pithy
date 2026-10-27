// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type CompiledQuery, sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LeaderboardContribution } from "../data/contribution";
import { LeaderboardEntry } from "../data/entry";
import { LEADERBOARD_CONTRIBUTIONS_TABLE, LEADERBOARD_ENTRIES_TABLE, leaderboardDatabase } from "../data/tables";
import { markStale } from "../rank/stale";
import { submitQuery } from "./store";
import type { AdjustedEntry, LeaderboardVoidReport, VoidedEntry } from "./voidReport";

/**
 * Result-sourced submissions, and taking one back (#817).
 *
 * A result — a `@pithy-sh/multiplayer` session, or anything of the adopter's that resolves into scores — is
 * the one kind of submission that can later turn out not to have counted. So it is the one kind that leaves
 * a trail: the entry names the result that wrote it, and a row in `pithy_leaderboard_contributions` says
 * what the result put there. A plain submission writes neither, and costs what it always cost.
 */

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/** One result's score for one player. */
export interface ResultSubmission {
  board: LeaderboardBoard;
  windowKey: string;
  userId: string;
  score: number;
  at: Date;
  visibleByDefault: boolean;
  /** The result's own id — a multiplayer session id. What a void names. */
  resultId: string;
}

/**
 * Fold one result's score into the player's entry, once.
 *
 * Two statements in one `d1.batch()`, which D1 runs as one transaction: the upsert, which stands down when
 * this result already contributed to this entry, and the contribution row. So the entry and its provenance
 * are written together or not at all, and a retried publish folds nothing twice. `recorded` is false for
 * that retry.
 */
export async function submitResult(d1: D1Database, submission: ResultSubmission): Promise<{ recorded: boolean }> {
  const db = leaderboardDatabase(d1);
  const { board, windowKey, userId, score, at, visibleByDefault, resultId } = submission;
  const upsert = submitQuery(db, board, windowKey, userId, score, at, visibleByDefault, resultId).compile();
  const row = LeaderboardContribution.encode({
    id: 0,
    resultId,
    boardId: board.key,
    windowKey,
    userId,
    score,
    aggregation: board.aggregation,
    createdAt: at,
  }) as Record<string, unknown>;
  delete row.id;
  const contribution = db
    .insertInto(LEADERBOARD_CONTRIBUTIONS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side.
    .values(row as any)
    .onConflict((oc) => oc.columns(["resultId", "boardId", "windowKey", "userId"]).doNothing())
    .compile();
  const [, recorded] = await d1.batch([prepared(d1, upsert), prepared(d1, contribution)]);
  return { recorded: (recorded?.meta.changes ?? 0) > 0 };
}

/**
 * Take back everything one result put on every board — the leaderboard's consumer in the void cascade.
 *
 * Per contribution, by the aggregation it was folded with:
 *
 * - **`sum`**: the result's points come back out. The entry is removed only when nothing is left in it —
 *   no other result contributed and the remaining score is zero, so a plain submission's points keep it.
 * - **`best` and `latest`**: the entry is removed while this result still holds its score. When another
 *   submission has since taken it, the entry is not this result's any more, and it is left alone.
 *
 * Each entry's statements and the contribution's delete go in one `d1.batch()`, and the arithmetic is the
 * database's, so a submission landing between the read and the write is never lost. A stored rank is
 * cleared, and an entry that held one marks its window stale in the same batch, so the next refresh pass
 * renumbers it even once it has closed; a live board stores no rank and recounts on read. An entry with no
 * stored rank was never counted in anyone else's, so taking it back leaves theirs right.
 *
 * A corrected entry has no contribution left to find: the correction took the entry over (`moderate.ts`),
 * so a void never subtracts from, or removes, a score an operator set.
 *
 * Idempotent: a second void finds no contributions and reports nothing. **And safe run twice at once**: every
 * write in an entry's batch holds only while the contribution it read is still there, and the batch deletes it, so
 * of two runs that read one contribution, the second to write changes nothing and reports nothing.
 */
export async function voidResult(d1: D1Database, resultId: string, now = new Date()): Promise<LeaderboardVoidReport> {
  const db = leaderboardDatabase(d1);
  const rows = await db
    .selectFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
    .selectAll()
    .where("resultId", "=", resultId)
    .orderBy("boardId")
    .orderBy("windowKey")
    .orderBy("userId")
    .execute();

  const removed: VoidedEntry[] = [];
  const adjusted: AdjustedEntry[] = [];

  for (const row of rows) {
    const contribution = LeaderboardContribution.parse(row);
    const { boardId, windowKey, userId, score } = contribution;
    const key = { board: boardId, window: windowKey, userId };
    const found = await db
      .selectFrom(LEADERBOARD_ENTRIES_TABLE)
      .selectAll()
      .where("boardId", "=", boardId)
      .where("windowKey", "=", windowKey)
      .where("userId", "=", userId)
      .executeTakeFirst();
    const entry = found ? LeaderboardEntry.parse(found) : undefined;
    const forget = db.deleteFrom(LEADERBOARD_CONTRIBUTIONS_TABLE).where("id", "=", contribution.id).compile();
    // Every write below holds only while this contribution is still there: a run that lost it changes nothing.
    const held = sql<boolean>`exists ${db
      .selectFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
      .select(sql.lit(1).as("one"))
      .where("id", "=", contribution.id)}`;
    // Last in each batch, so it never sits between a statement and the `changes()` that reads it.
    const stale = entry?.rank != null ? [prepared(d1, markStale(db, boardId, windowKey, now))] : [];

    if (!entry) {
      // Removed already — by a moderator, or by retention. Nothing is left to take back.
      await d1.batch([prepared(d1, forget)]);
      continue;
    }

    if (contribution.aggregation === "sum") {
      const others = db
        .selectFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
        .select(sql.lit(1).as("one"))
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .where("resultId", "!=", resultId);
      const remove = db
        .deleteFrom(LEADERBOARD_ENTRIES_TABLE)
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .where(sql<boolean>`${sql.ref("score")} - ${score} = 0`)
        .where(sql<boolean>`not exists ${others}`)
        .where(held)
        .compile();
      // Runs only when the delete above removed nothing: `changes()` answers for the statement before it.
      const subtract = db
        .updateTable(LEADERBOARD_ENTRIES_TABLE)
        .set({
          score: sql<number>`${sql.ref("score")} - ${score}`,
          rank: null,
          resultId: sql<
            string | null
          >`case when ${sql.ref("resultId")} = ${resultId} then null else ${sql.ref("resultId")} end`,
        })
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .where(sql<boolean>`changes() = 0`)
        .where(held)
        .compile();
      const [deleted, , forgot] = await d1.batch([
        prepared(d1, remove),
        prepared(d1, subtract),
        prepared(d1, forget),
        ...stale,
      ]);
      // Another run took this contribution back first; it reports what it did, and this one did nothing.
      if ((forgot?.meta.changes ?? 0) === 0) continue;
      if ((deleted?.meta.changes ?? 0) > 0) removed.push({ ...key, score: entry.score });
      else adjusted.push({ ...key, before: entry.score, after: entry.score - score });
      continue;
    }

    const remove = db
      .deleteFrom(LEADERBOARD_ENTRIES_TABLE)
      .where("boardId", "=", boardId)
      .where("windowKey", "=", windowKey)
      .where("userId", "=", userId)
      .where("resultId", "=", resultId)
      .where(held)
      .compile();
    const [deleted] = await d1.batch([prepared(d1, remove), prepared(d1, forget), ...stale]);
    if ((deleted?.meta.changes ?? 0) > 0) removed.push({ ...key, score: entry.score });
  }

  return { resultId, removed, adjusted };
}
