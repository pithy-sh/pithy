# @pithy-sh/leaderboard

Rank your players. Submit a score, read the standings — daily through all-time.

Boards run in your Cloudflare account, on your D1, against your data. Closed windows stay as long as you say, in plain SQL you can join against your own tables. There is no Pithy service in the path and no Pithy bill — see [docs/costs.md](./docs/costs.md), and [docs/differentiation.md](./docs/differentiation.md) for why this exists next to Game Center.

## Add it

```bash
pithy add leaderboard
```

## Configure it

```ts
leaderboard({
  boards: [
    {
      key: "weekly-distance",   // a URL path segment, and the entry key
      store: "d1",              // which backing store ranks this board. `d1` only, today (see below).
      direction: "desc",        // highest wins. `asc` for lap times. Immutable once entries exist.
      aggregation: "best",      // best | latest | sum
      window: "0 0 * * 1",      // CRON, UTC. Omit for one all-time board.
      retain: 12,               // keep the last 12 closed windows. Omit to keep everything (default).
      min: 0,                   // server-side bounds. The anti-cheat baseline.
      max: 100_000,
      trackActivity: false,     // default. Non-improving submissions write nothing — the cost lever.
    },
  ],
  rank: "live",                 // or { materialize: "0 * * * *" } — read docs/costs.md first
})
```

## Boards are config, not rows

The board set lives in `pithy.config.ts`, reviewed and deployed like the rest of your app. There is no board admin screen and no board table to seed.

What the database records is only what config cannot: the entries, and a fingerprint of each board's `store`, `direction`, `aggregation`, and `window`. Those are immutable once a board has taken an entry, on every vendor surveyed and here — each one is the lens stored scores are read through, so changing one reinterprets data rather than reconfiguring behavior. Flip `direction` and last place becomes first. Change one and the next submission fails with `leaderboard/board_immutable` instead of silently corrupting the board.

**A board definition is not migratable.** Changing one of those fields means a new board key. The old board keeps its scores.

## Windows are CRON, so the calendar works

```
"0 0 * * *"    daily
"0 0 * * 1"    weekly, Mondays
"0 0 1 * *"    calendar month  ← Apple cannot express this; Google has no monthly at all
"0 0 1 1 *"    calendar year   ← unambiguously impossible on Game Center
undefined      all-time
```

Every window is UTC-anchored, and each carries its own aggregation state rather than being a filter over an append log. A score's window key is the instant its board's CRON last fired at or before it.

## Writes are server-authoritative by default

Every platform that offers this ships it off. This ships it on.

Submitting requires the `leaderboard:submit` scope. Mint it for your trusted server's token and never for a player's, and a device cannot post a score it invented:

```ts
POST /leaderboard/weekly-distance
{ "score": 4213 }
```

The body carries a score and nothing else. The player comes from the authenticated session, the timestamp from the server's clock, the rank from the data — a client that could name any of those could score as someone else or backdate its way past the tiebreak.

Set `serverAuthoritative: false` to let players post directly. That is the vendor default, which is why it is not ours.

## Routes

| Route | Strategy |
|---|---|
| `GET /leaderboard` | bearer \| session |
| `POST /leaderboard/:board` | bearer \| session + submit scope |
| `GET /leaderboard/:board/top` | bearer \| session |
| `POST /leaderboard/:board/segment` | bearer \| session |
| `GET /leaderboard/:board/me` | bearer \| session |
| `GET /leaderboard/:board/around` | bearer \| session |
| `PUT /leaderboard/:board/me/visibility` | bearer \| session |
| `PUT /leaderboard/:board/entries/:userId/hidden` | bearer \| session + admin scope |
| `DELETE /leaderboard/:board/entries/:userId` | bearer \| session + admin scope |

There is no public leaderboard surface. An entry with no authenticated player has nothing to key on, no way to upsert on improve, and no way to rate-limit — so an unauthenticated board is not a degraded board, it is an append log of unattributable scores. Leaderboard depends on core's `AuthContext` seam, never on `@pithy-sh/auth` internals; without auth installed, every route above denies.

Add `?window=<key>` to any read to read a closed window. That history is yours.

## Ties break by who got there first

Equal scores rank by earliest `achievedAt`, then by `userId`. Two rounds of research produced zero verified evidence on how any vendor breaks a tie, so this is a product decision rather than a precedent — and it has a payoff. The ordering is **total**: no two entries can tie, so dense-vs-competition ranking never arises and neither is implemented.

Resubmitting the same score does not reset your `achievedAt`. You earned first-to-reach; a replay does not cost it.

## Friends, segments, and tiers cost no extra board

A friends view is a collection dimension over the same store:

```ts
POST /leaderboard/weekly-distance/segment
{ "userIds": ["u1", "u2", "u3"] }
```

Capped at 80 players per query — D1 allows 100 bound parameters, and the my-rank path spends 10 of them on filters and the tiebreak predicate, so 80 members leaves safe margin.

Tiers are classified on read from the score already stored, so they cost nothing on write:

```ts
tiers: [{ key: "bronze", from: 0 }, { key: "gold", from: 1000 }]
```

Visibility is consent-gated. A player controls their own `visible` flag; a moderator's `hidden` is separate, so a player cannot undo a moderation action by toggling their own consent.

## Rank: live by default, materialized when it pays

`rank: "live"` counts better entries per request. Always correct, no moving parts, and $0 under about ten thousand players — which is most adopters. Do not engineer anything.

It is also quadratic. D1 bills rows *scanned*, so past ~100k players `rank: { materialize: "0 * * * *" }` stores the rank and refreshes it on a cron, turning ~$75,825/month at a million players into ~$940. Your own score stays live either way, which hides most of the staleness.

The refresh is chunked — walked by keyset, a chunk at a time — because D1 runs one query at a time and caps a query at 30 seconds. How many rows fit in one `UPDATE` is not the chunk size and never was a number to look up: a chunk is written in as many statements as D1's bound-parameter cap allows, so `chunkSize` paces the walk and nothing else. An unbounded rewrite would hold the only thread against live submissions. It runs as a **cron-triggered Cloudflare Workflow** that checkpoints the keyset cursor per batch, so a board of any size ranks across as many durable steps as it needs and resumes from the last checkpoint on a crash — there is no per-run entry ceiling.

**The single biggest cost lever is the default, not a mode.** On a `best` board, a submission that doesn't beat a player's stored score writes *nothing* — the upsert's guard skips it. Since submission writes dominate the bill and most submissions don't improve, this is what keeps a real board's cost well under the worst-case table. Its only cost: `submittedAt` then tracks a player's last *improving* submission, not their last submission. Set `trackActivity: true` on a board to write on every submission and keep a true last-seen timestamp, at full write cost.

**Read [docs/costs.md](./docs/costs.md) before you choose.** The mode you pick at 1k players decides what a million costs — and we are not the cheapest option, see [docs/differentiation.md](./docs/differentiation.md).

## The rank worker

A cron-triggered [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) that does two jobs: the retention sweep, then (if materialized) the rank refresh. You need it if `rank` is `{ materialize }` **or** any board configures retention (`retain`/`retainDays`). A live board set that keeps everything — the default — needs no worker at all.

It does **not** have to be a separate worker. It is a Workflow class, a `scheduled()` handler, and one cron trigger; `pithy add leaderboard` deploys them as a small dedicated worker by default, but the same three pieces can be folded into your app worker. A cron trigger is the only hard requirement. At any realistic cadence it stays inside Cloudflare's free Workflow allowances — a run is a handful of steps, it persists no state (all state is D1), and steps awaiting D1 burn no CPU.

A D1 advisory lock keeps at most one refresh running at a time. If a cron fires again while a refresh is still going, the second instance can't take the lock and skips — so two passes never interleave their chunked writes into an incoherent rank set. A crashed instance's lock ages out (default one hour, `LEADERBOARD_LOCK_STALE_MS`) so the next fire reclaims it.

## Retention: keep everything by default

Storage is never the cost driver here (see [docs/costs.md](./docs/costs.md) — 3 GB at 10M players against a 10 GB cap), so the default is to **keep every closed window forever**. Nothing is deleted unless you ask. When you do want a limit, pick the one that matches your intent — set one, not both:

```ts
{ key: "weekly", window: "0 0 * * 1", retain: 12 }       // product: browse the last 12 weeks
{ key: "daily",  window: "0 0 * * *", retainDays: 90 }   // compliance: delete data older than 90 days
```

`retain` counts closed windows; `retainDays` deletes by data age. Both are ignored on an all-time board (one never-closing window has nothing to expire). The sweep runs in the rank worker's cron.

## One store today: D1 — but the seam is there

Every board carries a `store` field. Today it has one value, `"d1"`: exact ranking on your own D1, which is what this whole capability is built on.

It is a per-board discriminant on purpose. A **Durable Object** is deliberately *not* one of its values — a DO bills rows exactly as D1 does, adds request and duration billing D1 lacks, and is single-threaded with the same 10 GB cap, so it fixes neither cost nor throughput. Scale here is a cadence dial (`materialize`), which is pure D1; a DO earns its place only when `live: true` ships, as a WebSocket push layer *over* D1 — a latency play, not a store.

A **column-oriented store** is a different axis, and the reason `store` exists as a field rather than a constant. Something Analytics-Engine-shaped would be far cheaper at very high scale — but it *samples* on read and write, so its counts are estimates, and a rank is a count. An estimated rank isn't a rank. Such a store could therefore only ever back a separate, opt-in *approximate* board type, chosen per board, never replace exact `d1` ranking. `store` is the seam that would let an approximate board live beside an exact one. It is immutable once a board records entries: there is no safe automatic migration of scores between stores.
