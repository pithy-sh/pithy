// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, type SqlBool, sql } from "kysely";
import { SupportAssignment, type SupportAssignmentActorType } from "../data/assignment";
import {
  SUPPORT_ASSIGNMENTS_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
  supportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { SupportNotFoundError } from "../error/errors";

/**
 * Who has a thread (#816).
 *
 * **One fact, not a state machine.** A thread has an assignee or it has none, and any change moves it
 * straight to the next one. Every real change appends a row to `pithy_support_assignments`; a change that
 * changes nothing — the current assignee again, or unassigning a thread nobody has — writes nothing at
 * all, which is what lets a caller emit its audit event only when something happened.
 *
 * **Compare-and-set, not last-write-wins on a read.** The previous assignee is part of what the history and
 * the audit event record, so the write is conditioned on the assignee this call read. Two handovers racing
 * from one state cannot both claim to have replaced the same person: the loser re-reads and replaces
 * whoever won, and the chain of `previousRef` stays unbroken.
 *
 * **The change and its history row land together or not at all.** The conditional update and the history
 * insert go to D1 as one batch, which D1 runs as one transaction, and the insert is guarded on the update
 * having changed a row. A history row that cannot be written rolls the assignee back with it, so a retry
 * sees the old assignee, makes the change again, and records it — rather than finding the change already
 * made, taking the no-op branch, and leaving that handover out of the history and the audit trail for good.
 */

/** Somebody a thread may be assigned to: an opaque reference and how to show it. */
export interface Assignee {
  /** Opaque — a dashboard member, a user of the app, an agent. Support never interprets it. */
  ref: string;
  /** Display text, as the assigner named them. */
  name: string;
}

/** What {@link assignThread} takes. */
export interface AssignThreadOptions {
  /** The thread. */
  threadId: string;
  /** Who should have it, or null for nobody. */
  assignee: Assignee | null;
  /** How the assigner was verified. */
  actorType: SupportAssignmentActorType;
  /** The control-plane subject, or the signed-in user's id. */
  assignedBy: string;
  /** Why, when the assigner said. */
  note?: string;
  /** Generate a history row id. */
  newId: () => string;
  /** Now. */
  now: Date;
}

/** What {@link assignThread} did. */
export interface AssignThreadResult {
  /** The thread as it now stands. */
  thread: SupportThread;
  /** Whether anything changed. False for the current assignee again, or for unassigning nobody. */
  changed: boolean;
  /** Who had it before this call, or null when nobody did. */
  previous: Assignee | null;
}

/** How many times a write lost to a concurrent one is retried before the request gives up. */
const MAX_ATTEMPTS = 5;

/** The assignee a thread row names, or null. */
function assigneeOf(thread: SupportThread): Assignee | null {
  return thread.assigneeRef ? { ref: thread.assigneeRef, name: thread.assigneeName ?? thread.assigneeRef } : null;
}

/** A compiled Kysely query as a D1 statement, for a batch. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * Insert a history row only when the statement before it changed a row — `changes()` answers for the
 * statement just before it in the batch — so a compare-and-set that matched nothing writes no history.
 */
function guardedHistory(db: SupportDatabase, row: Record<string, unknown>): CompiledQuery {
  const columns = Object.keys(row);
  return (
    db
      .insertInto(SUPPORT_ASSIGNMENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the encoded row's own keys, which are the table's columns.
      .columns(columns as any)
      .expression(
        db.selectNoFrom(columns.map((column) => sql.val(row[column]).as(column))).where(sql<SqlBool>`changes() > 0`),
      )
      .compile()
  );
}

/** Assign a thread, or unassign it. Throws `support/not_found` when it does not exist. */
export async function assignThread(d1: D1Database, options: AssignThreadOptions): Promise<AssignThreadResult> {
  const db = supportDatabase(d1);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await db
      .selectFrom(SUPPORT_THREADS_TABLE)
      .selectAll()
      .where("id", "=", options.threadId)
      .executeTakeFirst();
    if (!row) throw new SupportNotFoundError({ detail: `no support thread ${options.threadId}` });
    const current = SupportThread.parse(row);
    const previous = assigneeOf(current);

    // The same ref is the same person, whatever name it arrives under: a no-op, so nothing is written,
    // nothing is recorded, and the caller emits nothing.
    if ((previous?.ref ?? null) === (options.assignee?.ref ?? null)) {
      return { thread: current, changed: false, previous };
    }

    const now = options.now.getTime();
    const next = {
      assigneeRef: options.assignee?.ref ?? null,
      assigneeName: options.assignee?.name ?? null,
      assignedAt: options.assignee ? now : null,
      assignedBy: options.assignee ? options.assignedBy : null,
      updatedAt: now,
    };
    const update = db
      .updateTable(SUPPORT_THREADS_TABLE)
      .set(next)
      .where("id", "=", options.threadId)
      // `is`, so a null previous assignee compares as SQLite's null-safe equality rather than never matching.
      .where("assigneeRef", "is", previous?.ref ?? null)
      .compile();
    const history = guardedHistory(
      db,
      SupportAssignment.encode({
        id: options.newId(),
        threadId: options.threadId,
        assigneeRef: options.assignee?.ref ?? null,
        assigneeName: options.assignee?.name ?? null,
        previousRef: previous?.ref ?? null,
        previousName: previous?.name ?? null,
        actorType: options.actorType,
        assignedBy: options.assignedBy,
        note: options.note ?? null,
        createdAt: options.now,
      }) as Record<string, unknown>,
    );
    const [updated] = await d1.batch([prepared(d1, update), prepared(d1, history)]);
    if ((updated?.meta.changes ?? 0) === 0) continue;

    return {
      thread: SupportThread.parse({ ...row, ...next }),
      changed: true,
      previous,
    };
  }
  throw new InternalError({
    message: "That conversation is being reassigned by somebody else. Try again.",
    detail: `assignment of thread ${options.threadId} lost ${MAX_ATTEMPTS} races in a row`,
  });
}

/** A thread's assignee history, oldest first. */
export async function listAssignments(db: SupportDatabase, threadId: string): Promise<SupportAssignment[]> {
  const rows = await db
    .selectFrom(SUPPORT_ASSIGNMENTS_TABLE)
    .selectAll()
    .where("threadId", "=", threadId)
    .orderBy("createdAt", "asc")
    // Insertion order breaks a tie within one millisecond, so the chain reads in the order it was written.
    .orderBy(sql`rowid`, "asc")
    .execute();
  return rows.map((row) => SupportAssignment.parse(row));
}
