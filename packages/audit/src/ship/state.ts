// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { sql } from "kysely";
import { AuditSinkStateRow } from "../data/sinkState";
import type { AuditDatabase } from "../data/tables";

/**
 * **Each sink's delivery state, kept by the consumer and read by the health keys (#824).**
 *
 * `retrying` is the backlog the queue cannot be asked for: an event joins it the first time a delivery to the sink
 * fails, and leaves it when a retry lands or when its last retry fails and it is dead-lettered. Counts move by
 * upsert, one statement per sink per batch, and never below zero.
 */

/** What one batch did to one sink. */
export interface SinkOutcome {
  /** The batch landed, or it did not. */
  delivered: boolean;
  /** When. */
  at: Date;
  /** The change to the backlog: events newly waiting on a retry, less those that stopped waiting. */
  retryingDelta: number;
  /** Events given up on: their last retry failed, and they went to the dead-letter queue. */
  deadLettered: number;
}

/** Record one batch's outcome for one sink. */
export async function recordSinkOutcome(db: AuditDatabase, sink: string, outcome: SinkOutcome): Promise<void> {
  const at = SQLiteDate.encode(outcome.at) as number;
  const delta = outcome.retryingDelta;
  await db
    .insertInto("pithyAuditSinks")
    .values({
      sink,
      lastDeliveredAt: outcome.delivered ? at : null,
      lastFailedAt: outcome.delivered ? null : at,
      retrying: Math.max(delta, 0),
      deadLettered: outcome.deadLettered,
    })
    .onConflict((conflict) =>
      conflict.column("sink").doUpdateSet({
        ...(outcome.delivered ? { lastDeliveredAt: at } : { lastFailedAt: at }),
        retrying: sql<number>`max(${sql.ref("retrying")} + ${delta}, 0)`,
        deadLettered: sql<number>`${sql.ref("deadLettered")} + ${outcome.deadLettered}`,
      }),
    )
    .execute();
}

/** The declared sinks' rows, decoded. A sink with no row yet has done nothing and is absent. */
export async function readSinkStates(db: AuditDatabase, sinks: readonly string[]): Promise<AuditSinkStateRow[]> {
  if (sinks.length === 0) return [];
  const rows = await db
    .selectFrom("pithyAuditSinks")
    .selectAll()
    .where("sink", "in", [...sinks])
    .execute();
  return rows.map((row) => AuditSinkStateRow.parse(row));
}
