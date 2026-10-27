// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RatingSnapshot } from "../data/adjustment";
import type { OutcomeLog } from "../data/log";
import type { RatingRecord } from "../data/rating";
import type { ReplayHistory } from "./replay";

/**
 * Read what a replay of one player needs off the log: their rows, the outcomes behind them, every
 * participant of those outcomes, and the floor of their latest reset. `voided` names outcomes to treat as
 * void although the log does not say so yet — how a void computes every rating before it writes any.
 */
export async function historyOf(
  log: OutcomeLog,
  pool: string,
  userId: string,
  voided: ReadonlySet<number> = new Set(),
): Promise<ReplayHistory> {
  const entries = await log.playerEntries(pool, userId);
  const ids = [...new Set(entries.map((entry) => entry.outcomeId))];
  const outcomes = (await log.outcomes(ids)).map((outcome) =>
    voided.has(outcome.id) && outcome.voidedAt === null ? { ...outcome, voidedAt: new Date(0) } : outcome,
  );
  const reset = await log.latestReset(pool, userId);
  return {
    entries,
    outcomes: new Map(outcomes.map((outcome) => [outcome.id, outcome])),
    participants: await log.participants(ids),
    ...(reset ? { floorEntry: reset.floorEntry } : {}),
  };
}

/** A stored rating as a snapshot — what an act or a void reports as `before`. */
export function snapshotOf(record: RatingRecord | undefined): RatingSnapshot | null {
  if (!record) return null;
  return {
    algorithm: record.algorithm,
    state: record.state,
    skill: record.skill,
    xp: record.xp,
    games: record.games,
  };
}

/** A snapshot written back as a stored rating, stamped `at`. */
export function recordOf(pool: string, userId: string, snapshot: RatingSnapshot, at: Date): RatingRecord {
  return { id: 0, pool, userId, ...snapshot, updatedAt: at };
}
