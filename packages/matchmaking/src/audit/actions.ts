// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions matchmaking emits, through the core `emit()` seam — never by importing `@pithy-sh/audit`.
 *
 * One per management act, and only when the act changed something: a replay of an idempotency key and a refused
 * request emit nothing. Each carries the connection, the game, the target and the reason the operator gave.
 */
export const MatchmakingAuditActions = {
  /** A management client canceled a pending invite. */
  inviteCanceled: "matchmaking/invite_canceled",
  /** A management client dropped a player from a game's open queue. */
  queuePlayerDropped: "matchmaking/queue_player_dropped",
} as const;

/** One of matchmaking's audit actions. */
export type MatchmakingAuditAction = (typeof MatchmakingAuditActions)[keyof typeof MatchmakingAuditActions];
