# @pithy-sh/matchmaking

Find competitors. Room codes, invites, friends, and matched queues — every path lands two or more players in the same authoritative `@pithy-sh/multiplayer` session.

`@pithy-sh/multiplayer` gives you a session once players are in it. This is how they find each other. It is the Cloudflare-native pairing layer — no service anyone operates.

## Add it

```ts
import { matchmaking } from "@pithy-sh/matchmaking";

matchmaking({
  games: [
    {
      key: "duel",
      players: 2,
      skillPool: "duel", // bucket the open queue on this @pithy-sh/rating pool
      snapshot: { kind: "connect-n", rules: { /* the multiplayer game's rules */ } },
    },
  ],
});
```

Then export the two Durable Objects from your worker entry, so wrangler's `class_name` resolves against it:

```ts
export { MatchmakingQueue } from "@pithy-sh/matchmaking/src/queue/durableObject";
export { MatchmakingPresence } from "@pithy-sh/matchmaking/src/presence/durableObject";
```

Their own modules, never the package entry point. The entry point is what your `pithy.config.ts` imports, and that file is loaded by every Node-side CLI command — a Durable Object on that path imports `cloudflare:workers` and takes `pithy upgrade` down with it.

## Four ways to pair

- **Room code.** A host opens a room and gets a short, shareable code (`WXYZ-1234`) — short-lived and limited-use. Others join by code. The zero-discovery, play-with-a-friend path.
- **Direct invite.** Invite a player by email or screen name. A pending invite the invitee accepts, minting the session.
- **Friends.** A symmetric friend graph formed by mutual accept — request, accept, remove. Invite or match preferentially among friends.
- **Open queue.** Enqueue; a per-game Durable Object pairs waiting players, bucketed by region (Cloudflare edge geolocation) and by skill (from `@pithy-sh/rating`). The longer you wait, the wider the skill band — until any opponent qualifies.

## Presence

A Durable Object holds every online player's WebSocket. On connect it delivers pending invites and which friends are online; thereafter it pushes "match found", "invite received", and "friend request" in real time.

## Routes

Rooms, invites, friends, queue, and a presence WebSocket — all under `/matchmaking`, every route bound to the authenticated user. Room-code join can optionally require a Turnstile check (off by default).

## Seams, not hard dependencies

Matchmaking degrades gracefully. Without `@pithy-sh/auth` every route is denied (the right failure). Without `@pithy-sh/rating` the queue buckets by region only. Without `@pithy-sh/multiplayer` (the `SESSIONS` binding) session minting is disabled. Install them and it lights up — no wiring.
