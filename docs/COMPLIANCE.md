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

## Retention and legal hold

An auditor asks how long you keep things, and counsel asks you to stop deleting them. Both are answered from the Worker.

**How long everything is kept is one block in `pithy.config.ts`.** `retention` declares the purge window for deleted users and organizations, how long audit events are kept by action prefix, and the longest an account may sit inactive while it holds a privacy class (`classAges: { pii: "3y" }`). It is reviewed and deployed like code, and no route changes it. The manifest reports it as it takes effect, every value in days and where it came from, and `pithy doctor` prints it.

**The kit keeps the record of who managed the Worker for at least a year.** A rule that would keep `controlplane/*`, or a deletion, purge, suspension, reinstatement or restore, for less than 365 days refuses to deploy. A shorter default leaves those actions at a year.

**Pruning the trail leaves it verifiable.** The prune writes a tombstone for every run it removes to the checkpoint bucket before deleting a row, and `pithy audit verify` reads the chain as intact across the gap. A run that does not verify is left where it is: the prune never removes the evidence of a break.

**An inactive account is deleted the way any account is.** Past its class age it is soft-deleted, mailed, given its purge window and then purged, and the [erasure attestation](#erasure-attestation) proves it like any other. Its reason says it was inactivity.

**A legal hold stops every purge, prune and inactivity deletion touching its subject until it is released.** A hold names a user, an organization or a tenant's audit trail, with a required reason, and placing and releasing it are both audited. A purge already running stops at its next step. Releasing a hold returns the subject to the policy you deployed; nothing shortens it. A hold on a person is kept after release, as the record that it stood, and an access request's export says when it was placed and released.

`POST /control-plane/holds` places one and `POST /control-plane/holds/:holdId/release` releases it, behind `retention:hold`, a write that `pithy dashboard connect` offers and never grants by default. `GET /control-plane/holds` lists them behind `retention:read`, a read it preselects, and the manifest counts the standing ones. The block, the floor and the routes are [`CONTROL-PLANE.md` §12](CONTROL-PLANE.md#retention-and-legal-holds).

## Shipping the trail

A security team watches its SIEM, not each vendor's console. `@pithy-sh/audit` ships the trail to sinks declared in `pithy.config.ts` — Splunk HEC, Datadog Logs, or any HTTPS endpoint — as each event is written, through a Cloudflare Queue, at least once. The setup and the formats are [`@pithy-sh/audit`'s README](../packages/audit/README.md#shipping-the-trail).

**What leaves the Worker.** By default, no IP, user-agent or metadata value: each event carries their salted commitments instead. A sink declared `detail: true` receives the values and the salt. Decide that per sink, the way the control plane decides it per connection with `audit:events:read_detail`.

**Who can change where it goes.** Only a deploy. A sink is declared in config and reviewed like code; no control-plane route adds, changes or removes one, so a management credential cannot redirect the trail.

**How the receiver checks it.** Every shipped event is the chain's canonical form: its `eventId`, its tenant's `seq`, the `prev` hash and its own `hash`. De-duplicate a redelivery on `eventId`. A tenant's `seq` that skips, or a `prev` that names a hash you never received, is where to look. Two kinds of skip are expected: events the CLI records (`pithy deploy`, `pithy migrate`, `pithy secrets`) are in the chain and are not shipped, and a sink with an `actions` filter skips what it does not take. Reconcile a skip against an export of that range, checked with `pithy audit verify`; a missing event that is neither is a loss. With the values, recompute the commitments too.

**How you know it is flowing.** Audit's manifest entry reports the backlog of events waiting on a retry, the count given up on to the dead-letter queue, and whether delivery is `delivering`, `failing` or `idle`. `pithy doctor` lists every sink and whether each environment holds its token.

Shipping delivers the trail. It changes nothing in it.

## Consent

Where consent is the legal basis, the controller has to be able to demonstrate it (GDPR Art. 7(1)). [`@pithy-sh/consent`](../packages/consent/README.md) records it in your own D1, and the record is the evidence.

- **Purposes are declared and versioned.** A capability declares what it processes under consent, and email declares `email.marketing` and `email.tracking`. You declare yours in `consent({ purposes })`, each with the data classes it covers, whether it is explicit, the weakest method a grant may be given by, and whether a withdrawal must be written. Bump a notice version and every older grant answers no until renewed.
- **The record is append-only by schema.** Every grant and withdrawal is a row the database refuses to update or delete, and an audit event in the tamper-evident trail. The account's purge keeps it, under a stated basis.
- **A signed grant keeps its evidence.** The exact document by its hash, produced again byte for byte; the typed name, the drawn signature or the provider's envelope; how identity was verified; an expiry; and a representative. Names rest encrypted.
- **Visitors and accounts.** A visitor consents against an anonymous device id held only once they choose, merged into their account at sign-in, and recorded. An unmerged visitor's grant expires on a declared window.
- **Email follows it.** Marketing mail goes only to a consenting subject, tracking runs only with consent, and transactional mail is never gated. A withdrawal from marketing suppresses the address for marketing. Without consent composed, `pithy doctor` says tracking runs with no consent record behind it.

**It records and gates, and decides no law.** Which jurisdiction applies, whether a purpose needs consent at all, and refusing to write a classed field without it are yours. The processing record reports the gap instead.

The counts per purpose and version and a subject's record are `GET /consent/control-plane/purposes` and `GET /consent/control-plane/subjects/:kind/:subjectId`, behind `consent:read` ([`CONTROL-PLANE.md` §13](CONTROL-PLANE.md#13-capabilities-contribute-their-own-admin-routes)).
