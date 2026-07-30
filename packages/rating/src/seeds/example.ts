// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { RatingRecord } from "../data/rating";
import { RATING_RATINGS_TABLE } from "../data/tables";

/**
 * Three canonical example players in a `demo` pool rated by Elo — the same cast auth seeds. Ada leads on
 * skill and experience, Alan trails; a shape you can read a `/rating/games/<key>/me` response against
 * immediately after `pithy seed`. Never runs in production.
 */
const RATING_EXAMPLE_SEED_ORDER = 210;
const now = () => new Date();

export const ratingExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: RATING_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", RATING_RATINGS_TABLE, RatingRecord, [
      {
        id: 1,
        pool: "demo",
        userId: EXAMPLE_ADA.id,
        algorithm: "elo",
        state: { rating: 1560 },
        skill: 1560,
        xp: 120,
        games: 8,
        updatedAt: now(),
      },
      {
        id: 2,
        pool: "demo",
        userId: EXAMPLE_GRACE.id,
        algorithm: "elo",
        state: { rating: 1500 },
        skill: 1500,
        xp: 90,
        games: 6,
        updatedAt: now(),
      },
      {
        id: 3,
        pool: "demo",
        userId: EXAMPLE_ALAN.id,
        algorithm: "elo",
        state: { rating: 1440 },
        skill: 1440,
        xp: 60,
        games: 5,
        updatedAt: now(),
      },
    ]),
  ],
});
