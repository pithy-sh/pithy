# Multiplayer costs

Rates as of **2026-07-16**. Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) is the authority — this page explains how a session maps onto it, and carries the two caveats that make a naive estimate wrong. When the two disagree, Cloudflare is right.

A multiplayer session is one Durable Object. You pay for three things: requests, duration, and storage. The shape of the bill is dominated by one fact — **a session waiting on a player's turn hibernates, and a hibernating object bills no duration.** Turn-based, asynchronous play is the quadrant where a Durable Object is genuinely excellent, and it is the only quadrant this capability serves.

## The 20:1 WebSocket caveat

This is the number that makes a headline estimate wrong, so it comes first.

Cloudflare bills WebSocket *messages* as requests, but applies a **20:1 ratio for billing**: *"for compute requests billing-only, a 20:1 ratio is applied to incoming WebSocket messages to factor in smaller messages for real-time communication."* Twenty inbound WebSocket messages bill as one request.

A cost model built off the headline $0.15 per million request rate, counting every WebSocket frame as a request, **overstates a chatty session by up to 20×.** Getting this wrong is a brand risk, not a rounding error — Pithy publishes honest cost models, so a figure here that ignored the 20:1 ratio would be worse than no figure.

A turn-based session is not chatty. A few players, a handful of messages each — a create, a join, an action per turn, a resolve. Even before the 20:1 discount, a whole session is a few dozen billable events, whatever the game model.

## Duration bills the full 128 MB, and only while awake

Duration is `GB-s = seconds × 128 MB ÷ 1 GB`. The 128 MB is fixed: **you pay for the full allocation regardless of how little memory the session actually uses**, so per-object duration cost is memory-independent. There is no saving to chase in a smaller state.

The saving to chase is hibernation. Duration is billed *"while the Durable Object is actively running or is idle in memory but unable to hibernate."* A session that has both players' commits and is waiting on nothing resolves and goes terminal. A session waiting on a slow player **hibernates between messages and bills no duration** — which is why this capability uses the WebSocket Hibernation API, alarms instead of timers, and holds nothing important in memory. A single `setInterval` anywhere would forfeit all of it: timers prevent hibernation entirely, pinning the object in memory and billing duration continuously.

This is also why real-time action netcode is out of scope. A fixed high-rate tick loop must wake constantly, so it never hibernates and bills duration the whole match — the exact cost this capability is designed to avoid.

## Storage

Session state lives in the object's SQLite-backed storage. Rows are billed exactly as D1 rows, and each object caps at 10 GB. A duel's state is tiny — metadata, two commits, one outcome — and the object is a natural place to let it expire; the durable *result* is a single row in your app's D1 (`pithy_multiplayer_results`), joinable beside your own tables.

## Cheap idle sessions are a platform primitive, not a Pithy feature

An idle, hibernating session costing effectively nothing is a property of Durable Objects — anyone building on a DO gets it. It is not a Pithy differentiator, and this page does not claim it as one. What Pithy adds is the wiring (the DO binding, the class migration tag, the per-environment namespaces) and the authority (hidden state, commit-reveal resolution) on top — not the idle economics.

## Run the model

```
bun run --filter @pithy-sh/multiplayer costs
```

`scripts/costModel.ts` estimates a monthly bill from a session volume and a per-session message count, applying the 20:1 ratio and the free tiers. It is a planning aid, not a quote — Cloudflare's live pricing is the authority, and the free tiers and rates move.
