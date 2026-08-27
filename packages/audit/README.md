# @pithy-sh/audit

A queryable audit trail for Pithy. Records security-relevant actions — logins, token refreshes, entitlement grants, admin config changes — as durable rows in your own D1, attributed to the right actor.

Better Auth ships no audit plugin, so Pithy owns this.

```sh
pithy add audit
```

**Documentation: [pithy.sh/docs/capabilities/audit](https://pithy.sh/docs/capabilities/audit).** Overview, adding it, using it, and the reference: the event model, actors, querying, retention.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## License

`FSL-1.1-MIT` (Functional Source License). Use it freely for any purpose except a competing product; it converts to MIT two years after each release. The audit trail feeds the premium dashboard, so it starts more restrictive than the MIT core capabilities (CLAUDE.md §Packaging). See `LICENSE`.
