/**
 * The package entrypoint — the surface `pithy add leaderboard` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, and the read shapes an app renders. Every
 * other module is imported by deep path (`@pithy-sh/leaderboard/src/...`); this is the documented
 * contract, not a barrel over the package.
 */

export {
  isLeaderboardCapability,
  LEADERBOARD_MIGRATION_ORDER,
  type LeaderboardCapability,
  type LeaderboardOptions,
  leaderboard,
  needsRankWorker,
} from "./capability";
export {
  LeaderboardBoard,
  LeaderboardConfig,
  type LeaderboardConfigInput,
  LeaderboardRank,
  LeaderboardStore,
  LeaderboardTier,
  materializeSchedule,
  resolveBoard,
  ScoreAggregation,
  ScoreDirection,
} from "./config/config";
export { LeaderboardEntry } from "./data/entry";
export type { OwnRank } from "./http/handlers";
export { MAX_SEGMENT_SIZE, type RankedEntry } from "./rank/query";
export { classifyTier } from "./rank/tiers";
export { BOOKMARK_HEADER } from "./session/bookmark";
export { ALL_TIME_WINDOW, previousWindowKeys, windowKeyAt } from "./window/schedule";
