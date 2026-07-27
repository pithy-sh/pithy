import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { Friendship } from "../data/friend";
import { Invite } from "../data/invite";
import { MATCHMAKING_FRIENDS_TABLE, MATCHMAKING_INVITES_TABLE } from "../data/tables";

/**
 * A small social graph among the example cast: Ada and Grace are friends, and Alan has a pending invite
 * out to Ada. Enough to read a `/matchmaking/friends` and `/matchmaking/invites` response against right
 * after `pithy seed`. Never runs in production.
 */
const MATCHMAKING_EXAMPLE_SEED_ORDER = 220;
const now = () => new Date();

// Friend pairs are stored canonically (userA < userB); sort the two ids so the seed matches the store.
const [friendA, friendB] = [EXAMPLE_ADA.id, EXAMPLE_GRACE.id].sort();

export const matchmakingExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: MATCHMAKING_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", MATCHMAKING_FRIENDS_TABLE, Friendship, [
      {
        id: 1,
        userA: friendA ?? EXAMPLE_ADA.id,
        userB: friendB ?? EXAMPLE_GRACE.id,
        status: "accepted",
        requestedBy: EXAMPLE_ADA.id,
        createdAt: now(),
        updatedAt: now(),
      },
    ]),
    d1SeedGroup("app", MATCHMAKING_INVITES_TABLE, Invite, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        gameKey: "duel",
        inviterId: EXAMPLE_ALAN.id,
        inviteeId: EXAMPLE_ADA.id,
        status: "pending",
        sessionId: null,
        createdAt: now(),
        respondedAt: null,
      },
    ]),
  ],
});
