# @pithy-sh/rating

Skill and experience for your games. Two numbers per player, per pool: a skill rating that moves both ways with every result and feeds matchmaking, and an experience total that only ever rises and drives rank.

They are separate on purpose. One number cannot both rank a player fairly and reward them for turning up — a ladder that pays out for playing stops estimating strength, and a rating that only estimates strength has nothing to show a player who is not winning yet.

```sh
pithy add rating
```

**Documentation: [pithy.sh/docs/capabilities/rating](https://pithy.sh/docs/capabilities/rating).** Overview, adding it, using it, and the reference: the algorithms, pools.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Management

Every outcome rating applies is appended to an outcome log, `pithy_rating_outcomes` and `pithy_rating_outcome_players`, in the same D1 batch that moves the ratings, so when the log cannot be written no rating moves. With `controlplane()` composed, a management client reads and repairs ratings with two scopes. `rating:players:read` reads every pool with its algorithm, a pool's ratings by skill, and one player's rating with the outcomes behind it. `rating:players:adjust` recalculates a player's rating by replaying their outcomes from the log, or resets it to the algorithm's starting state, each with an idempotency key and a required reason. Each act is recorded in `pithy_rating_adjustments` with the rating before and after, and emits one audit event. A rating with no logged outcome behind it has nothing to replay, and recalculating it is refused rather than reset. A rating older than the log replays from where the log first saw it. A capability composed beside rating voids a result through `ratingPeer.voidResult`, which marks the result's outcomes void and recalculates every player they touched. The routes and the rules are in [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md) §13.

## A person's data

**Erased, and anonymized in the log.** When an account is purged, rating deletes the person's rating in every pool and the control-plane acts on it, and an export hands them back first, with every outcome the person played. Their place in each logged outcome is replaced by an `erased-` stand-in, one per outcome, so every opponent's rating still replays exactly. Every opponent's own rating is kept in their own row. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
