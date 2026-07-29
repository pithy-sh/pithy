import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { MultiplayerResult } from "../data/result";
import { MULTIPLAYER_RESULTS_TABLE } from "../data/tables";

/**
 * Where the example set sorts among the whole project's seed registry. It runs after `auth` (100),
 * whose example seeds the users this result belongs to, so the owning identities exist first — the
 * order encodes that dependency, exactly like the migration registry. It sits after leaderboard's own
 * example (200), matching migration order (multiplayer sits after leaderboard, at 500). It need not
 * line up with {@link MULTIPLAYER_MIGRATION_ORDER} (a different registry, composed separately by
 * `pithy seed`).
 */
const MULTIPLAYER_EXAMPLE_SEED_ORDER = 300;

const now = () => new Date();

/**
 * A single resolved demo match: Ada wins a `demo` session over Grace and Alan — the same shared cast
 * `auth` seeds and `leaderboard`/`ledger` also reference. The row is authored as the durable *result*
 * a session writes once it reaches its terminal state — the natural shape `pithy_multiplayer_results`
 * stores, not a live session (which lives only in the Durable Object while play is underway). Composed
 * in only when the project turns on `seed.includeExamples` (`pithy.config.ts`), and only for `dev` and
 * `staging` — an example fixture never targets production, regardless of that setting.
 */
export const multiplayerExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: MULTIPLAYER_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", MULTIPLAYER_RESULTS_TABLE, MultiplayerResult, [
      {
        id: 1,
        sessionId: "example000000000000000000000001",
        gameKey: "demo",
        status: "resolved",
        players: [EXAMPLE_ADA.id, EXAMPLE_GRACE.id, EXAMPLE_ALAN.id],
        scores: {
          [EXAMPLE_ADA.id]: 300,
          [EXAMPLE_GRACE.id]: 250,
          [EXAMPLE_ALAN.id]: 200,
        },
        winnerUserId: EXAMPLE_ADA.id,
        draw: false,
        createdAt: now(),
        resolvedAt: now(),
      },
    ]),
  ],
});
