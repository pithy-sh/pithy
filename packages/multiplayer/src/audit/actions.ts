// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions multiplayer emits, through the core `emit()` seam — never by importing `@pithy-sh/audit`.
 *
 * One per management act, and only when the act changed something: a replay of an idempotency key, a void of a
 * result already void with every consumer done, and a refused request emit nothing. Each carries the connection,
 * the session, the game and the reason the operator gave.
 */
export const MultiplayerAuditActions = {
  /** A management client closed a session in flight. */
  sessionClosed: "multiplayer/session_closed",
  /** A management client voided a result, or retried the consumers a void left unfinished. */
  resultVoided: "multiplayer/result_voided",
} as const;

/** One of multiplayer's audit actions. */
export type MultiplayerAuditAction = (typeof MultiplayerAuditActions)[keyof typeof MultiplayerAuditActions];
