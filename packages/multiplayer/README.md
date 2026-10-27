# @pithy-sh/multiplayer

Authoritative, turn-based multiplayer sessions on Cloudflare. The server holds the game state no client can be trusted with, resolves it, and writes a durable result to your own D1.

Sessions infrastructure plus pluggable game models. The session is the same for every game; what a *game* is lives behind a `GameModel`. Three example games ship, and you can register your own.

```sh
pithy add multiplayer
```

**Documentation: [pithy.sh/docs/capabilities/multiplayer](https://pithy.sh/docs/capabilities/multiplayer).** Overview, adding it, using it, and the reference: sessions, the game-model seam, hidden state, randomness.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Clients

A web app the Worker serves calls the routes through `@pithy-sh/multiplayer/src/client/api`, on its own origin and nowhere else. A mobile app or a game engine generates its client from the Worker's `openapi.json`, and plays the live session socket against its `asyncapi.json`. `pithy contract` writes both.

The session socket's frames are Zod schemas in `src/session/frames.ts`, and the Worker parses every frame it receives with them. Offer `pithy.multiplayer.v1` at the upgrade. How a frame may change between releases is [`docs/SOCKETS.md`](../../docs/SOCKETS.md).

A game model may declare an `action` schema and a `view` schema, and the three built-in games do. A declared `action` is checked before `apply` runs. Both are published in `asyncapi.json` as `<gameKey>.action` and `<gameKey>.view`, so a client in any engine types the part that is the game.

## Who reads a session

A session reads only for the people in it. The session itself judges membership, and anyone it does not admit gets a 403. Every route answers it as `multiplayer/not_a_member`, and the socket upgrade as a plain 403.

- **`GET /multiplayer/sessions/:id`, the socket, an action and a close:** current members only.
- **`GET /multiplayer/sessions/:id/result`:** anyone who ever joined, a player who left the table included. The session keeps that record.
- **`POST /multiplayer/sessions/:id/leave`:** anyone who ever joined. Leaving closes the player's sockets. A repeated leave is not an error, and its view shows nothing live.

No state frame reaches a socket whose player is no longer a member.

This gates reading, not joining. Whoever holds an open session's id may still join it, by design.

Closing a table, by a player or a management client, settles every seat out first, as each player leaving would. A bet still open on the table is released, never held.

## Management

A management client reaches multiplayer through the control plane, with two scopes. `multiplayer:sessions:read` lists the sessions in flight, reads one session from its Durable Object, and pages the results. `multiplayer:sessions:moderate` closes a session in flight and voids a result. `pithy dashboard connect` grants the read by default and the acts only when asked. Every route is under `/multiplayer/admin/`, and [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md#13-capabilities-contribute-their-own-admin-routes) has each one.

**The session index.** A session is a Durable Object addressed by its id, so nothing could list the live ones. Each session now writes a row to `pithy_multiplayer_sessions` when it opens, rewrites it as its roster and phase move, and deletes it when it ends — resolved, abandoned by its deadline, or closed. A session in flight before the index existed joins it at its next join, leave or phase change.

**A session read never carries the game's state.** It names the players, who is connected, the deadline and how the session ended. The model's state holds what a player must not see.

**Close** ends a session in flight with no result. Every member gets a last state frame whose `outcome.closedReason` is the reason the operator gave, then their sockets close. Write the reason for the players.

**Void** marks a result void, then calls each composed consumer with its id. `@pithy-sh/leaderboard` removes the entries the result put on a board. `@pithy-sh/rating` recalculates every player whose outcomes carried the result's id. The response lists each consumer's outcome with its own report. A consumer that failed, is too old to void, or is no longer composed is named `failed`, never folded into success, and the void stands. A player's own `GET …/result` says when it was voided.

Each act takes an idempotency key and a required reason, and emits one audit event, `multiplayer/session_closed` or `multiplayer/result_voided`. A replayed key changes nothing and emits nothing, and so does voiding a result already void with every consumer done. A new key on a void with a consumer still `failed` or `pending` runs those consumers again, and marks them `pending` while it does. So while a void or a retry may still be running, with a consumer `pending` and the key holding the void spent less than 15 minutes ago (`VOID_LEASE_MS`), a new key is `core/conflict` (409), changes nothing and spends nothing, and no consumer runs twice at once. Every key a void or a retry was sent with stays spent, in `pithy_multiplayer_void_keys`, so a key sent again is a replay however many retries came after it, and a key spent on one result never voids another.

## A person's data

**Anonymized.** When an account is purged, multiplayer replaces the person's id in every session result they played in — the players, the scores and the winner — with `erased-` and a random UUID, so the other players' results stay. A session still in flight that they play in is closed with no result, the other players told why, and its row leaves the index. An export hands the results and the sessions in flight back first. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value, the same as `@pithy-sh/auth` and `@pithy-sh/leaderboard`. The root `LICENSE` covers it.
