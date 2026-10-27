# @pithy-sh/leaderboard

Rank your players. Submit a score, read the standings — daily through all-time.

Boards run in your Cloudflare account, on your D1, against your data. Closed windows stay as long as you say, in plain SQL you can join against your own tables. There is no Pithy service in the path and no Pithy bill.

```sh
pithy add leaderboard
```

**Documentation: [pithy.sh/docs/capabilities/leaderboard](https://pithy.sh/docs/capabilities/leaderboard).** Overview, adding it, using it, and the reference: boards and windows, ranking modes, what it costs.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Clients

A web app the Worker serves calls the routes through `@pithy-sh/leaderboard/src/client/api`, on its own origin and nowhere else. A mobile app or a game engine generates its client from the Worker's `openapi.json`, which `pithy contract` writes.

## Management

A management client reaches the leaderboard through the control plane, with two scopes. `leaderboard:entries:read` reads every board, a window's entries ranked and paged with hidden ones in place, and the rank-refresh lock. `leaderboard:entries:moderate` hides, unhides and corrects an entry, and clears a stale lock. Each act takes an idempotency key and a required reason, is recorded in `pithy_leaderboard_moderations` with what it found and what it left, and emits one audit event. The routes sit under `{basePath}/admin/`; [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md) lists them.

A result from `@pithy-sh/multiplayer` is recorded with the entry it wrote, so voiding the result takes back what it put on the board: its points from a `sum` entry, or the entry itself while the result still holds its score. A removed entry takes that record with it, so a later void never touches the player's next entry.

Retention deletes a window whole. With `retain` or `retainDays`, a pruned window's entries, the result records on them and the moderation history of acts on them all go together, because each holds a player's id and score.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
