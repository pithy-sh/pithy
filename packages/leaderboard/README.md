# @pithy-sh/leaderboard

Rank your players. Submit a score, read the standings — daily through all-time.

Boards run in your Cloudflare account, on your D1, against your data. Closed windows stay as long as you say, in plain SQL you can join against your own tables. There is no Pithy service in the path and no Pithy bill.

```sh
pithy add leaderboard
```

**Documentation: [pithy.sh/docs/capabilities/leaderboard](https://pithy.sh/docs/capabilities/leaderboard).** Overview, adding it, using it, and the reference: boards and windows, ranking modes, what it costs.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Board families

A board whose key follows your content — one per level, per player-made level, per variation — is a family, not a list. `families: [{ pattern: "level/:levelId", direction: "asc" }]` declares the shape once; `POST /leaderboard/level/abc` and every read under it address the board `level/abc`, made by its first accepted score. A read before then answers an empty board. An optional `allow(key, c)` refuses an id the Worker does not know before anything is written, as `leaderboard/board_not_found`. An instance ranks, windows, moderates, purges and exports exactly as a configured board does, and its shape is fixed once it has entries: change the family and an instance that already has scores refuses the next one with `leaderboard/board_immutable`, while a new instance takes the new shape. An id is letters, digits, dashes and underscores, up to 64 characters, and cannot be `segment`. Instances are never removed, and nothing caps how many a family has; `allow` is how you bound them.

## Clients

A web app the Worker serves calls the routes through `@pithy-sh/leaderboard/src/client/api`, on its own origin and nowhere else. A mobile app or a game engine generates its client from the Worker's `openapi.json`, which `pithy contract` writes.

## Management

A management client reaches the leaderboard through the control plane, with two scopes. `leaderboard:entries:read` reads every board and family, a family's instances paged by key, a window's entries ranked and paged with hidden ones in place, and the rank-refresh lock. `leaderboard:entries:moderate` hides, unhides and corrects an entry, and clears a stale lock. An instance's entries are read and moderated at `admin/boards/:board/:instance/…`, as a board's are at `admin/boards/:board/…`. Each act takes an idempotency key and a required reason, is recorded in `pithy_leaderboard_moderations` with what it found and what it left, and emits one audit event. The routes sit under `{basePath}/admin/`; [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md) lists them.

A result from `@pithy-sh/multiplayer` is recorded with the entry it wrote, so voiding the result takes back what it put on the board: its points from a `sum` entry, or the entry itself while the result still holds its score. A removed entry takes that record with it, so a later void never touches the player's next entry.

Retention deletes a window whole. With `retain` or `retainDays`, a pruned window's entries, the result records on them and the moderation history of acts on them all go together, because each holds a player's id and score.

## A person's data

**Erased.** When an account is purged, leaderboard deletes the person's entries on every board, in every window, what each session result put on them, and the moderation history of those entries, and an export hands them back first. Who took a moderation act is the operator's, and the export leaves it out; the audit trail keeps it. The purge marks each window it took a ranked entry from as stale, so the rank worker closes the gap on its next pass, in a closed window as in an open one. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
