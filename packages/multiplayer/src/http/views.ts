// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MultiplayerResult } from "../data/result";
import type { MultiplayerSessionEntry } from "../data/session";
import type { AdminResultView, AdminSessionListItem, SessionResult } from "./responses";

/**
 * The projections from a stored row to what a route answers, each returning its schema's type so a field one side
 * forgets is a red build. Dates leave as ISO-8601 strings.
 */

/** A result as its players read it: how it ended, and whether it was voided. Never the void's key or consumers. */
export function sessionResultView(result: MultiplayerResult): SessionResult {
  return {
    id: result.id,
    sessionId: result.sessionId,
    gameKey: result.gameKey,
    status: result.status,
    players: result.players,
    scores: result.scores,
    winnerUserId: result.winnerUserId,
    draw: result.draw,
    createdAt: result.createdAt.toISOString(),
    resolvedAt: result.resolvedAt.toISOString(),
    voidedAt: result.voidedAt?.toISOString() ?? null,
  };
}

/** A result as the management surface reads it, with what each consumer did with its void. */
export function adminResultView(result: MultiplayerResult): AdminResultView {
  return {
    sessionId: result.sessionId,
    gameKey: result.gameKey,
    status: result.status,
    players: result.players,
    scores: result.scores,
    winnerUserId: result.winnerUserId,
    draw: result.draw,
    createdAt: result.createdAt.toISOString(),
    resolvedAt: result.resolvedAt.toISOString(),
    voidedAt: result.voidedAt?.toISOString() ?? null,
    consumers: (result.voidConsumers ?? []).map(({ consumer, status, error }) => ({ consumer, status, error })),
  };
}

/** One session in flight, with its age at `now` in whole seconds — never negative, whatever the clocks say. */
export function adminSessionListItem(entry: MultiplayerSessionEntry, now: Date): AdminSessionListItem {
  return {
    sessionId: entry.sessionId,
    gameKey: entry.gameKey,
    phase: entry.phase,
    players: entry.players,
    openedAt: entry.openedAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor((now.getTime() - entry.openedAt.getTime()) / 1000)),
  };
}
