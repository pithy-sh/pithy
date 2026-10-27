// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, type SqlBool, sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LeaderboardEntry } from "../data/entry";
import { LeaderboardLock } from "../data/lock";
import {
  type EntryModerationState,
  LeaderboardModeration,
  type LeaderboardModerationAct,
  type LockModerationState,
} from "../data/moderation";
import {
  LEADERBOARD_CONTRIBUTIONS_TABLE,
  LEADERBOARD_ENTRIES_TABLE,
  LEADERBOARD_LOCKS_TABLE,
  LEADERBOARD_MODERATIONS_TABLE,
  type LeaderboardDatabase,
  leaderboardDatabase,
} from "../data/tables";
import { LeaderboardEntryNotFoundError, LeaderboardScoreRejectedError } from "../error/errors";
import { markStale } from "../rank/stale";
import { windowKeyAt } from "../window/schedule";

/**
 * The management acts (#817): hide, unhide and correct an entry, and clear a stale refresh lock.
 *
 * Every act follows one shape, so every act keeps the same three promises:
 *
 * 1. **A replay changes nothing.** The idempotency key is read first; a key already used answers what its
 *    first request did, and the caller emits nothing. The same key on a different act is a 409, never a
 *    silent second meaning.
 * 2. **The change and its history are one transaction.** The update names the state it read and the key it
 *    is about to use, and the history row is inserted behind `changes()` in the same `d1.batch()`. So a row
 *    exists exactly when the change does, two racing requests with one key write once, and a submission
 *    that lands between the read and the write is a 409 to retry rather than an act recorded against a
 *    score nobody saw.
 * 3. **An act that finds nothing to do still keeps its key.** It writes a history row with
 *    `changed: false` and nothing else, so its replay answers the same.
 *
 * A stored rank is cleared by every entry act, and on a materialized board the act marks its window stale in
 * the same batch, so the next refresh pass renumbers that window even when it closed long ago; a live board
 * recounts on read. A correction also takes the entry over: the operator's number is the score now, so the
 * entry names no result and keeps no contribution, and a later void of the session it replaced leaves it
 * alone. The reason is validated at the boundary, so nothing here is reached without one.
 */

/** Who acted, from the verified control-plane token. */
export interface ModerationActor {
  connectionId: string;
  actorId: string;
}

/** What every act carries. */
interface ActInput {
  idempotencyKey: string;
  reason: string;
  actor: ModerationActor;
  now: Date;
}

/** An entry act. `score` is the correction's, and is required for one. */
export interface EntryActInput extends ActInput {
  act: Exclude<LeaderboardModerationAct, "clear_lock">;
  board: LeaderboardBoard;
  /**
   * The window acted on. Undefined means the one open at `now` — and on a replay, the one the key's first
   * request acted on, so a retry sent across a rollover answers its first request rather than a 409.
   */
  windowKey: string | undefined;
  userId: string;
  score?: number;
  /** The board's ranks are stored (`rank: { materialize }`), so a changed window is marked for the refresh. */
  materialized: boolean;
}

/** What an entry act did. */
export interface EntryActOutcome {
  /** The window acted on — resolved, when the request named none. */
  windowKey: string;
  before: EntryModerationState;
  after: EntryModerationState;
  reason: string;
  changed: boolean;
  replayed: boolean;
}

/** A lock clear. */
export interface ClearLockInput extends ActInput {
  name: string;
  holder: string;
}

/** What a lock clear did. */
export interface ClearLockOutcome {
  lock: LockModerationState & { name: string };
  reason: string;
  replayed: boolean;
}

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/** The act a key was first used for, or undefined for a key never seen. */
async function recorded(db: LeaderboardDatabase, idempotencyKey: string): Promise<LeaderboardModeration | undefined> {
  const row = await db
    .selectFrom(LEADERBOARD_MODERATIONS_TABLE)
    .selectAll()
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirst();
  return row ? LeaderboardModeration.parse(row) : undefined;
}

function keyReused(idempotencyKey: string, detail: string): ConflictError {
  return new ConflictError({
    // The caller's remedy, so it is in the message: `clientError` strips `action` from every response.
    message:
      "That idempotency key was already used for a different act. Mint a new idempotency key for each act, and resend a key only to retry the same request.",
    detail: `Idempotency key ${idempotencyKey}: ${detail}`,
  });
}

/** The history row's encoded columns, ready to insert. */
function historyRow(row: Omit<LeaderboardModeration, "id">): Record<string, unknown> {
  const encoded = LeaderboardModeration.encode({ ...row, id: 0 }) as Record<string, unknown>;
  delete encoded.id;
  return encoded;
}

/**
 * Insert a history row only when the statement before it changed a row — `changes()` answers for the
 * statement just before it in the batch — so a conditional update that matched nothing writes no history.
 */
function guardedHistory(db: LeaderboardDatabase, row: Record<string, unknown>): CompiledQuery {
  const columns = Object.keys(row);
  return (
    db
      .insertInto(LEADERBOARD_MODERATIONS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the encoded row's own keys, which are the table's columns.
      .columns(columns as any)
      .expression(
        db.selectNoFrom(columns.map((column) => sql.val(row[column]).as(column))).where(sql<SqlBool>`changes() > 0`),
      )
      .compile()
  );
}

/** An unused key, for the conditional update: a racing request with the same key changes nothing. */
function keyUnused(db: LeaderboardDatabase, idempotencyKey: string) {
  return sql<SqlBool>`not exists ${db
    .selectFrom(LEADERBOARD_MODERATIONS_TABLE)
    .select(sql.lit(1).as("one"))
    .where("idempotencyKey", "=", idempotencyKey)}`;
}

/** An entry's moderated state. */
function entryState(entry: Pick<LeaderboardEntry, "score" | "visible" | "hidden">): EntryModerationState {
  return { kind: "entry", score: entry.score, visible: entry.visible, hidden: entry.hidden };
}

function sameEntryState(a: EntryModerationState, b: EntryModerationState): boolean {
  return a.score === b.score && a.visible === b.visible && a.hidden === b.hidden;
}

/**
 * The replay of an entry act, or a 409 when the key was used for another. A request that named no window
 * means whichever its first request acted on: the open window may have rolled over between the two.
 */
function replayEntryAct(previous: LeaderboardModeration, input: EntryActInput): EntryActOutcome {
  const { before, after, windowKey } = previous;
  const same =
    previous.act === input.act &&
    previous.boardId === input.board.key &&
    (input.windowKey === undefined || windowKey === input.windowKey) &&
    previous.userId === input.userId &&
    before.kind === "entry" &&
    after?.kind === "entry" &&
    (input.act !== "correct" || after.score === input.score);
  if (!same || !windowKey || before.kind !== "entry" || after?.kind !== "entry") {
    throw keyReused(
      input.idempotencyKey,
      `first used for ${previous.act} on ${previous.boardId ?? previous.lockName}/${windowKey}, now sent for ${input.act} on ${input.board.key}/${input.windowKey ?? "(open window)"}/${input.userId}.`,
    );
  }
  return {
    windowKey,
    before,
    after,
    reason: previous.reason,
    changed: previous.changed,
    replayed: true,
  };
}

/** Hide, unhide or correct one entry. */
export async function moderateEntry(d1: D1Database, input: EntryActInput): Promise<EntryActOutcome> {
  const db = leaderboardDatabase(d1);
  const { board, userId, idempotencyKey } = input;

  const previous = await recorded(db, idempotencyKey);
  if (previous) return replayEntryAct(previous, input);
  const windowKey = input.windowKey ?? windowKeyAt(board.window, input.now);

  if (input.act === "correct") {
    const score = input.score;
    if (score === undefined) {
      throw new LeaderboardScoreRejectedError({ detail: "A correction was sent with no score." });
    }
    // The same bounds a submission is held to: a correction is not a way past them.
    if ((board.min !== undefined && score < board.min) || (board.max !== undefined && score > board.max)) {
      throw new LeaderboardScoreRejectedError({
        detail: `Correction to ${score} is outside board "${board.key}" bounds [${board.min ?? "-∞"}, ${board.max ?? "∞"}].`,
      });
    }
  }

  const found = await db
    .selectFrom(LEADERBOARD_ENTRIES_TABLE)
    .selectAll()
    .where("boardId", "=", board.key)
    .where("windowKey", "=", windowKey)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!found) {
    throw new LeaderboardEntryNotFoundError({
      message: "That entry does not exist. Read the board's entries for the window and pick one that is there.",
      detail: `No entry for user ${userId} on board "${board.key}" in window ${windowKey}.`,
    });
  }
  const entry = LeaderboardEntry.parse(found);
  const before = entryState(entry);
  const after: EntryModerationState =
    input.act === "correct" ? { ...before, score: input.score as number } : { ...before, hidden: input.act === "hide" };
  const changed = !sameEntryState(before, after);
  const row = historyRow({
    idempotencyKey,
    act: input.act,
    boardId: board.key,
    windowKey,
    userId,
    lockName: null,
    reason: input.reason,
    before,
    after,
    changed,
    connectionId: input.actor.connectionId,
    actorId: input.actor.actorId,
    createdAt: input.now,
  });

  if (!changed) {
    const result = await db
      .insertInto(LEADERBOARD_MODERATIONS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side.
      .values(row as any)
      .onConflict((oc) => oc.column("idempotencyKey").doNothing())
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) {
      return { windowKey, before, after, reason: input.reason, changed: false, replayed: false };
    }
    return settleRace(db, input, windowKey);
  }

  const correcting = input.act === "correct";
  const update = db
    .updateTable(LEADERBOARD_ENTRIES_TABLE)
    .set({
      score: after.score,
      hidden: LeaderboardEntry.shape.hidden.encode(after.hidden),
      // Cleared, so a materialized board renumbers this entry on its next pass.
      rank: null,
      // A corrected score is the operator's, not any result's, so no void may take it back.
      ...(correcting ? { resultId: null } : {}),
    })
    .where("boardId", "=", board.key)
    .where("windowKey", "=", windowKey)
    .where("userId", "=", userId)
    // The state this act was decided against. A submission that landed since makes this match nothing.
    .where("score", "=", before.score)
    .where("hidden", "=", LeaderboardEntry.shape.hidden.encode(before.hidden))
    .where(keyUnused(db, idempotencyKey))
    .compile();
  const statements = [prepared(d1, update), prepared(d1, guardedHistory(db, row))];
  // Everything after the history row runs only once that row is there — `changes()` has moved on by then,
  // and the row is exactly the evidence that the update above changed the entry.
  const actedHere = recordedAs(db, row);
  if (correcting) {
    statements.push(
      prepared(
        d1,
        db
          .deleteFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
          .where("boardId", "=", board.key)
          .where("windowKey", "=", windowKey)
          .where("userId", "=", userId)
          .where(actedHere)
          .compile(),
      ),
    );
  }
  if (input.materialized) {
    statements.push(prepared(d1, markStale(db, board.key, windowKey, input.now, actedHere)));
  }
  const [updated] = await d1.batch(statements);
  if ((updated?.meta.changes ?? 0) > 0) {
    return { windowKey, before, after, reason: input.reason, changed: true, replayed: false };
  }
  return settleRace(db, input, windowKey);
}

/**
 * This act's history row is there: the key, recorded for this act on this entry with this outcome. Either
 * this request wrote it, or a twin with the same key made the very same change — and either way what
 * follows it in the batch is owed.
 */
function recordedAs(db: LeaderboardDatabase, row: Record<string, unknown>) {
  let query = db.selectFrom(LEADERBOARD_MODERATIONS_TABLE).select(sql.lit(1).as("one"));
  for (const column of ["idempotencyKey", "act", "boardId", "windowKey", "userId", "after"] as const) {
    query = query.where(column, "=", row[column] as string);
  }
  return sql<SqlBool>`exists ${query}`;
}

/**
 * The write matched nothing. Either a request with the same key won the race, which is a replay, or the
 * entry moved under this one, which is the caller's to read again.
 */
async function settleRace(db: LeaderboardDatabase, input: EntryActInput, windowKey: string): Promise<EntryActOutcome> {
  const winner = await recorded(db, input.idempotencyKey);
  if (winner) return replayEntryAct(winner, input);
  throw new ConflictError({
    message:
      "The entry changed while it was being moderated. Read it again, and retry the act with the same idempotency key.",
    detail: `Entry ${input.board.key}/${windowKey}/${input.userId} moved between the read and the ${input.act}.`,
  });
}

/** The replay of a lock clear, or a 409 when the key was used for another act. */
function replayClear(previous: LeaderboardModeration, input: ClearLockInput): ClearLockOutcome {
  const { before } = previous;
  if (previous.act !== "clear_lock" || previous.lockName !== input.name || before.kind !== "lock") {
    throw keyReused(
      input.idempotencyKey,
      `first used for ${previous.act}, now sent to clear lock ${input.name} held by ${input.holder}.`,
    );
  }
  return { lock: { ...before, name: input.name }, reason: previous.reason, replayed: true };
}

async function heldLock(db: LeaderboardDatabase, name: string): Promise<LeaderboardLock | undefined> {
  const found = await db.selectFrom(LEADERBOARD_LOCKS_TABLE).selectAll().where("name", "=", name).executeTakeFirst();
  return found ? LeaderboardLock.parse(found) : undefined;
}

function changedHands(name: string, current: string, named: string): ConflictError {
  return new ConflictError({
    message:
      "That lock has changed hands. Read the locks again: a refresh took it since, and a running refresh must not be cleared.",
    detail: `Lock ${name} is held by ${current}; the clear named ${named}.`,
  });
}

function lockNotHeld(name: string): NotFoundError {
  return new NotFoundError({
    message: "That lock is not held. A refresh that finished released it already, so read the locks again.",
    detail: `No ${name} lock is held.`,
  });
}

/**
 * Release a rank-refresh lock — the recovery for a refresh instance that died holding it.
 *
 * The caller names the holder it saw, and a lock that has since changed hands is a 409 rather than a
 * release: clearing a live holder lets two refreshes interleave their rank writes, which is the one thing
 * the lock exists to prevent, and a clear aimed at a stale holder must never reach a fresh one.
 */
export async function clearLock(d1: D1Database, input: ClearLockInput): Promise<ClearLockOutcome> {
  const db = leaderboardDatabase(d1);
  const { name, holder, idempotencyKey } = input;

  const previous = await recorded(db, idempotencyKey);
  if (previous) return replayClear(previous, input);

  const lock = await heldLock(db, name);
  if (!lock) throw lockNotHeld(name);
  if (lock.holder !== holder) throw changedHands(name, lock.holder, holder);
  const before: LockModerationState = { kind: "lock", holder, acquiredAt: lock.acquiredAt.toISOString() };

  const remove = db
    .deleteFrom(LEADERBOARD_LOCKS_TABLE)
    .where("name", "=", name)
    .where("holder", "=", holder)
    .where(keyUnused(db, idempotencyKey))
    .compile();
  const row = historyRow({
    idempotencyKey,
    act: "clear_lock",
    boardId: null,
    windowKey: null,
    userId: null,
    lockName: name,
    reason: input.reason,
    before,
    after: null,
    changed: true,
    connectionId: input.actor.connectionId,
    actorId: input.actor.actorId,
    createdAt: input.now,
  });
  const [deleted] = await d1.batch([prepared(d1, remove), prepared(d1, guardedHistory(db, row))]);
  if ((deleted?.meta.changes ?? 0) > 0) return { lock: { ...before, name }, reason: input.reason, replayed: false };

  // The delete matched nothing: a request with this key won, or the lock moved since it was read.
  const winner = await recorded(db, idempotencyKey);
  if (winner) return replayClear(winner, input);
  const now = await heldLock(db, name);
  if (now) throw changedHands(name, now.holder, holder);
  throw lockNotHeld(name);
}
