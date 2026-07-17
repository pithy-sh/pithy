# Why not just use Game Center?

A fair question, and the honest answer has a shape: we are not the most featureful leaderboard. We are the one that runs in your account, on your data, across every platform you ship.

Every claim below comes from a vendor's own documentation. Where we are worse, that is here too — at the bottom, not omitted.

## 1. Calendar-aligned windows

Both platform vendors leave this open, and it is not a small gap.

Apple: *"Leaderboards have a minimum recurrence of five minutes, a maximum recurrence of 30 days, and aren't allowed to overlap."* Duration and Restarts are fixed minutes, hours, and days — so a **30-day rolling** board is expressible and a **calendar month** is not, because months are 28, 29, 30, or 31 days and a fixed duration cannot track that. A calendar year is unambiguously impossible. Apple Developer Forums thread 710947 asks exactly this and has **zero replies**.

Google Play Games Services ships daily, weekly, and all-time. There is **no monthly at all**.

A board's `window` here is a CRON expression, so `0 0 1 * *` is a calendar month and `0 0 1 1 *` is a calendar year. The marginal cost to us was about zero — `rank: { materialize: <cron> }` already needed a parser.

```ts
{ key: "monthly-distance", direction: "desc", window: "0 0 1 * *" }
```

## 2. Your history, your storage

Nothing in the market offers unbounded history.

PlayFab's `MaxQueryableVersions` is bounded, **tier-gated**, and **metered** — *"retained versions are going to be metered since use storage within the service"* — and the canonical tutorial defaults it to **1**, which is no history at all. Game Center keeps expired occurrences roughly 30 days from expiry and says outright it is **not an archival store**.

Here, closed windows live in **your own D1**, for as many windows as `retain` says. The score ledger is **plain SQL** you can join against your own tables for analytics. No platform SDK gives you any SQL access to your leaderboard at all.

This is principle 1 — you own your data and infrastructure — as a feature rather than a slogan.

## 3. One board across iOS, Android, and web

Game Center is Apple-only. PGS tamper protection is *"available for Android games only"* — and Google's own guidance is to **disable it** *"if your game also runs on the web in addition to Android, and shares leaderboards across these platforms."*

So a cross-platform title on the platform SDKs needs two leaderboards, gets no web story, and has to switch off the anti-cheat it adopted them for.

One board here serves all three. Which is exactly *why* this package must own server-side validation rather than inherit it — see below.

## 4. Server-authoritative by default

Every vendor that offers server-authoritative writes ships it **off**.

We ship it **on**. Submitting a score requires the board's `leaderboard:submit` scope: mint it for your trusted server's token, never for a player's, and a device cannot post a score it invented. Turning it off is one line, and it is the vendor default — which is why it is not ours.

The same principle runs deeper than the gate. A submission body carries a score and nothing else: the player comes from the authenticated session, the timestamp from the server's clock, the rank from the data. A client that could name any of those could score as someone else, backdate its way past the tiebreak, or simply declare itself first.

Per-board `min`/`max` bounds and an admin hide/remove API round out the baseline — which is the entire anti-cheat surface the vendors actually demonstrate.

## 5. We cost money. Here is exactly how much, and why you might pay it.

This is the honest one, and it is where earlier drafts of this page lied. They claimed "no vendor publishes what a leaderboard costs at scale." That is false, and worth stating plainly:

- **Game Center, Play Games Services, and Steam are free at any scale.** None documents a per-player, per-request, or per-entry leaderboard fee — the only costs are the entry fees to the platform itself (Apple $99/yr, Google Play $25 once, Steam $100/product and recoupable). They don't publish leaderboard pricing because there is nothing to publish.
- **PlayFab and Unity both publish leaderboard meters you can compute against.** PlayFab: reads $0.10/M, writes $0.50/M, storage $0.049/MB. Unity: MAU-tiered, $0.00360/MAU after a 50k free tier. We derived their at-scale costs from their own published numbers in minutes.

So we are not more transparent than the field, and we are **not cheaper**. At a million players, on published prices:

| | 1M players/mo |
|---|---:|
| Game Center / Play Games / Steam | **$0** |
| PlayFab | ~$247 |
| **Pithy** (materialize, worst case) | $940 |
| **Pithy** (materialize, typical improve rate) | ~$220 |
| Unity | ~$2,928 |

We sit mid-pack: a few times PlayFab, well under Unity, and infinitely more than the free platform SDKs. For a game with a million players the whole spread is under $3k/month — noise against the revenue a million-player game earns. But say it straight: **a successful app pays Cloudflare, and it pays more here than it would on PlayFab.**

What the money buys is the other four points on this page: cross-platform reach the free SDKs can't give, and adopter-owned SQL data that PlayFab and Unity don't offer at any price. At ~$0.001 per player per month, the honest pitch is "a tenth of a cent per player buys you your own database" — not "we're cheap."

Two things make the number smaller than the table's worst case, both real:

- **The default `best` board writes nothing for a submission that doesn't beat your score.** Since submission writes dominate the bill and most submissions don't improve, a typical board pays far less than the worst-case row — the ~$220 above, not $940.
- **You own the arithmetic.** [`docs/costs.md`](./costs.md) ships the model as a committed script (`bun run --filter @pithy-sh/leaderboard costs`), with the assumptions, the as-of date, the sharding boundary, and a line between Cloudflare's published figures and ours. Re-run each release. No vendor gives you that either — but transparency is a courtesy, not a moat.

Why not just use the free platform SDK, then? Because it's one platform, capped (Apple 500 boards, Google 70, both with fixed windows and no calendar month), and its data lives in Apple's or Google's service, not yours. Free is the right call for a single-platform title that never needs its own data. The moment you ship cross-platform or want to join scores against your own tables, the free option isn't on the table — and the paid ones cost roughly what we do.

## Honest non-differentiators

Do not let anyone tell you otherwise:

- **Price.** We are not cheap. The free platform SDKs cost nothing, and PlayFab is a few times cheaper than us at scale. We compete on ownership and reach, not cost — see point 5.
- **Aggregation richness.** PlayFab beats us: four methods across five columns. We ship three methods on one score.
- **Skill rating.** Out of scope. ELO/Glicko/TrueSkill produce a number; this board ranks numbers. Bring your own rating and submit it.
- **Bucketed cohorts.** The Duolingo-league / Clash-Royale-arena model needs durable per-window cohort assignment and provably cannot be a view over a global board. Unity ships it. We defer it.
- **Live push.** Deferred. No vendor treats it as default either, but they do have it, and we do not yet. When it lands it will be a Durable Object WebSocket layer **over** D1 — transport, not a second store.
- **Streaks and cumulative progress.** These degrade to `aggregation: "sum"`. PGS puts them in a separate Events/Quests product, and so should you.
- **Multi-column / secondary scores.** Only PlayFab meaningfully invests here.

## Sourcing notes

Two adversarially-verified research rounds sit behind this page. Semantics: 23 sources across Game Center, PGS, Steam, Unity, PlayFab, and Nakama; 115 claims extracted, 25 verified, 9 refuted. Cost: 20 Cloudflare primary sources; 97 claims, 25 verified, 2 refuted.

Two caveats worth carrying:

- The refuted set clustered on **Steam** and **Nakama** — store shape, operator enums, subscore fields, auth defaults. Do not lean on either surface without fresh primary sourcing.
- Cite PGS as `developer.android.com/games/pgs/leaderboards`. The `developers.google.com` URL 301s, and the v1 SDK is deprecated.

And one thing we could not source at all: **vendor tie-breaking**. Two rounds produced zero verified evidence on how anyone else breaks a tie. So ours is a product decision, not a precedent — earliest `achievedAt` wins, with `userId` as a final tiebreak. It has a payoff: the ordering is **total**, so no two entries can tie, so dense-vs-competition ranking never arises and neither is implemented.
