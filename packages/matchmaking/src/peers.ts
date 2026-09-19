// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthPeer } from "@pithy-sh/auth/src/peer";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { RatingPeer } from "@pithy-sh/rating/src/peer";
import type { MatchmakingConfig } from "./config/config";

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
 *
 * **Nothing degrades silently (#645 review).** A game with a `skillPool` and no rating composed in this Worker is
 * refused at assembly — it used to bucket by region alone and say nothing. A composed auth or rating released
 * before its surface is refused whatever the config says: read as absent, an invite by address answered 404 for
 * a user who exists. Auth that is not composed here at all proceeds, because it is not quiet — every route is
 * `requireAuth()`-gated and denies.
 */
export interface MatchmakingPeers {
  /** `auth()`'s surface, when it is composed. */
  readonly auth?: AuthPeer;
  /** `rating()`'s surface, when it is composed. */
  readonly rating?: RatingPeer;
}

/**
 * The named kit capability's peer surface: `undefined` when it is not composed, or a refusal when it is composed
 * from a release too old to carry one. Recognized by the config field it has always carried, not by the surface,
 * because a pre-#645 release has the one and not the other.
 */
function surface<T>(
  capabilities: readonly Capability[],
  peer: { name: string; pkg: string; config: string; key: string; probe: string; wants: string },
): T | undefined {
  const found = capabilities.find((capability) => capability.name === peer.name && peer.config in capability);
  if (found === undefined) return undefined;
  const value = (found as unknown as Record<string, Record<string, unknown> | undefined>)[peer.key];
  if (typeof value?.[peer.probe] !== "function") {
    throw new ValidationError({
      message: `The composed ${peer.name} is too old for matchmaking to ${peer.wants}.`,
      action: `Upgrade ${peer.pkg} to the version this @pithy-sh/matchmaking peers.`,
      detail: `The composed ${peer.name} capability carries no \`${peer.key}\`. It was released before optional peers arrived through the composition (#645).`,
    });
  }
  return value as T;
}

/** The peers this composition holds — refusing one the config needs and this Worker cannot reach. */
export function matchmakingPeers(capabilities: readonly Capability[], config: MatchmakingConfig): MatchmakingPeers {
  const auth = surface<AuthPeer>(capabilities, {
    name: "auth",
    pkg: "@pithy-sh/auth",
    config: "authConfig",
    key: "authPeer",
    probe: "authDatabase",
    wants: "resolve an invite by address",
  });
  const rating = surface<RatingPeer>(capabilities, {
    name: "rating",
    pkg: "@pithy-sh/rating",
    config: "ratingConfig",
    key: "ratingPeer",
    probe: "ratingStore",
    wants: "bucket a queue by skill",
  });
  const skilled = config.games.filter((game) => game.skillPool !== undefined);
  const keys = skilled.map((game) => `"${game.key}"`);
  const named =
    keys.length === 1 ? `game ${keys[0]}` : `games ${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
  if (skilled.length > 0 && rating === undefined) {
    throw new ValidationError({
      message: `No rating is composed in this Worker, and ${named} ${skilled.length === 1 ? "buckets its" : "bucket their"} queue by skill through it.`,
      action: `Compose \`rating(...)\` in this Worker, or turn skill matching off by removing \`skillPool\` from ${named}.`,
      detail: `Games with a skillPool: ${skilled.map((game) => `${game.key} (pool "${game.skillPool}")`).join(", ")}. Without rating every player would be bucketed by region alone.`,
    });
  }
  return { ...(auth ? { auth } : {}), ...(rating ? { rating } : {}) };
}
