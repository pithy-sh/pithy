// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam (#817).
 *
 * One per management act, each emitted once, when the act changed something. A replayed idempotency key
 * and an act that found the entry already where it asked to put it emit nothing, because nothing moved.
 * The reads are not audited: a board's standings are what every player already sees, and the moderation
 * state beside them is recorded by the acts that set it.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit` — the seam is always present (`noopEmit`
 * when no audit capability is composed), so there is no null check and no hard dependency.
 */
export const LeaderboardAuditActions = {
  /** A management client hid an entry from every read. */
  entryHidden: "leaderboard/entry_hidden",
  /** A management client put a hidden entry back on the board. */
  entryUnhidden: "leaderboard/entry_unhidden",
  /** A management client changed an entry's score. The original is on the event and in the history. */
  entryCorrected: "leaderboard/entry_corrected",
  /** A management client released a stale rank-refresh lock. */
  lockCleared: "leaderboard/lock_cleared",
} as const;

/** One of the leaderboard capability's audit actions. */
export type LeaderboardAuditAction = (typeof LeaderboardAuditActions)[keyof typeof LeaderboardAuditActions];
