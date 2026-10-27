# @pithy-sh/audit

A queryable audit trail for Pithy. Records security-relevant actions — logins, token refreshes, entitlement grants, admin config changes — as durable rows in your own D1, attributed to the right actor.

Better Auth ships no audit plugin, so Pithy owns this.

```sh
pithy add audit
```

**Documentation: [pithy.sh/docs/capabilities/audit](https://pithy.sh/docs/capabilities/audit).** Overview, adding it, using it, and the reference: the event model, actors, querying, retention.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Tamper evidence

**Every event is chained to the one before it.** Each tenant has its own chain, and the events with no tenant have one too. An event written after the upgrade carries its position, the hash of the event before it, and its own SHA-256 over a canonical serialization of every column. The IP, user-agent and metadata are committed by a salted hash rather than included, so an export that leaves them out still verifies. Appends are one compare-and-set statement, so concurrent writes never fork a chain, and an append that loses the race re-reads the head and tries again, so a burst of them to one tenant lands every event. The canonical form lives in `@pithy-sh/core/src/audit/chain`, the one definition the recorder, the Worker and the CLI all read.

**Checkpoints sit outside the database.** Hourly, the prebuilt checkpoint Worker writes each chain's head and count to the `AUDIT_CHECKPOINTS` R2 bucket, one object per checkpoint, never replaced. `pithy deploy` ships it, `pithy provision` creates the bucket, and `pithy audit lock --env <name>` puts an indefinite object lock on it. `pithy doctor` says whether the lock is in force. A chain rewritten end to end, hashes and all, disagrees with a checkpoint it cannot reach, and a truncated one ends before a checkpoint says it did.

**Verify it in the Worker, or without it.** Both reads need `audit:events:export`:

- `GET /audit/control-plane/verify?tenant=…&since=…&until=…` walks the range and answers intact, or the first break with its event id, its position and why: edited, missing, inserted, unlinked, against a checkpoint, or truncated before one.
- `GET /audit/control-plane/export?tenant=…` hands over the range in canonical form, each event with its hash, the link before it and every checkpoint covering it. IP, user-agent and metadata values come out only when the connection also holds `audit:events:read_detail`; otherwise their commitments do.

`pithy audit verify <file>` recomputes an export's chain offline and checks it against its checkpoints, so an auditor trusts neither the Worker nor us. Nothing is signed, so nothing needs a key.

**Events from before the upgrade are marked, not chained.** Their chain columns stay null, the listing shows `chainSeq: null`, and verify counts them as `beforeChain`. Nothing back-fills them: a chain asserted over rows nobody checked would be a claim, not evidence. A row with no chain written *after* the chain began is counted as `outsideChain`, beside `beforeChain`, and is not a break: Workers redeploy one at a time, old and new versions serve side by side while one rolls out, and a rollback or an older CLI writes the same way, so an older recorder writing into a chained trail is a normal upgrade, not tampering. `intact` speaks for the chain itself. A row inserted with a chain position is the walk's, and is a break.

This proves the trail is whole. It adds no way to change it.

**The erasure attestation cites it.** `@pithy-sh/audit` declares `auditCitations`, the seam through which `GET /control-plane/erasure/:subjectType/:subjectId` points at the events a purge recorded: each by event id, tenant, chain position and hash, never its IP, user-agent or metadata. Hand an auditor the attestation and an export of that chain, and `pithy audit verify` checks the events it cites. Without this capability composed, the attestation says its trail is `absent`. [`docs/CONTROL-PLANE.md` §12](../../docs/CONTROL-PLANE.md#erasure) has the shape.

## A person's data

**Retained.** When an account is purged, audit erases nothing: *Kept as the record of who did what, which a security review or a dispute is read against.* The purge records the step as retained with that basis, and an export hands back every event where the person is the actor. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

`FSL-1.1-MIT` (Functional Source License). Use it freely for any purpose except a competing product; it converts to MIT two years after each release. The audit trail feeds the premium dashboard, so it starts more restrictive than the MIT core capabilities (CLAUDE.md §Packaging). See `LICENSE`.
