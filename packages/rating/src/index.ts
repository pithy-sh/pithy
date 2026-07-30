// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add rating` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config/options types, the rating-algorithm seam (so an adopter can
 * register their own), the built-in algorithms, and the read/record shapes an app renders. Every other
 * module is imported by deep path (`@pithy-sh/rating/src/...`); this is the documented contract, not a
 * barrel over the package.
 */

export type { RatedOutcome, RatingAlgorithm, RatingEntry } from "./algorithm/algorithm";
export { elo } from "./algorithm/builtins/elo";
export { glicko } from "./algorithm/builtins/glicko";
export { trueskill } from "./algorithm/builtins/trueskill";
export {
  algorithmBounds,
  registeredAlgorithmIds,
  registerRatingAlgorithm,
  resolveAlgorithm,
} from "./algorithm/registry";
export {
  isRatingCapability,
  RATING_MIGRATION_ORDER,
  type RatingCapability,
  type RatingOptions,
  rating,
} from "./capability";
export {
  configuredPools,
  RatingConfig,
  type RatingConfigInput,
  RatingGame,
  RatingLevel,
  RatingXpAward,
  type ResolvedRatingGame,
  resolveGame,
  validateRatingGames,
} from "./config/config";
export { RatingRecord } from "./data/rating";
export { awardXp, classifyLevel, type XpOutcome, xpFor } from "./experience/xp";
export { type RecordedPlayer, type RecordOutcomeInput, recordOutcome } from "./record/record";
