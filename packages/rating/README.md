# @pithy-sh/rating

Skill and experience for your games. Two numbers per player, per pool: a skill rating that moves both ways with every result and feeds matchmaking, and an experience total that only ever rises and drives rank.

They are separate on purpose. One number cannot both rank a player fairly and reward them for turning up — a ladder that pays out for playing stops estimating strength, and a rating that only estimates strength has nothing to show a player who is not winning yet.

```sh
pithy add rating
```

**Documentation: [pithy.sh/docs/capabilities/rating](https://pithy.sh/docs/capabilities/rating).** Overview, adding it, using it, and the reference: the algorithms, pools.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Erased.** When an account is purged, rating deletes the person's rating in every pool, and an export hands it back first. Every opponent's own rating is kept in their own row. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
