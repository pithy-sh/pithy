import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { LedgerAccount } from "../data/account";
import { LEDGER_ACCOUNTS_TABLE } from "../data/tables";

/**
 * Where the example set sorts among the whole project's seed registry. It runs after `auth` (100),
 * whose example seeds the users these accounts belong to, so the owning identities exist first — the
 * order encodes that dependency, exactly like the migration registry. It need not line up with
 * {@link LEDGER_MIGRATION_ORDER} (a different registry, composed separately by `pithy seed`).
 */
const LEDGER_EXAMPLE_SEED_ORDER = 200;

const now = () => new Date();

/**
 * A demo balance for each canonical example user ({@link EXAMPLE_ADA} et al.), in a demo currency
 * named `coins`. The `userId`s are the shared cast from `@pithy-sh/core`, so these balances belong to
 * the same users `auth` seeds and `leaderboard`/`multiplayer` also reference: `pithy seed` fills a
 * fresh backend with connected data, not isolated rows. `held` stays `0` — the demo accounts have no
 * open holds, satisfying the ledger's `CHECK (balance >= 0 AND held >= 0 AND held <= balance)`
 * invariant trivially. Composed in only when the project turns on `seed.includeExamples`
 * (`pithy.config.ts`), and only for `dev` and `staging` — an example fixture never targets
 * production, regardless of that setting.
 */
export const ledgerExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: LEDGER_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", LEDGER_ACCOUNTS_TABLE, LedgerAccount, [
      {
        id: 1,
        userId: EXAMPLE_ADA.id,
        currency: "coins",
        balance: 1000,
        held: 0,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: 2,
        userId: EXAMPLE_GRACE.id,
        currency: "coins",
        balance: 500,
        held: 0,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: 3,
        userId: EXAMPLE_ALAN.id,
        currency: "coins",
        balance: 750,
        held: 0,
        createdAt: now(),
        updatedAt: now(),
      },
    ]),
  ],
});
