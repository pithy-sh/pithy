// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthPeer } from "@pithy-sh/auth/src/peer";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { RatingPeer } from "@pithy-sh/rating/src/peer";

/**
 * **The optional peers matchmaking reads, as the composition handed them over** (#645).
 *
 * An invite resolves an address through `@pithy-sh/auth`, and a skill-bucketed queue reads `@pithy-sh/rating`.
 * Both are optional, and both used to be reached by `import()` inside a `try` — optional at runtime and
 * required at bundle time, because wrangler's esbuild resolves a literal specifier whether or not the branch
 * holding it ever runs. A project without either could not bundle matchmaking at all.
 *
 * So `matchmaking()`'s `compose` hook finds each peer's surface among the composed capabilities, and the
 * routes read it from here. Only types name the two packages, and a bundler never sees a type.
 */
export interface MatchmakingPeers {
  /** `auth()`'s surface, when it is composed. */
  readonly auth?: AuthPeer;
  /** `rating()`'s surface, when it is composed. */
  readonly rating?: RatingPeer;
}

/** The named capability's peer surface, when it is composed and carries one. */
function surface<T>(capabilities: readonly Capability[], name: string, key: string): T | undefined {
  const found = capabilities.find((capability) => capability.name === name && key in capability);
  return found ? ((found as unknown as Record<string, unknown>)[key] as T) : undefined;
}

/** The peers this composition holds. */
export function matchmakingPeers(capabilities: readonly Capability[]): MatchmakingPeers {
  const auth = surface<AuthPeer>(capabilities, "auth", "authPeer");
  const rating = surface<RatingPeer>(capabilities, "rating", "ratingPeer");
  return { ...(auth ? { auth } : {}), ...(rating ? { rating } : {}) };
}
