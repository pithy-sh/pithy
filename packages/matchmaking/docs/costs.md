# Matchmaking costs

_The reader's version of this page is [pithy.sh/docs/build/games/what-a-queue-costs](https://pithy.sh/docs/build/games/what-a-queue-costs). This copy ships in the package because `packages/cli/src/capabilities/catalog.ts` sends an adopter to it by name._

Two Durable Objects, one KV prefix, two D1 tables. Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) is the authority for the first, and when the two disagree Cloudflare is right. This page does not restate rates — it says how a pairing layer maps onto them, and names the one setting that changes the answer.

[`@pithy-sh/multiplayer`'s costs page](../../multiplayer/docs/costs.md) already records the two platform facts both capabilities inherit, and they are not repeated here: **WebSocket messages bill at a 20:1 ratio**, and **duration bills the full 128 MB, only while an object is awake**. Read that page first. What follows is what matchmaking adds.

## The presence object is a hibernating socket, and that is the whole cost model

Presence is one Durable Object holding every online player's WebSocket through the Hibernation API. A hibernating object bills no duration, so a thousand players sitting in a menu with the app open cost nothing to hold — you pay for the events that actually flow, discounted 20:1.

That is only true because of what the object refuses to do. It keeps no in-memory connection registry (the live set is read back from `getWebSockets()`), stashes the authenticated identity with `serializeAttachment` rather than in a field, and never calls `ws.accept()` or sets a timer. A single `setInterval` anywhere in it would pin it in memory and bill duration continuously, for every player online, forever.

It is one shared object, so its ceiling is a single object's: a soft **~1,000 requests/second**. Notifications do not approach that, but it is the number to plan against — it is a throughput ceiling, not a bill.

## The queue object bills for waiting, and `sweepSeconds` is the dial

The open queue is one Durable Object per game, and it is the only thing here that wakes up on its own. While anyone is waiting, a single alarm is armed at `now + sweepSeconds`; the alarm wakes the object, re-attempts pairing, widens every waiting player's skill band, and re-arms. Each wake is a request, plus the duration of a short handler.

So the cost of an idle queue is zero and the cost of a *waiting* queue is `sweepSeconds`:

| `sweepSeconds` | Wakes per waiting minute, per game | What it buys |
|---|---|---|
| 1 | 60 | Bands widen almost continuously. Pairing latency is dominated by who arrives, not by the sweep. |
| 5 (default) | 12 | A player waits at most 5 seconds past the moment their band grew wide enough. |
| 15 | 4 | A fifth of the default's wakes. Noticeable on a thin queue where the band is what unblocks the match. |

**An empty queue clears its alarm.** The handler deletes the alarm the moment the waiting list drains, and the last player to leave deletes it too — so a game nobody is queueing for wakes zero times and bills nothing, whatever `sweepSeconds` says. That is why the number is a per-waiting-minute rate rather than a standing charge.

Two things are not in the table because they do not change with it. A match forms on `enqueue` when an opponent is already waiting, without waiting for a sweep — the sweep exists to widen bands, not to pair. And storage is read fresh and Zod-parsed per handler by design: an eviction costs a read, and holding state in memory to avoid it would cost the hibernation that makes the whole object cheap.

**One object per game, addressed by game key.** Ten games are ten coordinators, each with its own alarm and its own waiting list, and each idle one bills nothing. That is also the sharding: a game's pairing throughput is one object's, so a game expecting more than a single object can carry wants splitting into region- or bracket-keyed games rather than a bigger `sweepSeconds`.

## Room codes are KV, and priced like it

A room code is one KV write when the room opens, one read per join attempt, and one write per redemption to decrement the counter. It expires on its TTL at no cost — nothing sweeps it, and there is no row left behind.

`ttlSeconds` does not change the bill; `maxUses` bounds it, since it caps the redeem writes one shared code can cause. KV was chosen here for exactly this shape: a short-lived pointer with a TTL and a counter is what the store is for, and it is the only thing in this capability that looks like that.

## D1 is two small tables

Invites and the friend graph, billed as rows read and written like every other D1 table. An invite is a row per invitation, resolved by an index on the invitee; a friendship is one row per pair, indexed from both sides so a lookup is one read rather than a scan. Neither grows with play — they grow with the social graph, which is a much slower number.

## What to watch

- **`sweepSeconds`, per game.** The only setting on this page that bills while nothing is happening. Raise it for a thin queue that pairs on arrival anyway; lower it only where band-widening is genuinely what pairs people.
- **A presence connection that never closes.** Hibernation makes an idle socket free, not a leaked one — a client that reconnects without closing leaves sockets in the set for the object to iterate on every push.
- **Chatty presence traffic.** Three event types ship, all server-pushed and small. Adding a client-driven heartbeat over this socket would put its messages through the 20:1 ratio and the object's request ceiling both; use the platform's own ping instead.
