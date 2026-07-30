// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LeaderboardTier, ScoreDirection } from "../config/config";

/**
 * Classify a score into one of the board's tiers, or null if it reaches none.
 *
 * Tiers are a read-side classification over the score already stored — no tier column, no write-side
 * cost, and no second board type. Config validates that tiers are listed worst to best in the board's
 * direction, so the last one the score qualifies for is the best one it qualifies for.
 *
 * This is not the bucketed-cohort model (Duolingo leagues, Clash Royale arenas), which needs durable
 * per-window cohort assignment and provably cannot be a view over a global board. That is deferred.
 */
export function classifyTier(
  tiers: readonly LeaderboardTier[] | undefined,
  direction: ScoreDirection,
  score: number,
): string | null {
  if (!tiers || tiers.length === 0) return null;
  let reached: string | null = null;
  for (const tier of tiers) {
    const qualifies = direction === "desc" ? score >= tier.from : score <= tier.from;
    if (!qualifies) break;
    reached = tier.key;
  }
  return reached;
}
