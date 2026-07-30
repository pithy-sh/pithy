// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add matchmaking` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config/options types, and the two Durable Object classes (which
 * must be re-exported here so wrangler's `class_name` resolves against the worker entry). Every other
 * module is imported by deep path; this is the documented contract, not a barrel.
 */

export {
  isMatchmakingCapability,
  MATCHMAKING_MIGRATION_ORDER,
  type MatchmakingCapability,
  type MatchmakingOptions,
  matchmaking,
} from "./capability";
export {
  MatchmakingConfig,
  type MatchmakingConfigInput,
  MatchmakingGame,
  MatchmakingQueueSettings,
  MatchmakingRoomCodes,
  MatchmakingSnapshot,
  resolveGame,
} from "./config/config";
export { FriendStatus, Friendship } from "./data/friend";
export { Invite, InviteStatus } from "./data/invite";
export { MatchmakingPresence } from "./presence/durableObject";
export { MatchmakingQueue } from "./queue/durableObject";
