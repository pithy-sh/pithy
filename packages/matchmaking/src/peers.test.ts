// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { authPeer } from "@pithy-sh/auth/src/peer";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { rating } from "@pithy-sh/rating/src/capability";
import { describe, expect, test } from "vitest";
import { type MatchmakingOptions, matchmaking } from "./capability";

/**
 * **A peer the config uses is refused at assembly when this Worker cannot reach it** (#645 review).
 *
 * Reproduced before the fix: a pre-#645 auth read as absent, so an invite by address answered 404 for a user who
 * exists; a pre-#645 rating, or none, bucketed a skill-pooled queue by region alone. Neither said anything.
 */

const SNAPSHOT = { kind: "connect-n", mode: "match" as const, turnTimeoutMs: null, rules: {} };
const DUEL = { key: "duel", snapshot: SNAPSHOT };
const RANKED = { key: "ranked", skillPool: "elo", snapshot: SNAPSHOT };

/** A pre-#645 release: the capability's name and config field, and no peer surface. */
const OLD_AUTH = { name: "auth", authConfig: {} } as unknown as Capability;
const OLD_RATING = { name: "rating", ratingConfig: {} } as unknown as Capability;
const AUTH = { name: "auth", authConfig: {}, authPeer } as unknown as Capability;
const RATING = rating({ games: [{ key: "chess", algorithm: "elo", pool: "elo" }] }) as Capability;

/** Assemble one Worker, as `createEntrypoint` does, and return what it refused with. */
function refusal(options: MatchmakingOptions, siblings: Capability[]): PithyError["payload"] | undefined {
  const composed = [...siblings, matchmaking(options)];
  try {
    for (const capability of composed) capability.compose?.({ capabilities: composed });
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return (error as PithyError).payload;
  }
}

describe("rating, for a game that buckets its queue by skill", () => {
  test("a skill-pooled game with no rating in this Worker is refused, naming the game, its pool and the fix", () => {
    const said = refusal({ games: [RANKED] }, [AUTH]);
    expect(said?.message).toBe("A game buckets its queue by skill, and no rating is composed in this Worker.");
    expect(said?.action).toContain("Add `rating(...)` to this Worker's capabilities");
    expect(said?.detail).toContain('ranked (pool "elo")');
  });

  test("a rating too old to carry its surface is refused", () => {
    expect(refusal({ games: [RANKED] }, [AUTH, OLD_RATING])?.message).toBe(
      "Matchmaking buckets a queue by skill through @pithy-sh/rating, and the composed one is too old to be reached.",
    );
  });

  test("a skill-pooled game beside a current rating composes", () => {
    expect(refusal({ games: [RANKED] }, [AUTH, RATING])).toBeUndefined();
  });

  test("a game with no skill pool needs no rating", () => {
    expect(refusal({ games: [DUEL] }, [AUTH])).toBeUndefined();
  });
});

describe("auth, for an invite resolved by address", () => {
  test("an auth too old to carry its surface is refused rather than answering 404 for a user who exists", () => {
    const said = refusal({ games: [DUEL] }, [OLD_AUTH]);
    expect(said?.message).toBe(
      "Matchmaking resolves an invite by address through @pithy-sh/auth, and the composed one is too old to be reached.",
    );
    expect(said?.action).toBe("Upgrade @pithy-sh/auth to the version this @pithy-sh/matchmaking peers.");
  });

  test("no auth at all composes: every route is gated and denies, which is not quiet", () => {
    expect(refusal({ games: [DUEL] }, [])).toBeUndefined();
  });
});
