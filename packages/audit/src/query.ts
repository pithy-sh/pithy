import type { AuditActorType, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { AuditEventRow } from "./data/auditEvent";
import type { AuditDatabase } from "./data/tables";

/**
 * A filter over the audit trail. Every field is optional and ANDed together; an empty filter returns
 * the whole trail (newest first). This is the typed read seam consumers use to read events by actor,
 * action, time range, resource, outcome, and severity.
 *
 * It is a Kysely query, not an HTTP surface, and it stays that way. The `control-plane` seam now
 * exists (`@pithy-sh/core/src/controlPlane`, `docs/CONTROL-PLANE.md`), and a capability that wants to
 * expose its own admin surface contributes routes behind `requireControlPlane(scope)` — so audit
 * routes, when they land, will be this package's own contribution rather than something core reaches
 * in and adds. `actorType: "control-plane"` is what separates a management client's actions from the
 * adopter's own users', which is the question that surface is actually asked.
 */
export interface AuditQuery {
  /** Match the acting principal's kind. */
  actorType?: AuditActorType;
  /** Match the acting principal's id. */
  actorId?: string;
  /** Match an exact `domain/reason` action code. */
  action?: string;
  /** Match the outcome (`success` | `failure` | `denied`). */
  outcome?: AuditOutcome;
  /** Match the severity (`info` | `warning` | `critical`). */
  severity?: AuditSeverity;
  /** Match the targeted resource's type. */
  resourceType?: string;
  /** Match the targeted resource's id. */
  resourceId?: string;
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date;
  /** Inclusive upper bound on `occurredAt`. */
  to?: Date;
  /** Cap the number of rows returned. */
  limit?: number;
}

/**
 * Read audit events matching `filter`, newest first (`occurredAt` then `id`, both descending). Each
 * row is decoded back through {@link AuditEventRow} — dates become `Date`s, `metadata` a parsed and
 * validated object — so callers get the app shape, never raw SQLite columns.
 */
export async function queryAuditEvents(db: AuditDatabase, filter: AuditQuery = {}): Promise<AuditEventRow[]> {
  let query = db.selectFrom("pithyAuditEvents").selectAll();

  if (filter.actorType !== undefined) query = query.where("actorType", "=", filter.actorType);
  if (filter.actorId !== undefined) query = query.where("actorId", "=", filter.actorId);
  if (filter.action !== undefined) query = query.where("action", "=", filter.action);
  if (filter.outcome !== undefined) query = query.where("outcome", "=", filter.outcome);
  if (filter.severity !== undefined) query = query.where("severity", "=", filter.severity);
  if (filter.resourceType !== undefined) query = query.where("resourceType", "=", filter.resourceType);
  if (filter.resourceId !== undefined) query = query.where("resourceId", "=", filter.resourceId);
  if (filter.from !== undefined) query = query.where("occurredAt", ">=", SQLiteDate.encode(filter.from));
  if (filter.to !== undefined) query = query.where("occurredAt", "<=", SQLiteDate.encode(filter.to));

  query = query.orderBy("occurredAt", "desc").orderBy("id", "desc");
  if (filter.limit !== undefined) query = query.limit(filter.limit);

  const rows = await query.execute();
  return rows.map((row) => AuditEventRow.parse(row));
}
