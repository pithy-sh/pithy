// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { RatingPeer } from "@pithy-sh/rating/src/peer";
import { describe, expect, test } from "vitest";
import { readSkill } from "./skill";

/**
 * Rating reaches the queue from the composition, never through an import (#645): `matchmaking()`'s `compose`
 * hook finds `rating()`'s `ratingPeer` and the route hands it here. What is left to prove is that an absent or
 * unreadable rating is a region-only queue, never a failed one.
 */
const d1 = {} as D1Database;

/** A rating surface whose store answers `get` with what the case says. */
function rating(get: () => Promise<{ skill: number } | undefined>): RatingPeer {
  return {
    ratingDatabase: () => ({}) as never,
    ratingStore: () => ({ get }) as never,
  } as unknown as RatingPeer;
}

describe("readSkill", () => {
  test("with no rating composed, a player has no skill to bucket by", async () => {
    expect(await readSkill(d1, "ranked", "alice", undefined)).toBeNull();
  });

  test("reads the player's skill through the rating it was handed", async () => {
    expect(
      await readSkill(
        d1,
        "ranked",
        "alice",
        rating(async () => ({ skill: 1510 })),
      ),
    ).toBe(1510);
  });

  test("an unrated player, or a pool nobody migrated, is null rather than a failure", async () => {
    expect(
      await readSkill(
        d1,
        "ranked",
        "alice",
        rating(async () => undefined),
      ),
    ).toBeNull();
    expect(
      await readSkill(
        d1,
        "ranked",
        "alice",
        rating(async () => {
          throw new Error("no such table: pithy_rating_ratings");
        }),
      ),
    ).toBeNull();
  });
});
