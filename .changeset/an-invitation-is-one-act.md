---
"@pithy-sh/organization": patch
"@pithy-sh/secrets": patch
---

Inviting an address that already holds an offer is one transaction, not two statements.

`invite()` canceled the standing offer and inserted the new one in two separate awaits. Two concurrent invitations to one mailbox — a double-clicked Send, a retried POST — both found nothing to supersede and both inserted. The partial unique index underneath refused the second, so the table stayed correct, but the caller that lost got a raw constraint violation: a 500 on an ordinary action.

Both statements now go into one `d1.batch`, which D1 runs as a transaction, the same way `acceptInvitation` already did and for the same reason. The later of two concurrent invites supersedes the earlier and both callers get the offer they asked for. The index stays underneath as the backstop for a writer that never came through here.

Two migrations also now drop every index they create, matching the fourteen that already did — `@pithy-sh/organization` created six and dropped none, `@pithy-sh/secrets` created one and dropped none. SQLite takes an index with its table, so this changes nothing at runtime; what it changes is that a `down` reads as the inverse of its `up` in every capability, and a new test across the whole tree fails when one stops.
