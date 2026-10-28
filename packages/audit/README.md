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
- `GET /audit/control-plane/export?tenant=…` hands over the range in canonical form, each event with its hash, the link before it, every checkpoint covering it, and every tombstone of the chain. IP, user-agent and metadata values come out only when the connection also holds `audit:events:read_detail`; otherwise their commitments do.

`pithy audit verify <file>` recomputes an export's chain offline and checks it against its checkpoints, so an auditor trusts neither the Worker nor us. Nothing is signed, so nothing needs a key.

**Events from before the upgrade are marked, not chained.** Their chain columns stay null, the listing shows `chainSeq: null`, and verify counts them as `beforeChain`. Nothing back-fills them: a chain asserted over rows nobody checked would be a claim, not evidence. A row with no chain written *after* the chain began is counted as `outsideChain`, beside `beforeChain`, and is not a break: Workers redeploy one at a time, old and new versions serve side by side while one rolls out, and a rollback or an older CLI writes the same way, so an older recorder writing into a chained trail is a normal upgrade, not tampering. `intact` speaks for the chain itself. A row inserted with a chain position is the walk's, and is a break.

This proves the trail is whole. It adds no way to change it. The one way an event leaves is the retention prune, below, and it leaves a tombstone the verify reads across.

**The erasure attestation cites it.** `@pithy-sh/audit` declares `auditCitations`, the seam through which `GET /control-plane/erasure/:subjectType/:subjectId` points at the events a purge recorded: each by event id, tenant, chain position and hash, never its IP, user-agent or metadata. Hand an auditor the attestation and an export of that chain, and `pithy audit verify` checks the events it cites. Without this capability composed, the attestation says its trail is `absent`. [`docs/CONTROL-PLANE.md` §12](../../docs/CONTROL-PLANE.md#erasure) has the shape.

## Retention

**The trail is kept forever unless the Worker says otherwise.** The `retention` block in its `pithy.config.ts` sets how long events are kept, by action prefix, with a default, and the kit holds `controlplane/*` and every lifecycle action at a year at least. The block, its floor and legal holds are [`docs/CONTROL-PLANE.md` §12](../../docs/CONTROL-PLANE.md#retention-and-legal-holds).

**The prune runs in your own Worker**, because it reads the block only that Worker resolves. Export the class beside `createEntrypoint`:

```ts
// apps/api/src/index.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runAuditPrune } from "@pithy-sh/audit/src/workflows/prune";

export class AuditPruneWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runAuditPrune(this.env, event, step, NonRetryableError);
  }
}
```

Then bind it as `AUDIT_PRUNE` in that Worker's `workflows`, beside the `0 2 * * *` cron auth's and organization's purge passes already use. The binding is optional: until it is bound, nothing is pruned.

**A pruned run leaves a tombstone, so the chain still verifies.** Before deleting a row, the prune writes one object per run to the `AUDIT_CHECKPOINTS` bucket, under the chain's checkpoint prefix, where the object lock covers it: the run's positions, the link before it, and the hashes at either end. `GET /audit/control-plane/verify` and `pithy audit verify` bridge the gap with it and answer intact. The Worker's verify also counts the events it crossed, as `pruned`; the CLI's report does not. Without the bucket bound in that Worker, nothing chained is pruned.

- **A run that does not verify stays.** The prune never removes the evidence of a break.
- **The head is never pruned.** The next append links to it.
- **An event kept longer stays where it is.** Windows differ by action, so each run of consecutive events past their windows is pruned on its own.
- **Rows from before the chain** are removed on their own window, with nothing to tombstone.
- **A legal hold on a tenant's trail stops it** at the next page, and the chain stays whole until the hold is released.

## Shipping the trail

**Declare a sink and every event is sent to it as it is written.** Splunk HEC, Datadog Logs, or a generic JSON webhook for Elastic, Sumo Logic and anything else that takes HTTPS:

```ts
audit({
  sinks: {
    siem: {
      profile: "splunk-hec", // or "datadog-logs", or "webhook"
      url: "https://splunk.example.com:8088/services/collector/event",
      secret: "splunk-hec-token", // the @pithy-sh/secrets name the token is read through
      actions: ["auth/", "controlplane/"], // optional: ship only these action prefixes
      detail: false, // the default: ship hashes, never IP, user-agent or metadata values
    },
  },
});
```

Set the token with `pithy secrets create splunk-hec-token --env prod`, then run `pithy upgrade` to write the queue bindings and `pithy provision` to create the queues. An unknown profile, a URL that is not HTTPS, a misspelled key, or a sink with no secret name is refused at config load. Shipping needs the `secrets` capability and Cloudflare Queues, which is on the Workers Paid plan; a project with no sink binds no queue.

**Declared, not toggled.** A sink is reviewed and deployed like code. No control-plane route adds, changes or removes one, so no management credential can point the trail somewhere new.

**Delivered at least once, and never in the way.** Each event a Worker writes goes on the `AUDIT_SHIP` queue once per sink that takes it, naming the event and the sink and nothing else; the Worker's own consumer reads the row back and posts each sink's share of a batch in one request. Enqueueing happens after the write and never fails it. A redirect is never followed, so the token and the batch go only to the URL you declared; a sink answering 3xx counts as a refusal. A sink that refuses or cannot be reached retries after 30 seconds, doubling to an hour, and fails alone: the other sinks still deliver. After ten retries a message goes to `AUDIT_SHIP_DLQ` and waits there for a person. Audit's manifest entry reports `auditShipBacklog`, `auditShipDeadLettered` and `auditShipDelivery` (`delivering`, `failing`, `idle`), behind `audit:events:read`, and `pithy doctor` lists every sink and whether each environment holds its token.

**Redacted by default.** Without `detail: true`, no IP, user-agent or metadata value leaves the Worker. The sink receives their salted commitments instead — the same ones the chain hashes — which verify and disclose nothing. With `detail: true` the values and their salt travel, so the receiver can check the commitments too.

**Verifiable at the receiver.** Every shipped event is the chain's canonical form, format `pithy-audit-ship/1`: its `eventId`, its tenant's `seq`, the `prev` hash and its own `hash`. A receiver de-duplicates a redelivery on `eventId`, which a redelivery carries unchanged. A tenant's `seq` that skips, or a `prev` naming a hash it never received, is where to look, and not every skip is a loss:

- **The CLI's events are in the chain and are not shipped.** `pithy deploy`, `pithy migrate`, `pithy secrets` and the rest record over the D1 REST API, outside any Worker, so they take a position in the chain and nothing enqueues them. Their `worker` is null.
- **A sink with an `actions` filter** skips every position it does not take, by design.

So reconcile a skip against the trail: export that range with `GET /audit/control-plane/export` and check it with `pithy audit verify`. A missing event that is neither a CLI action nor filtered out is a loss. An event from before the chain ships with `seq` and `hash` null.

| Profile | Request |
|---|---|
| `splunk-hec` | `Authorization: Splunk <token>`. One HEC event object per event, newline-joined: `time` in epoch seconds, `source: "pithy"`, `sourcetype: "pithy:audit"`, `host` the Worker, the event under `event`. |
| `datadog-logs` | `DD-API-KEY: <token>`. A JSON array of logs: `ddsource: "pithy"`, `service` the project, `hostname` the Worker, `ddtags` with `env`, `action` and `outcome`, a one-line `message`, the event under `audit`. |
| `webhook` | `Authorization: Bearer <token>`. One JSON document, `{ "format": "pithy-audit-ship/1", "events": [...] }`. |

This delivers the trail. It changes nothing in it.

## A person's data

**Retained.** When an account is purged, audit erases nothing: *Kept as the record of who did what, which a security review or a dispute is read against.* The purge records the step as retained with that basis, and an export hands back every event where the person is the actor. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

`FSL-1.1-MIT` (Functional Source License). Use it freely for any purpose except a competing product; it converts to MIT two years after each release. The audit trail feeds the premium dashboard, so it starts more restrictive than the MIT core capabilities (CLAUDE.md §Packaging). See `LICENSE`.
