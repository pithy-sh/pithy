# What a leaderboard costs

**As of 2026-07-16.** Cloudflare's [D1 pricing page](https://developers.cloudflare.com/d1/platform/pricing/) is the authority. Prices, included allowances, and limits can change at any time, and the allowances do most of the work in the numbers below — a change to the 25 billion rows-read allowance alone would move every boundary in this table. Nothing here is a Cloudflare quote, and none of it is a bill you can plan against to the dollar. It is directional engine guidance.

**Pithy never bills you.** This is Cloudflare metering your own Cloudflare account, on prices Pithy does not set and cannot control. We take no cut of any of it.

**We are not the cheapest option, and this page is not a sales pitch.** The free platform SDKs — Game Center, Play Games Services, Steam — cost nothing at any scale, and PlayFab is a few times cheaper than us. See [`differentiation.md`](./differentiation.md) for the full comparison; the short version is that you pay here for cross-platform reach and for owning your data in your own SQL, not for a lower bill. This page exists so you can see that bill before you commit — the mode you pick at 1,000 players decides what it looks like at a million, and growth is the good outcome that still has a cost.

## The table

| Players | `rank: "live"` | `materialize` daily | `materialize` hourly | Storage | Upserts/sec |
|---:|---:|---:|---:|---:|---:|
| 1,000 | **$0** | $0 | $0 | 0.00 GB | ~0 |
| 10,000 | **$0** | $0 | $0 | 0.00 GB | 2 |
| 100,000 | **$765** | **$49** | $256 | 0.03 GB | 17 |
| 1,000,000 | **$75,825** | **$940** | $3,010 | 0.30 GB | **174** |
| 10,000,000 | **$7,508,925** | **$9,850** | $30,550 | 3.00 GB | **1,736** |

Per month, USD. Reproduce it yourself: `bun run --filter @pithy-sh/leaderboard costs`.

## Reading it

**Live rank is free to ~10k players and ruinous past 100k.** Under about ten thousand players the 25B/month read allowance absorbs everything, so `rank: "live"` is correct and costs nothing. That is most adopters, and it is the default. Do not engineer anything.

**Live rank is quadratic.** D1 bills rows *scanned*, not returned — "a query that filters on an unindexed column may return fewer rows to your Worker, but is still required to read (scan) more rows". A live rank counts every entry that beats you, so each check scans a slice of the board that grows with the board, while the number of checks grows with the player count too. Ten times the players is about a hundred times the read bill. That is the whole shape of the first column.

**Materialization is the fix, and it is pure D1.** Roughly $75,825 becomes $940 at a million players. It is not a different database, a different engine, or a different product — it is a stored rank column and a cron. Refresh cadence is a continuous dial trading staleness for cost, and it stops paying for itself somewhere between hourly and every fifteen minutes. Your own score stays live in both modes, which hides most of the staleness from the player who cares most about it.

**Past ~1M players the dominant term flips.** At ten million, materialized-daily is $9,850/month, of which **$8,950 is submission writes** — not the refresh. Beyond that point no cadence tuning helps. Only fewer windows or fewer submissions do.

**Storage never binds.** Three gigabytes at ten million players, against a 10 GB cap.

## The table is the worst case. Your board does better.

Every figure above assumes *every* submission writes. On the default `best` board it doesn't: a submission that fails to beat a player's stored score is skipped by the upsert's `WHERE` guard and writes **zero rows** (`trackActivity: false`, the default). Since submission writes are the dominant term — 85% of the bill past a million players — and most submissions don't improve a player's best, a real board pays a fraction of the table.

At a million players, materialize-daily by how often submissions actually improve:

| improving submissions | materialize daily |
|---:|---:|
| 100% (worst case, the table) | $940 |
| 50% | ~$580 |
| 20% (typical) | **~$220** |

That guard is the single biggest cost lever in the capability, and it is on by default. Its only cost is that `submittedAt` then tracks a player's last *improving* submission rather than their last submission of any kind — nothing in ranking depends on it. Set `trackActivity: true` on a board to write on every submission and keep `submittedAt` a true last-seen timestamp, at full write cost. `sum` and `latest` boards always write, since every submission changes the score.

## The write model, measured

The write figures rest on one number: rows written per submission per window. It is **measured, not guessed** — `src/entry/writeAmplification.workers.test.ts` reads D1's own `meta.rows_written` for the real upsert and fails if it moves:

- A steady-state improving submission writes **2** rows: the entry row and the rank index. The unique-player index doesn't change on an update, so it costs nothing.
- The first-ever submission for a player writes **3** (both indexes), amortized to almost nothing across their submissions.
- A guarded non-improving submission writes **0**.

The entries table uses a plain `INTEGER PRIMARY KEY`, not `AUTOINCREMENT`, on purpose: autoincrement would add a `sqlite_sequence` write to *every* upsert — even a guarded no-op, because SQLite reserves the sequence value before it detects the conflict — turning the free no-op back into a billed one. A one-line schema choice keeps the lever sharp.

## The two walls sit in different places

**Cost says materialize past ~100k. Throughput says shard past ~1M.**

Throughput is the harder wall, and the one the cost column hides. D1 executes one query at a time per database, and its docs describe a write as taking "several milliseconds" — which implies a practical ceiling somewhere near **200 upserts/sec**. At a million players the *average* is already 174/sec, about 87% of it, and any peak goes over. At ten million it is more than eight times over.

So **one D1 database tops out around a million players regardless of what it costs.** Cloudflare's endorsed answer past that is horizontal scale-out: shard into smaller per-tenant databases. The 10 GB per-database cap **cannot be increased**, which is the same message from the other direction.

## Assumptions

Change any of these and the table moves.

- 5 submissions and 5 rank checks per player per day.
- 3 windows per board set (say daily + weekly + all-time).
- A 30-day month.
- 2 rows written per *writing* submission per window — the entry row and the rank index — measured, not assumed (see below). The published table assumes every submission writes; the default guarded board writes only for the minority that improve.
- A live rank check scans half the board (the average mid-table player).
- ~100 bytes per row.

## What is cited and what is ours

**Cloudflare's, cited:** the unit prices (rows read 25B/mo included then $0.001/M; rows written 50M/mo then $1.00/M; storage 5 GB then $0.75/GB-mo), that billing counts rows *scanned* rather than returned, that D1 is single-threaded, and the 10 GB per-database cap.

**Ours, inferred — do not quote these as Cloudflare figures:**

- The half-board scan depth for a live rank check, the submission/check rates, and the window count.
- The **~200 upserts/sec ceiling**. Cloudflare publishes **no** writes/sec ceiling. This is our arithmetic on "several milliseconds" per write against a single thread.
- The **improve rate** — how many submissions actually beat a player's best and therefore write. The table's worst case assumes 100%; a real board is far lower. The *per-write* cost, by contrast, is measured against D1's own `meta.rows_written` (2 rows for a writing submission, 0 for a guarded no-op), not inferred.

Cloudflare also publishes **no cap on rows read**, which is worth sitting with: an un-materialized rank query on a large board runs the bill up without ever erroring. Nothing fails. The invoice just arrives.

Cloudflare documents **no rank-materialization pattern** either. The chunked refresh in this package is entirely adopter-built engineering — which is precisely why it is in the package instead of in your repo.

## A note on window functions

`RANK() OVER` and `ROW_NUMBER() OVER` are **undocumented** on D1: Cloudflare's SQL reference neither supports nor denies them.

We probed it. Both execute under Miniflare's local D1. But Miniflare also rejects `sqlite_version()` with `not authorized to use function`, which proves D1 runs a function authorizer whose production allowlist is not visible from local — so a local pass is not evidence about production.

Ranking therefore does **not** use window functions. It uses `COUNT(*)` with an explicit predicate and a total ordering, which is documented SQL everywhere it runs. `src/rank/plan.workers.test.ts` reads D1's own `EXPLAIN QUERY PLAN` to prove the ranking index is actually chosen, because an index that silently stops being used is a cost regression, not a test failure — the answer stays right and the bill goes up.

## This page will drift

Re-run the model on each release: `bun run --filter @pithy-sh/leaderboard costs`. The arithmetic is committed as a script (`scripts/costModel.ts`), not hand-maths in this prose, and `scripts/costModel.test.ts` pins every figure above. If a price or an assumption moves, those tests fail — and this page is wrong until both are updated together.
