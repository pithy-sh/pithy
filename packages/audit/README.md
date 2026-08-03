# @pithy-sh/audit

A queryable audit trail for Pithy. Records security-relevant actions — logins, token refreshes, entitlement grants, admin config changes — as durable, queryable rows, attributed to the right actor. Better Auth ships no audit plugin, so Pithy owns this.

## The seam lives in core

The contract — the `AuditEvent` shape and the `emit()` method on the request context — lives in `@pithy-sh/core`, not here. So any capability records an event through `c.var.emit(...)` without importing this package (principle 4). With no audit capability installed, `emit()` is a no-op recorder, so an audited action can never break for want of auditing. This package is the recorder that seam resolves to once `audit` is composed.

## Write model: synchronous, non-fatal

`emit()` awaits a direct `INSERT` into `pithy_audit_events` inside the handler, before the response — the event is durably persisted by the time the caller gets a reply. A write failure is **logged but never fails the audited action**. The insert is wrapped in `withD1Retry` (ported into core) to ride out transient `timeout`/`database-busy` faults; its idempotency guard means a retry after a transport hiccup never double-writes.

## Store of record is D1

Audit config carries a `database` binding name, defaulting to `DB` — the shared app database. KV is deliberately not an option: an audit log is a query workload (by actor, action, time range, resource, outcome) and KV is get-by-key only.

`pithy_audit_events` is one Zod object — the whole table. `z.output` is the app shape, `z.input` the SQLite row; every JS↔SQLite conversion goes through a codec, and every field is `.describe()`d.

## Where an event came from

Every row carries `project`, `environment`, and `worker`. They are stamped **by the recorder**, from the Worker's own `PROJECT`, `ENVIRONMENT`, and `WORKER` vars — never by the emitter, which has no way to set them and no way to override them. That is the point: origin is a property of the writer, not of the action, so a route cannot claim to be another Worker or another environment.

Two Workers that declare the same binding share one database, so `worker` is the only thing that tells their events apart. And project and environment used to be carried solely by the *name* of the database a row sat in — which a row does not carry, so an exported or aggregated trail lost both.

All three are nullable, permanently. A Worker scaffolded before these vars existed carries none of them, a CLI action came from no Worker at all, and no row written before the columns existed can ever be back-filled. `null` means "not recorded", and nothing invents a value to avoid it.

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

`queryAuditEvents(db, filter)` is a typed Kysely query — filter by actor, action, time range, resource, outcome, severity, and origin (project, environment, worker). It is not an HTTP surface; exposing audit over HTTP belongs to the dashboard/control-plane work.

## CLI emitter

`pithy migrate`, `pithy deploy`, and friends run outside the Worker, so they can't use a D1 binding. `emitFromCLI(d1, event, actor)` writes over the REST API via `@pithy-sh/cloudflare`'s `CloudflareD1Manager`. The actor is resolved once at session start from the CF API token's prefix — `cfut_*` → the developer's email (a `user`), `cfat_*` → the token's name (a `service`) — and cached for the command. Resolution failure is non-fatal: the event is still written, attributed to `system` with a note.

## Don't put secrets in `metadata` — or an origin

`metadata` is capability-specific structured detail, Zod-validated on write and read. The trail is queryable and long-lived — never write a secret, credential, or sensitive payload into it.

Nor an origin. `project`, `environment`, `env`, and `worker` are columns; a `metadata` key by any of those names is refused by `cli/src/audit/originColumns.test.ts`. A key only some emitters remember to set makes a query over it look like it worked, which is how origin was recorded before the columns existed.

## Out of scope (for now)

Tamper-evidence (a hash chain), retention/pruning, an HTTP API over the trail, and isolating audit into its own D1 are deferred to follow-up issues.

## License

`FSL-1.1-MIT` (Functional Source License). Use it freely for any purpose except a competing product; it converts to MIT two years after each release. The audit trail feeds the premium dashboard, so it starts more restrictive than the MIT core capabilities (CLAUDE.md §Packaging). See `LICENSE`.
