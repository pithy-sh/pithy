# @pithy-sh/matchmaking

Find competitors. Room codes, direct invites, a friend graph, and a skill-bucketed queue — every path lands two or more players in the same authoritative [`@pithy-sh/multiplayer`](../multiplayer) session.

Multiplayer gives you a session once players are in it. This is how they get there. Four ways, one output: a session id.

It runs entirely in your Cloudflare account — two Durable Objects, your own D1, your own KV. There is no lobby service anyone operates, and no player list leaving your infrastructure. Read [docs/costs.md](./docs/costs.md) before production: the queue's sweep cadence is the one setting that decides what a waiting queue costs.

## Add it

```bash
pithy add matchmaking
```

That installs the package and writes four bindings into every environment of your Worker's `wrangler.jsonc` — `DB`, `MATCHMAKING`, and the `QUEUE` and `PRESENCE` Durable Object namespaces — together with the `new_sqlite_classes` class migration tags the two Durable Objects need. **That wiring is the reason this is a capability rather than a snippet.** A DO binding is one entry; a DO class migration tag is another, in a different block, repeated per environment, and getting it wrong deploys a Worker whose class does not exist.

One binding it writes without an id: a `kv_namespaces` entry has no name field, so `pithy add` prints the name to give the `MATCHMAKING` namespace in each environment. Create it in your account under that name and paste the id in.

`pithy add` also writes both classes into your worker entry, so wrangler's `class_name` resolves against it:

```ts
export { MatchmakingQueue } from "@pithy-sh/matchmaking/src/queue/durableObject";
export { MatchmakingPresence } from "@pithy-sh/matchmaking/src/presence/durableObject";
```

Each from its own module, never from the package entry point. That entry point is what `pithy.config.ts` imports, and that file is loaded by every Node-side `pithy` command — a Durable Object on that path imports `cloudflare:workers` and takes `pithy upgrade` down with it.

Finally:

```bash
pithy migrate
```

## Configure it

```ts
matchmaking({
  games: [
    {
      key: "duel",                 // a URL path segment
      players: 2,                  // how many form a match
      skillPool: "duel",           // bucket the queue on this @pithy-sh/rating pool. Omit for region only.
      snapshot: {                  // the multiplayer session a formed match is minted into
        kind: "connect-n",
        rules: { rows: 3, cols: 3, connect: 3 },
      },
      roomCodes: { ttlSeconds: 900, maxUses: 9 },
      queue: { initialBand: 100, widenPerSecond: 50, maxWaitSeconds: 120, sweepSeconds: 5 },
    },
  ],
  friends: true,                   // default. The friend graph and its routes.
})
```

The games live in `pithy.config.ts`, reviewed and deployed like the rest of your app. There is no game admin screen and no game table to seed.

## Four ways to pair

**Room code.** The host opens a room: a session is minted with them in it, and a short code is stored in KV pointing at it. Codes are `WXYZ-1234` — four letters, four digits, drawn from alphabets with `I`, `O`, `0` and `1` removed so nobody reads one back wrong. They are short-lived (`ttlSeconds`, default 15 minutes) and limited-use (`maxUses`, default 9), and join tolerates lowercase, whitespace, and a missing dash. The zero-discovery path: play with whoever is beside you.

**Direct invite.** Invite by email or screen name; the invite is pending until accepted, and accepting mints the session and seats both players. Email is the reliable key — it is unique on the user table. A screen name is best-effort: auth exposes no unique one, so a name matching zero or many users is refused rather than guessed. A direct invite seats exactly two players, so a game with a larger roster is refused here and told to use a code or the queue.

**Friends.** A symmetric graph formed by mutual accept — request, accept, decline, remove. Turn it off with `friends: false` and its routes never mount.

**Open queue.** One Durable Object per game pairs waiting players, bucketed by Cloudflare's own edge geolocation and by skill read from `@pithy-sh/rating`. A player first matches only opponents within `initialBand` of their skill; the band widens by `widenPerSecond` for every second they wait, and after `maxWaitSeconds` it is unbounded — any opponent in their region qualifies. An alarm re-attempts pairing every `sweepSeconds`. Nothing is held in memory: the waiting list is read fresh and Zod-parsed on every handler, so an eviction costs nothing.

## Presence

One Durable Object holds every online player's WebSocket, over the **Hibernation API** — so a socket waiting on nothing bills no duration. On connect it delivers that player's pending invites and which of their friends are online right now. Thereafter it pushes three events:

```ts
{ type: "match_found";   sessionId: string; gameKey: string }
{ type: "invite";        inviteId: string;  gameKey: string; from: string }
{ type: "friend_request"; from: string }
```

The identity comes from the authenticated Hono handler as a server-set header and is stashed with `serializeAttachment`, so it survives eviction. The Durable Object never trusts a client-supplied user id.

It is a single shared object with a soft ~1,000 req/s ceiling. That is ample for notifications and is the number to plan against — it is a scaling consideration, not a hidden limit.

## Routes

| Route | Strategy |
|---|---|
| `POST /matchmaking/games/:game/rooms` | bearer \| session |
| `POST /matchmaking/rooms/:code/join` | bearer \| session |
| `POST /matchmaking/games/:game/invites` | bearer \| session |
| `GET /matchmaking/invites` | bearer \| session |
| `POST /matchmaking/invites/:id/accept` | bearer \| session |
| `POST /matchmaking/invites/:id/decline` | bearer \| session |
| `GET /matchmaking/friends` | bearer \| session |
| `POST /matchmaking/friends/:userId/request` | bearer \| session |
| `POST /matchmaking/friends/:userId/accept` | bearer \| session |
| `POST /matchmaking/friends/:userId/decline` | bearer \| session |
| `DELETE /matchmaking/friends/:userId` | bearer \| session |
| `POST /matchmaking/games/:game/queue` | bearer \| session |
| `GET /matchmaking/games/:game/queue` | bearer \| session |
| `DELETE /matchmaking/games/:game/queue` | bearer \| session |
| `GET /matchmaking/presence` | bearer \| session (WebSocket) |

There is no public surface. Every route binds to `c.var.auth.userId` and never to a client-supplied id — a room a stranger can open in your name, or a friend request from an id the client chose, is the whole attack surface of a pairing layer. Matchmaking depends on core's `AuthContext` seam and never on `@pithy-sh/auth` internals; without auth installed every route above denies.

The friend routes mount only when `friends` is on. Mount the whole surface elsewhere with `basePath`.

## What it stores

Two D1 tables, created by `pithy migrate`:

- `pithy_matchmaking_invites` — direct invites, indexed by invitee, carrying the session id once accepted.
- `pithy_matchmaking_friends` — the friend graph, one row per pair, indexed both ways so a lookup from either side is one read.

And one KV prefix, `matchmaking:<code>`, in the `MATCHMAKING` namespace: the room codes. They belong in KV rather than D1 because a room code is a short-lived pointer with a TTL and a use counter, which is exactly what KV is — and nothing else in this capability is.

Queue state lives in the queue Durable Object's own storage, and presence is the live socket set. Neither is a row you keep.

## Bindings

| Binding | Kind | Why |
|---|---|---|
| `DB` | D1 | Invites and the friend graph. The same app database your other capabilities use. |
| `MATCHMAKING` | KV | Room codes, under a TTL. |
| `QUEUE` | Durable Object (`MatchmakingQueue`) | One coordinator per game: the waiting list, the widening bands, the pairing alarm. |
| `PRESENCE` | Durable Object (`MatchmakingPresence`) | Every online player's WebSocket, hibernating between events. |
| `SESSIONS` | Durable Object (`@pithy-sh/multiplayer`) | Read at runtime to mint the session a match resolves into. Not declared here — it is multiplayer's binding, and `pithy add multiplayer` writes it. |

## Seams, not hard dependencies

Nothing here is a hard `dependsOn`. Each peer is reached through a seam, and its absence degrades one thing rather than breaking the composition:

| Absent | What happens |
|---|---|
| `@pithy-sh/auth` | Every route denies. The right failure — a pairing layer with no identity has nothing to pair. |
| `@pithy-sh/rating` | The queue buckets by region only. No skill matching, everything else unchanged. |
| `@pithy-sh/multiplayer` | Every pairing path still runs, and none of them can mint the session it exists to produce. |

Install them and it lights up, with no wiring.
