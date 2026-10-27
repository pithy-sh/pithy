# @pithy-sh/testers

The roster, the invitations, and the fourteen-day clock — for the closed test Google Play makes every new personal developer account run before it will grant production access.

Twelve testers, opted in for fourteen continuous days. Lose one on day nine and the clock effectively restarts. There is no screen anywhere that tells you where you stand, which is the entire problem.

```sh
pithy add testers
```

**Documentation: [pithy.sh/docs/capabilities/testers](https://pithy.sh/docs/capabilities/testers).** Overview, adding it, using it, and the reference: the estimate, provisioning, what the store APIs cannot tell you.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Erased.** When an account is purged, testers deletes the person's membership of every cohort — found by the account's address, the join key — and every event recorded against it, and an export hands them back first, without the opt-in token. Cohort counts stay. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT.
