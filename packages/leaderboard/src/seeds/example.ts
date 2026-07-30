// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { LeaderboardEntry } from "../data/entry";
import { LEADERBOARD_ENTRIES_TABLE } from "../data/tables";

/**
 * Where the example set sorts among the whole project's seed registry. It runs after `auth` (100),
 * whose example seeds the users these entries belong to, so the owning identities exist first — the
 * order encodes that dependency, exactly like the migration registry. It need not line up with
 * {@link LEADERBOARD_MIGRATION_ORDER} (a different registry, composed separately by `pithy seed`).
 */
const LEADERBOARD_EXAMPLE_SEED_ORDER = 200;

const now = () => new Date();

/**
 * A tiny demo board's worth of entries — the three canonical example users ({@link EXAMPLE_ADA} et al.)
 * on an all-time board named `demo`. The `userId`s are the shared cast from `@pithy-sh/core`, so these
 * scores belong to the same users `auth` seeds and `ledger`/`multiplayer` also reference: `pithy seed`
 * fills a fresh backend with connected data, not isolated rows. Composed in only when the project turns
 * on `seed.includeExamples` (`pithy.config.ts`), and only for `dev` and `staging` — an example fixture
 * never targets production, regardless of that setting.
 */
export const leaderboardExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: LEADERBOARD_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", LEADERBOARD_ENTRIES_TABLE, LeaderboardEntry, [
      {
        id: 1,
        boardId: "demo",
        windowKey: "all",
        userId: EXAMPLE_ADA.id,
        score: 300,
        achievedAt: now(),
        submittedAt: now(),
        visible: true,
        hidden: false,
        rank: null,
      },
      {
        id: 2,
        boardId: "demo",
        windowKey: "all",
        userId: EXAMPLE_GRACE.id,
        score: 250,
        achievedAt: now(),
        submittedAt: now(),
        visible: true,
        hidden: false,
        rank: null,
      },
      {
        id: 3,
        boardId: "demo",
        windowKey: "all",
        userId: EXAMPLE_ALAN.id,
        score: 200,
        achievedAt: now(),
        submittedAt: now(),
        visible: true,
        hidden: false,
        rank: null,
      },
    ]),
  ],
});
