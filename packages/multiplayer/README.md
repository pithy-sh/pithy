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


## License

MIT — adopter-side app value, the same as `@pithy-sh/auth` and `@pithy-sh/leaderboard`. The root `LICENSE` covers it.
