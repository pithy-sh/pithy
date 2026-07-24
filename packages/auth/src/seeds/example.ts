import { EXAMPLE_IDENTITIES } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { User } from "../data/betterAuth";

/**
 * Where the example set sorts among the whole project's seed registry. Auth seeds the identities
 * first — before the leaderboard/wallet/multiplayer example sets, which reference these same users
 * by id — so `order` encodes that dependency, exactly like the migration registry.
 */
const AUTH_EXAMPLE_SEED_ORDER = 100;

/**
 * The canonical demo cast ({@link EXAMPLE_IDENTITIES}) as `pithy_auth_users` rows — the shared,
 * passwordless test identities every other capability's example seed references by `userId`. No
 * `Account`/`Session`/password rows: these are the users, not a signed-in session, and Pithy is
 * passwordless-only regardless. `emailVerified` is true so a seeded identity behaves exactly like a
 * user who has completed magic-link/OTP verification. Composed in only when the project turns on
 * `seed.includeExamples` (`pithy.config.ts`), and only for `dev` and `staging` — an example fixture
 * never targets production, regardless of that setting.
 */
export const authExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: AUTH_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup(
      "app",
      "pithyAuthUsers",
      User,
      EXAMPLE_IDENTITIES.map((identity) => ({
        id: identity.id,
        name: identity.name,
        email: identity.email,
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    ),
  ],
});
