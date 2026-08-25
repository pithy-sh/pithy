// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AuditActorType, AuditMetadata, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import { z } from "zod";

/**
 * What the audit routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves of the
 * contract are runtime values for the same reason: a client reading a customer's Worker is crossing a
 * trust boundary in *both* directions, and a TypeScript interface is erased before it can help — it
 * cannot check a response, so every client that had only an interface hand-wrote a mirror of it, and
 * the mirror drifted the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These schemas describe JSON on the wire, so
 * parsing one must hand back exactly what went in — that is what lets `responses.test.ts` compare the
 * parsed value with the projection's output and fail on a field either side forgot. A `SQLiteDate`
 * here would decode an ISO string into a `Date` and quietly make that comparison meaningless.
 *
 * The projections that fill these live in `views.ts`, which documents *why* each field is in one view
 * and not the other. This file is the shape; that file is the argument.
 *
 * **A field added here later is `.optional()`, not merely `.nullable()`.** This module is read across a
 * version boundary — a management client validates a response with this schema against a customer's
 * Worker at whatever kit version it is on — so an additive required key fails `safeParse` for everyone
 * below that release and takes the whole pane with it (#450). Absent then means *this Worker cannot
 * say*, which is a different fact from `null`.
 */

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/**
 * One event as the listing shows it — everything but the network identifiers and the metadata bag.
 *
 * The type is derived from this object rather than declared beside it, so a field cannot exist in one
 * and not the other.
 */
export const AuditEventView = z
  .object({
    eventId: z.string().describe("The event's stable public id (the recorder's UUID)."),
    occurredAt: z.iso.datetime().describe("When it happened, ISO-8601."),
    action: z.string().describe("The `domain/reason` action code."),
    outcome: AuditOutcome.describe("Whether it succeeded, failed, or was denied."),
    severity: AuditSeverity.describe("How serious it is, orthogonal to the outcome."),
    actorType: AuditActorType.describe("The kind of principal that acted."),
    actorId: z.string().nullable().describe("The acting principal's stable id, or null."),
    sessionId: z.string().nullable().describe("The session the action belongs to — a row id, never a token — or null."),
    resourceType: z.string().nullable().describe("The kind of thing acted on, or null."),
    resourceId: z.string().nullable().describe("The thing acted on, or null."),
    requestId: z.string().nullable().describe("The request correlation id, or null."),
    project: z.string().nullable().describe("The project the recorder stamped, or null when it recorded none."),
    environment: z.string().nullable().describe("The environment the recording Worker served, or null."),
    worker: z.string().nullable().describe("The `apps/<name>` Worker that recorded it, or null for a CLI action."),
    version: z.string().nullable().describe("The Cloudflare build id that recorded it, or null."),
    tenant: z
      .string()
      .nullable()
      .describe("The tenant the action was taken for, or null when it was not tenant-scoped."),
  })
  .describe("One audit event as the listing shows it. No client IP, no user-agent, no metadata bag.");
export type AuditEventView = z.output<typeof AuditEventView>;

/**
 * One event in full — the listing view plus the three fields the detail scope exists to separate.
 *
 * Re-described after `.extend()`: extending builds a new schema, and a description does not follow it.
 */
export const AuditEventDetailView = AuditEventView.extend({
  ip: z
    .string()
    .nullable()
    .describe("The client IP the request came from, or null. Personal data; behind its own scope."),
  userAgent: z
    .string()
    .nullable()
    .describe("The client user-agent, or null. A device fingerprint; behind its own scope."),
  metadata: AuditMetadata.nullable().describe(
    "The capability's own structured detail, or null. Arbitrary payload; behind its own scope.",
  ),
}).describe("One audit event in full — the listing view plus the client IP, user-agent, and metadata bag.");
export type AuditEventDetailView = z.output<typeof AuditEventDetailView>;

/** `GET {base}/events`. */
export const AuditEventsResponse = z
  .object({
    events: z.array(AuditEventView).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A filtered, resumable page of the audit trail.");
export type AuditEventsResponse = z.output<typeof AuditEventsResponse>;

/** `GET {base}/events/:eventId`. */
export const AuditEventResponse = z
  .object({ event: AuditEventDetailView.describe("The event, with the fields the detail scope gates.") })
  .describe("One audit event in full.");
export type AuditEventResponse = z.output<typeof AuditEventResponse>;
