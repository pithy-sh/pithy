import type { RatingLevel, RatingXpAward } from "../config/config";

/**
 * Experience is the visible progression — a monotonic total that only ever rises, distinct from the
 * skill rating that moves both ways. This module owns the two pure rules: how an award folds into the
 * total, and how a total classifies into a rank/level.
 */

/** A player's outcome in a single game, for the purpose of an XP award. */
export type XpOutcome = "win" | "draw" | "loss";

/** Fold an award into the running total. XP never decreases: a negative award is clamped to zero. */
export function awardXp(current: number, award: number): number {
  return current + Math.max(0, award);
}

/** The XP a given outcome is worth under a game's award table. */
export function xpFor(award: RatingXpAward, outcome: XpOutcome): number {
  return award[outcome];
}

/**
 * The rank/level a total earns, from a worst-to-best ladder — the best rung whose `from` the total has
 * reached, or `null` when it has not reached the first rung. The ladder is sorted defensively so order in
 * config never changes the answer.
 */
export function classifyLevel(levels: readonly RatingLevel[], xp: number): string | null {
  let current: string | null = null;
  for (const level of [...levels].sort((a, b) => a.from - b.from)) {
    if (xp >= level.from) current = level.key;
  }
  return current;
}
