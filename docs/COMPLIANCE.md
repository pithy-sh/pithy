# Compliance evidence

An auditor asks for evidence. Your Worker already holds most of it, as declarations: which capabilities it composes, how every route verifies its caller, who authorized each management connection and for what, how old the keys are, what each database has applied, which fields are classified and which rest encrypted. **The evidence pack reads those declarations together, in the deployed Worker, and reports them per control.** Nothing is maintained by hand, so nothing drifts from the code.

## Evidence, not a verdict

The pack never says *compliant*, and it never says a control was met. Each entry carries what the Worker read and one of three states:

| State | Means |
|---|---|
| `evidenced` | The facts are present. |
| `gap` | Something is missing. The entry names what. |
| `not-derivable` | The Worker cannot say. The entry names why. |

An auditor weighs the evidence. The pack gives them the facts, the declaration each came from, and the SOC 2 and ISO/IEC 27001:2022 references the control answers. A control with something missing and something unreadable reports `gap`, and lists both. Something the Worker could not read is never reported as present.

## The controls

| Control | SOC 2 | ISO 27001:2022 | What the Worker reads |
|---|---|---|---|
| Audit logging in force | CC7.2 | A.8.15 | Whether `@pithy-sh/audit` is composed, its binding is present, and control-plane calls are recorded. A Worker without audit reports a `gap` naming it. |
| Every route declares how a caller is verified | CC6.1 | A.5.15 | Each route's `describeRoute` verification, counted by strategy. A route with none is named. |
| Management access attributed and scoped | CC6.2, CC6.3 | A.5.18 | Every control-plane connection's principal, kind, purpose and granted scopes. One registered before those were recorded is named. |
| Keys and secrets rotate | CC6.1 | A.8.24 | Each connection's live keys and the age of the oldest, secrets past their declared cadence, and the field key's retirement guard. |
| Change history per environment | CC8.1 | A.8.32 | Each database's applied, pending and undeclared migrations, and the last group with when it applied. |
| Data classified and encrypted at rest | C1.1 | A.8.24 | The privacy classes your schemas hold beside the classes you declared, and the fields marked `encrypted()`. |
| CSRF wherever cookie mode is | CC6.6 | A.8.26 | The routes that take a session cookie, and whether a same-origin policy is published for them. |

The table is versioned in the kit. Every pack carries `mappingVersion`, so a pack from last quarter and one from today say which table they follow. A control that needs a declaration the kit does not hold yet arrives as a new version of the table, not as a guess in this one.

## Reading it

The pack is `GET /control-plane/evidence`, behind `evidence:read`. It is a read, so `pithy dashboard connect` preselects it. A connection made before it existed adds it with `--update` ([`commands/dashboard.md`](commands/dashboard.md)). The hosted dashboard is to render it (`pithy-sh/dashboard#156`); until then, read the route directly. No CLI command reads it.

**It never reaches further than the connection may.** Migration state stays behind `migrations:read`, and secrets' rotation count behind `secrets:status:read`. A connection without one gets a `not-derivable` reason naming the scope, and the control reports `not-derivable` unless it also found a gap. Field names stay behind `privacy:read`; the pack carries classes and counts. Keys appear as ages, never as key material. A principal is the email the connection records, and nothing else.

**It proves, and performs nothing.** Rotating a key, applying a migration and revoking a connection stay where they are, each on its own scope.

The route, its shape and its schema are [`CONTROL-PLANE.md` §12](CONTROL-PLANE.md#evidence). What the privacy classes mean is [`PRIVACY.md`](PRIVACY.md).

## Erasure attestation

The evidence pack proves controls present. The erasure attestation proves that a deletion happened, correctly, and that every one did.

**For one person or one organization**, `GET /control-plane/erasure/user/<id>` or `GET /control-plane/erasure/organization/<id>` answers when it was deleted, by which kind of actor and why, soft or hard, and each purge step: which capability, whether it erased the rows or kept them, the reason it kept them, and when it finished. Then whether the purge is complete, in progress or failed, and the audit event that records each step, by event id and chain position.

**For a period**, `GET /control-plane/erasure?since=…&until=…` counts every purge in the window — complete, in progress, failed — and names each failed or overdue one with the step it stopped at. That is the half an auditor actually asks for: *every erasure last quarter completed*.

**A kept row is never an erased one.** A capability that keeps a person's rows says why, in a sentence written for the person: payments kept for tax law, a suppression kept so the unsubscribe holds (#814). The attestation shows that step as `retained`, with that sentence.

**It cites the trail; it signs nothing.** Every step, the completion and a failure are recorded as audit events, and the trail's hash chain is what makes them tamper-evident. Hand an auditor the attestation and an export of the chain, and `pithy audit verify` checks the events it cites. Without `@pithy-sh/audit` composed, the attestation still reads the purge's own record and says the trail is `absent`.

**Nothing about the person survives in it** beyond the id the record already keeps. No address, no name.

**It proves, and deletes nothing.** Deleting stays where it is, on its own scope. The attestation is behind `erasure:read`, a read, so `pithy dashboard connect` preselects it. The routes and their shape are [`CONTROL-PLANE.md` §12](CONTROL-PLANE.md#erasure).
