# @pithy-sh/multiplayer

Authoritative, turn-based multiplayer sessions on Cloudflare. The server holds the game state no client can be trusted with, resolves it, and writes a durable result to your own D1.

Sessions infrastructure plus pluggable game models. The session is the same for every game; what a *game* is lives behind a `GameModel`. Three example games ship, and you can register your own.

```sh
pithy add multiplayer
```

**Documentation: [pithy.sh/docs/capabilities/multiplayer](https://pithy.sh/docs/capabilities/multiplayer).** Overview, adding it, using it, and the reference: sessions, the game-model seam, hidden state, randomness.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## License

MIT — adopter-side app value, the same as `@pithy-sh/auth` and `@pithy-sh/leaderboard`. The root `LICENSE` covers it.
