// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { LeaderboardPeer } from "@pithy-sh/leaderboard/src/peer";
import type { LedgerPeer } from "@pithy-sh/ledger/src/peer";

/**
 * **The optional peers a session reaches, as the composition handed them over** (#645).
 *
 * A session settles wagers through `@pithy-sh/ledger` and publishes results to `@pithy-sh/leaderboard`, and
 * both are optional: a game with no stakes never touches the ledger, a game with no board never touches the
 * leaderboard. Both used to be reached by `import()` inside a `try`, which is optional at runtime and required
 * at bundle time — wrangler's esbuild resolves a literal specifier whether or not the branch holding it ever
 * runs, so a project without either package could not bundle the session at all.
 *
 * So they arrive from the composition. `multiplayer()`'s `compose` hook finds each peer's surface among the
 * composed capabilities and records it here; the session reads it. Module state, because the Durable Object is
 * constructed by the runtime rather than by the factory, and it shares the isolate the Worker entry composed
 * in — the same reason the game-model registry beside it is module state. Only types name the two packages,
 * and a bundler never sees a type.
 */
export interface MultiplayerPeers {
  /** `ledger()`'s surface, when it is composed. */
  readonly ledger?: LedgerPeer;
  /** `leaderboard()`'s surface, when it is composed. */
  readonly leaderboard?: LeaderboardPeer;
}

let composed: MultiplayerPeers = {};

/** Whether a composed capability carries the named peer surface. */
function surface<T>(capabilities: readonly Capability[], name: string, key: string): T | undefined {
  const found = capabilities.find((capability) => capability.name === name && key in capability);
  return found ? ((found as unknown as Record<string, unknown>)[key] as T) : undefined;
}

/** Record the peers this composition holds. Called by `multiplayer()`'s `compose` hook, once per assembly. */
export function composeMultiplayerPeers(capabilities: readonly Capability[]): void {
  const ledger = surface<LedgerPeer>(capabilities, "ledger", "ledgerPeer");
  const leaderboard = surface<LeaderboardPeer>(capabilities, "leaderboard", "leaderboardPeer");
  composed = { ...(ledger ? { ledger } : {}), ...(leaderboard ? { leaderboard } : {}) };
}

/** The peers the composition handed over — empty before `compose` has run, or when none is composed. */
export function multiplayerPeers(): MultiplayerPeers {
  return composed;
}
