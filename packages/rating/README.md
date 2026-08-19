# @pithy-sh/rating

Skill and experience for your games. Two numbers per player, per pool: a skill rating (MMR) that moves both ways with every result and feeds matchmaking, and an experience total (XP) that only ever rises and drives rank.

They are separate on purpose. One number cannot both rank a player fairly and reward them for turning up — a ladder that pays out for playing stops estimating strength, and a rating that only estimates strength has nothing to show a player who is not winning yet.

Everything lives in your own D1, in one table you can join against your own. This is the input system [`@pithy-sh/leaderboard`](../leaderboard) deliberately left out: a leaderboard ranks what has happened, a rating estimates what will. It is also the skill source [`@pithy-sh/matchmaking`](../matchmaking) buckets its open queue on.

## Add it

```bash
pithy add rating
```

That installs the package, writes the `DB` binding into every environment of your Worker's `wrangler.jsonc`, and scaffolds the config block below. Then:

```bash
pithy migrate
```

## Configure it

```ts
rating({
  games: [
    // 1v1, transparent Elo, its own pool, XP on top.
    { key: "duel", algorithm: "elo", xp: { win: 20, draw: 10, loss: 5 } },
    // A 4-player free-for-all — only TrueSkill fits — pooled with everything else in `global`.
    { key: "ffa", algorithm: "trueskill", players: 4, pool: "global" },
  ],
  serverAuthoritative: true,   // default. A client cannot report that it won.
  recordScope: "rating:record",
})
```

Every game is validated at assembly, not at the first recorded result. An unknown algorithm id, a roster the algorithm cannot rate, a team format on an algorithm with no team model, or `algoParams` the algorithm refuses all fail on deploy.

## Two numbers

- **Skill rating (MMR)** — moves both ways, weighted by opponent strength, and hideable per game with `hideSkill`. A hidden rating still drives matchmaking; the player-facing read returns XP, rank, and games with a `null` skill.
- **Experience (XP)** — monotonic, visible, and the input to an optional level ladder (`levels: [{ key: "bronze", from: 0 }, …]`, worst to best).

By default only games against strangers count toward XP and rank: a result played in a shared room with a friend counts only when the game sets `sharedRoomCounts: true`, so friends cannot farm each other to climb. Skill rating always updates from a real result either way.

## Pools

A pool is what a rating is *of*. It defaults to the game key — a rating per game — and naming one explicitly shares a ladder:

```ts
{ key: "blitz",   algorithm: "glicko", pool: "chess" }
{ key: "classic", algorithm: "glicko", pool: "chess" }   // one rating across both time controls
```

A pool is rated by a single algorithm, because the stored state is that algorithm's own — the row records which algorithm wrote it, and a read validates the blob against it. Point two games with different algorithms at one pool and the second one to write is reinterpreting the first one's state.

## Choosing an algorithm

| Algorithm | Players | Teams | Use it when |
|---|---|---|---|
| `elo` | 2 | no | You want a number players can reason about, and a single K-factor to tune. |
| `glicko` | 2 | no | Players come and go. Glicko-2 carries an uncertainty term, so someone returning on stale form is not rated as if they never left. |
| `trueskill` | 2+ | yes | Any roster bigger than a duel, or any result with a team grouping. The only built-in that rates teams. |

Register your own with `registerRatingAlgorithm(yourAlgorithm)` in your worker entry, before the capability assembles. See [`docs/algorithms.md`](./docs/algorithms.md) for the tradeoffs and the maths.

**The choice is immutable in practice.** A stored rating means nothing under a different model, so changing a pool's algorithm is a new pool, not a migration.

## Writes are server-authoritative by default

Recording an outcome needs the `rating:record` scope. Mint it for your trusted server's token and never for a player's:

```
POST /rating/games/duel/outcomes
{ "ranks": { "u1": 1, "u2": 2 } }   // finishing place per user id; 1 wins, ties share a place
```

The body carries the result and nothing else — the pool comes from config, the algorithm from the pool, the timestamp from the server's clock. A rating a client can write is a rating a client can invent, and every ladder, queue, and rank downstream of it inherits the lie. Set `serverAuthoritative: false` to let players post their own results, and accept that.

## Routes

| Route | Strategy |
|---|---|
| `POST /rating/games/:game/outcomes` | bearer \| session + record scope |
| `GET /rating/games/:game/me` | bearer \| session |
| `GET /rating/games/:game/players/:userId` | bearer \| session |

There is no public surface. A rating with no authenticated player has nothing to key on. Rating depends on core's `AuthContext` seam and never on `@pithy-sh/auth` internals — without auth installed every route above denies, which is the right failure rather than an open one.

Mount elsewhere with `basePath`.

## What it stores

One table, `pithy_rating_ratings`, created by `pithy migrate`: one row per (pool, player) holding the algorithm's own state blob, the derived skill number, the XP total, the games played, and when it last changed. The skill column is indexed, because bucketing a matchmaking queue is a range read over it.

Nothing else. There is no board table, no history table, and no config in the database — the games are `pithy.config.ts`, reviewed and deployed like the rest of your app.

## Bindings

| Binding | Kind | Why |
|---|---|---|
| `DB` | D1 | The one table. The same app database your other capabilities use. |

`pithy add rating` writes it into every environment stanza. Nothing here needs provisioning beyond the database you already have.
