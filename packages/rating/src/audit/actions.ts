// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions rating emits through core's `c.var.emit` seam — never by importing `@pithy-sh/audit`,
 * so with no audit capability composed they land on `noopEmit` and nothing null-checks (#818).
 *
 * **Every act, and only acts.** A recalculate or a reset rewrites somebody's standing, so each emits one
 * event, severity `warning`, carrying the rating before and after and the reason verbatim. A replayed key
 * emits nothing, because nothing happened. The reads are not audited: a rating is a number a player's
 * opponents already see, unlike a ledger's entry log, and auditing every page of a leaderboard-shaped list
 * would bury the acts that matter.
 */
export const RatingAuditActions = {
  /** A management client rebuilt a player's rating from the outcome log. */
  recalculated: "rating/player_recalculated",
  /** A management client returned a player's rating to the algorithm's starting state. */
  reset: "rating/player_reset",
} as const;

/** One of rating's audit actions. */
export type RatingAuditAction = (typeof RatingAuditActions)[keyof typeof RatingAuditActions];
