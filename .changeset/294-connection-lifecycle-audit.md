---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

A connection's lifecycle is recorded in the adopter's own trail.

`ControlPlaneAuditActions` declared `connectionRegistered`, `connectionUpdated` and `connectionRemoved` from the day the seam shipped, and nothing emitted any of them. Not an oversight in a handler: those are the writes `pithy dashboard` performs by opening the adopter's D1 directly, so no request reaches their Worker and no route is in a position to record one. An adopter could read a *key* rotation in their trail but not the connection being created or destroyed — the larger event was the invisible one.

The write records itself instead, in `connectionRegistry` rather than at its call sites. That module is already the CLI's only door onto the connections table, so "every CLI write to an adopter's connection row is recorded" now holds by construction. `connect` registers, `connect --update`, `connect --public-key` recovery and `revoke-key` update, `disconnect` removes.

Three things this settles. **Where**: the event goes to a recorder built over the same `DB` handle the row was written through, never a database id resolved a second time — on `dev` those are not the same store. **When**: the row lands first and the event follows; a refused write records nothing, and a failed record cannot unwind a write and does not try. **Who**: not `control-plane`, which means a management client called in and proved it, but the adopter's own operator — named from their Cloudflare token where the command has one, `system` with a note where it does not, `worker` and `version` null because no Worker recorded it.

`createCliAudit` gains an injected-database form for this. With a handle passed in, the Cloudflare pair becomes optional and names the actor rather than finding the database; a union type keeps that from loosening the ordinary case. A project not composing `audit` connects exactly as before.

**A declared action code that nothing emits now fails the build.** `packages/cli/src/ci/auditActions.test.ts` compares every declared audit-action map against its use sites across the tree. It found one more on its first run — `PaymentsAuditActions.webhookUnverified`, so a notification failing its authenticity check throws 401 and records nothing — which is filed as #296 and written down as the single exception there.
