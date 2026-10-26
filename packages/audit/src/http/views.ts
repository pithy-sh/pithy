// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { AccessHistoryRow } from "../accessHistory";
import type { AuditEventRow } from "../data/auditEvent";
import type { ControlPlaneReachRow, ControlPlaneReachSubjectRow } from "../reach";
import type {
  AccessChangeView,
  AuditEventDetailView,
  AuditEventView,
  ControlPlaneReachSubjectView,
  ControlPlaneReachView,
} from "./responses";

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

/**
 * ## The field list lives in `responses.ts`
 *
 * Both view types are `z.output` of the Zod objects there, so there is one declaration of what a
 * client receives rather than an interface here and a mirror of it in every management client. A
 * field added to one and not the other does not compile.
 *
 * Project one row for the listing.
 */
export function auditEventView(row: AuditEventRow): AuditEventView {
  return {
    eventId: row.eventId,
    occurredAt: row.occurredAt.toISOString(),
    action: row.action,
    outcome: row.outcome,
    severity: row.severity,
    actorType: row.actorType,
    actorId: row.actorId,
    // In the listing: it is what tells an agent's action from the dashboard's, which is the first thing
    // a reader after an incident filters on, and it is no more personal than `actorType` beside it.
    actorKind: row.actorKind,
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
    // In the listing, not gated behind the detail scope. It is an opaque id the adopter already holds,
    // not personal data — and a client that can filter by tenant but cannot see which tenant a row
    // carries has to take the filter on trust, which is how a row ends up drawn under the wrong heading.
    tenant: row.tenant,
  };
}

/** Project one row for the single-event read, network identifiers and metadata included. */
export function auditEventDetailView(row: AuditEventRow): AuditEventDetailView {
  return { ...auditEventView(row), ip: row.ip, userAgent: row.userAgent, metadata: row.metadata };
}

/**
 * Project one access change (#831) into the wire union, by what changed.
 *
 * The statement already read nothing but the named metadata keys, so this drops nothing personal; what it does is
 * keep each subject's fields to that subject, so a member change never carries a null `scopesBefore` a client could
 * read as a connection that held nothing.
 */
export function accessChangeView(row: AccessHistoryRow): AccessChangeView {
  const base = {
    eventId: row.eventId,
    occurredAt: row.occurredAt.toISOString(),
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    actorKind: row.actorKind,
    detail: row.recorded ? ("recorded" as const) : ("not_recorded" as const),
  };
  if (row.subject === "member") {
    return {
      ...base,
      subject: "member",
      organizationId: row.organizationId,
      membershipId: row.membershipId,
      userId: row.userId,
      roleBefore: row.roleBefore,
      roleAfter: row.roleAfter,
    };
  }
  if (row.subject === "connection") {
    return {
      ...base,
      subject: "connection",
      connectionId: row.connectionId,
      connectionKind: row.connectionKind,
      purpose: row.purpose,
      principal: row.principal,
      scopesBefore: row.scopesBefore,
      scopesAfter: row.scopesAfter,
      replacedConnectionId: row.replacedConnectionId,
    };
  }
  if (row.keyChange === null) {
    // The statement answers a change for every key subject, so this is a programming-error guard rather than a
    // runtime path. Guessing one would put a registration in the history that may have been a revocation.
    throw new InternalError({
      message: "Audit could not read a key change.",
      detail: `access-history row for event ${row.eventId} is a key change with no change recorded`,
    });
  }
  return { ...base, subject: "key", connectionId: row.connectionId, keyId: row.keyId, change: row.keyChange };
}

/**
 * Project one reach row (#828). Field for field, with the instants as ISO-8601: the statement already read nothing
 * but the scope, the key, the method and the path out of `metadata`, and the tenant out of the handler's events, so
 * there is nothing here to drop.
 */
export function controlPlaneReachView(row: ControlPlaneReachRow): ControlPlaneReachView {
  return {
    tenant: row.tenant,
    action: row.action,
    method: row.method,
    route: row.route,
    matched: row.matched,
    outcome: row.outcome,
    scope: row.scope,
    count: row.count,
    subjects: row.subjects,
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString(),
  };
}

/** Project one subject row (#828), field for field, the same way — never a spread a new field would ride out on. */
export function controlPlaneReachSubjectView(row: ControlPlaneReachSubjectRow): ControlPlaneReachSubjectView {
  return {
    tenant: row.tenant,
    action: row.action,
    method: row.method,
    route: row.route,
    matched: row.matched,
    path: row.path,
    outcome: row.outcome,
    scope: row.scope,
    subjectId: row.subjectId,
    params: { ...row.params },
    count: row.count,
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString(),
  };
}
