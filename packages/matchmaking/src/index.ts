// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add matchmaking` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory and its config/options types. Every other module is imported by deep
 * path; this is the documented contract, not a barrel.
 *
 * **The two Durable Objects are deliberately not here.** `MatchmakingQueue` and `MatchmakingPresence`
 * import `cloudflare:workers`, which resolves in workerd and nowhere else, and this module is what an
 * adopter's `pithy.config.ts` imports — a file every Node-side CLI command loads. Re-exporting the classes
 * from here put both Durable Object chains on that path, so `pithy upgrade`, `pithy migrate`, and
 * `pithy deploy` would have died with "Could not load pithy.config.ts" for any project composing
 * matchmaking (#180, the defect `@pithy-sh/multiplayer` shipped as #172). The factory and the Durable
 * Objects are two things with two runtimes, and this entry point carries only the first.
 *
 * The adopter's worker still exports the classes, from their own modules:
 *
 * ```ts
 * export { MatchmakingQueue } from "@pithy-sh/matchmaking/src/queue/durableObject";
 * export { MatchmakingPresence } from "@pithy-sh/matchmaking/src/presence/durableObject";
 * ```
 *
 * — which is what wrangler's `class_name` resolves against, for the `QUEUE` and `PRESENCE` bindings
 * `matchmaking()` declares. The CLI writes the bindings and the class migration tags for you.
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
