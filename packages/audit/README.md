# @pithy-sh/audit

A queryable audit trail for Pithy. Records security-relevant actions — logins, token refreshes, entitlement grants, admin config changes — as durable, queryable rows, attributed to the right actor. Better Auth ships no audit plugin, so Pithy owns this.

## The seam lives in core

The contract — the `AuditEvent` shape and the `emit()` method on the request context — lives in `@pithy-sh/core`, not here. So any capability records an event through `c.var.emit(...)` without importing this package (principle 4). With no audit capability installed, `emit()` is a no-op recorder, so an audited action can never break for want of auditing. This package is the recorder that seam resolves to once `audit` is composed.

## Write model: synchronous, non-fatal

`emit()` awaits a direct `INSERT` into `pithy_audit_events` inside the handler, before the response — the event is durably persisted by the time the caller gets a reply. A write failure is **logged but never fails the audited action**. The insert is wrapped in `withD1Retry` (ported into core) to ride out transient `timeout`/`database-busy` faults; its idempotency guard means a retry after a transport hiccup never double-writes.

## Store of record is D1

Audit config carries a `database` binding name, defaulting to `DB` — the shared app database. KV is deliberately not an option: an audit log is a query workload (by actor, action, time range, resource, outcome) and KV is get-by-key only.

`pithy_audit_events` is one Zod object — the whole table. `z.output` is the app shape, `z.input` the SQLite row; every JS↔SQLite conversion goes through a codec, and every field is `.describe()`d.

## Federated taxonomy

`action` is an open, namespace-validated `domain/reason` string. Each capability owns and exports its own action constants and adds them without touching core — the way migrations and table prefixes already federate:

```ts
import { defineAuditActions } from "@pithy-sh/audit/src/actions";

export const AuthAuditActions = defineAuditActions({
  login: "auth/login",
  tokenRefreshed: "auth/token_refreshed",
});
```

## Reading the trail

`queryAuditEvents(db, filter)` is a typed Kysely query — filter by actor, action, time range, resource, outcome, and severity. It is not an HTTP surface; exposing audit over HTTP belongs to the dashboard/control-plane work.

## CLI emitter

`pithy migrate`, `pithy deploy`, and friends run outside the Worker, so they can't use a D1 binding. `emitFromCLI(d1, event, actor)` writes over the REST API via `@pithy-sh/cloudflare`'s `CloudflareD1Manager`. The actor is resolved once at session start from the CF API token's prefix — `cfut_*` → the developer's email (a `user`), `cfat_*` → the token's name (a `service`) — and cached for the command. Resolution failure is non-fatal: the event is still written, attributed to `system` with a note.

## Don't put secrets in `metadata`

`metadata` is capability-specific structured detail, Zod-validated on write and read. The trail is queryable and long-lived — never write a secret, credential, or sensitive payload into it.

## Out of scope (for now)

Tamper-evidence (a hash chain), retention/pruning, an HTTP API over the trail, and isolating audit into its own D1 are deferred to follow-up issues.

## License

`FSL-1.1-MIT` (Functional Source License). Use it freely for any purpose except a competing product; it converts to MIT two years after each release. The audit trail feeds the premium dashboard, so it starts more restrictive than the MIT core capabilities (CLAUDE.md §Packaging). See `LICENSE`.
