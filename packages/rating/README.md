# @pithy-sh/rating

Skill and experience for your games. Two numbers per player, per pool: a skill rating (MMR) that moves up and down with each result and feeds matchmaking, and an experience total (XP) that only ever rises and drives rank. The rating algorithm is pluggable — `elo`, `glicko` (Glicko-2), or `trueskill` ship built in, and you can register your own.

It is the "a rating is an input" system `@pithy-sh/leaderboard` deliberately left out, and the skill source `@pithy-sh/matchmaking` buckets on.

## Add it

```ts
import { rating } from "@pithy-sh/rating";

rating({
  games: [
    // 1v1, transparent Elo, its own pool, XP on top.
    { key: "duel", algorithm: "elo", xp: { win: 20, draw: 10, loss: 5 } },
    // A 4-player free-for-all — only TrueSkill fits, pooled globally.
    { key: "ffa", algorithm: "trueskill", players: 4, pool: "global" },
  ],
});
```

Wiring a 1v1-only algorithm (`elo`/`glicko`) to a game with more than two players fails on deploy, not at runtime.

## Two numbers

- **Skill rating (MMR)** — moves both ways, weighted by opponent strength, hideable per game (`hideSkill`). The matchmaking input.
- **Experience (XP)** — monotonic, visible, drives an optional rank/level ladder.

By default only games against strangers count toward XP and rank; a game played in a shared room with a friend counts only when it opts in with `sharedRoomCounts`. Skill rating always updates from a real result.

## Record and read

- `POST /rating/games/:game/outcomes` — record a result (server-authoritative; needs the record scope). Body: `{ ranks, teams?, sharedRoom? }`.
- `GET /rating/games/:game/me` — your skill, XP, rank, and games in the game's pool.
- `GET /rating/games/:game/players/:userId` — another player's standing.

Every route requires a session or bearer token.

## Choosing an algorithm

See [`docs/algorithms.md`](./docs/algorithms.md) for the tradeoffs, which player counts each supports, and how to pick.
