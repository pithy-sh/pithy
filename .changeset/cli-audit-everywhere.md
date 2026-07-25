---
"@pithy-sh/cli": minor
---

Audit logging is wired into every CLI command that changes something real, not just `pithy token`. `deploy`, `secrets` (set/rotate/remove and provisioning), `remove` (including the `--drop` that destroys tables, and a declined confirmation recorded as `denied`), `add`, `turnstile`, `email`, `feature provision`/`destroy`, and a `seed --redo` schema reset all record what happened, to what, and under which token — with destructive actions at `warning` or `critical`. Secret **names** are recorded; values never are.

One shared helper (`createCliAudit`) replaces the bespoke copy that lived in `pithy token`, and it returns an **always-callable** emitter rather than an optional one, so a call site never guards — matching core's in-Worker `noopEmit` seam. Auditing stays entirely optional: when the project does not compose `@pithy-sh/audit`, the package will not resolve, the environment's audit database is unresolvable, or credentials are absent, the emitter is inert and costs nothing (the capability check short-circuits before any file read or client construction). Writes are non-fatal — a dropped audit event is logged, never allowed to break the command it was recording.
