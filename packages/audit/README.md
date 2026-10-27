# @pithy-sh/audit

A queryable audit trail for Pithy. Records security-relevant actions — logins, token refreshes, entitlement grants, admin config changes — as durable rows in your own D1, attributed to the right actor.

Better Auth ships no audit plugin, so Pithy owns this.

```sh
pithy add audit
```

**Documentation: [pithy.sh/docs/capabilities/audit](https://pithy.sh/docs/capabilities/audit).** Overview, adding it, using it, and the reference: the event model, actors, querying, retention.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Retained.** When an account is purged, audit erases nothing: *Kept as the record of who did what, which a security review or a dispute is read against.* The purge records the step as retained with that basis, and an export hands back every event where the person is the actor. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

`FSL-1.1-MIT` (Functional Source License). Use it freely for any purpose except a competing product; it converts to MIT two years after each release. The audit trail feeds the premium dashboard, so it starts more restrictive than the MIT core capabilities (CLAUDE.md §Packaging). See `LICENSE`.
