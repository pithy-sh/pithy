// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AuditActorType, AuditMetadata, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEventRow } from "../data/auditEvent";

/**
 * What a management client is shown of an audit event — decided here, once, rather than by whichever
 * columns a query happened to select.
 *
 * **No route returns a raw row.** The trail is the most sensitive table Pithy ships: it is the record
 * of every security-relevant action across every capability, and it carries personal data the adopter
 * collected from their own users. Handing a `SELECT *` to a client means every column the schema ever
 * gains is disclosed by default, which is exactly backwards.
 *
 * ## What is deliberately absent from both views
 *
 * `id`, the autoincrement surrogate. Its own schema says internal, never exposed, and that is right:
 * it is monotonic, so publishing it tells a client how many events the project has recorded and lets
 * it address rows by counting. Events are addressed by `eventId`, a UUID. The keyset cursor does
 * carry `id` as a position, and that is a different thing — it is opaque, it is not a field a client
 * can filter or address by, and it names only the row that client was just handed.
 *
 * ## What is in the detail view only, and why
 *
 * `ip`, `userAgent`, and `metadata`. These are the trail's personal data, and they are the reason
 * {@link AUDIT_EVENT_DETAIL_READ_SCOPE} exists as a separate grant.
 *
 * - **`ip`** is a personal identifier under GDPR, and it is also the field a forensic read genuinely
 *   needs — "was this login from where this person usually is". So it is exposed, not dropped;
 *   dropping it would make the column pointless and the incident unanswerable. It is exposed one
 *   event at a time, behind its own scope, so reading it is a decision rather than a side effect of
 *   opening a dashboard.
 * - **`userAgent`** is a device fingerprint. Same reasoning, same place.
 * - **`metadata`** is a capability-specific bag whose contents nothing here can predict. `@pithy-sh/testers`
 *   writes an invited tester's email address into it, on purpose, and other capabilities write resource
 *   names and denial reasons. A page of a hundred events would therefore leak an arbitrary amount of
 *   whatever every capability decided to record — so it is not in the listing at any page size.
 *
 * `sessionId` **is** in the list view, and it is not the exception it looks like. Better Auth's session
 * row id is not its session token: the credential is `session.token`, which the trail never holds. The
 * id is a correlation key, and correlating a chain of actions to one sign-in is most of what an audit
 * trail is read for.
 */

/** One event as the listing shows it — everything but the network identifiers and the metadata bag. */
export interface AuditEventView {
  /** The event's stable public id (the recorder's UUID). */
  eventId: string;
  /** When it happened, ISO-8601. */
  occurredAt: string;
  /** The `domain/reason` action code. */
  action: string;
  /** Whether it succeeded, failed, or was denied. */
  outcome: AuditOutcome;
  /** How serious it is, orthogonal to the outcome. */
  severity: AuditSeverity;
  /** The kind of principal that acted. */
  actorType: AuditActorType;
  /** The acting principal's stable id, or null. */
  actorId: string | null;
  /** The session the action belongs to — a row id, never a token — or null. */
  sessionId: string | null;
  /** The kind of thing acted on, or null. */
  resourceType: string | null;
  /** The thing acted on, or null. */
  resourceId: string | null;
  /** The request correlation id, or null. */
  requestId: string | null;
  /** The project the recorder stamped, or null when it recorded none. */
  project: string | null;
  /** The environment the recording Worker served, or null. */
  environment: string | null;
  /** The `apps/<name>` Worker that recorded it, or null for a CLI action. */
  worker: string | null;
  /** The Cloudflare build id that recorded it, or null. */
  version: string | null;
}

/** One event in full — the listing view plus the three fields the detail scope is separate for. */
export interface AuditEventDetailView extends AuditEventView {
  /** The client IP the request came from, or null. Personal data; behind its own scope. */
  ip: string | null;
  /** The client user-agent, or null. A device fingerprint; behind its own scope. */
  userAgent: string | null;
  /** The capability's own structured detail, or null. Arbitrary payload; behind its own scope. */
  metadata: AuditMetadata | null;
}

/** Project one row for the listing. */
export function auditEventView(row: AuditEventRow): AuditEventView {
  return {
    eventId: row.eventId,
    occurredAt: row.occurredAt.toISOString(),
    action: row.action,
    outcome: row.outcome,
    severity: row.severity,
    actorType: row.actorType,
    actorId: row.actorId,
    sessionId: row.sessionId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    requestId: row.requestId,
    project: row.project,
    environment: row.environment,
    worker: row.worker,
    // The point of the column: it turns "this was revoked, by this subject" into "…against this exact
    // build". A forensic view that omitted it would leave the reader guessing which code ran.
    version: row.version,
  };
}

/** Project one row for the single-event read, network identifiers and metadata included. */
export function auditEventDetailView(row: AuditEventRow): AuditEventDetailView {
  return { ...auditEventView(row), ip: row.ip, userAgent: row.userAgent, metadata: row.metadata };
}
