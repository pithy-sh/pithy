import {
  AuditAction,
  AuditActorType,
  AuditMetadata,
  AuditOutcome,
  AuditSeverity,
} from "@pithy-sh/core/src/audit/auditEvent";
import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_audit_events` table — one row per recorded security-relevant action. One Zod object is
 * the whole table definition: `z.output` is the app shape (a `Date` for `occurredAt`, a decoded
 * object for `metadata`), `z.input` is the SQLite row shape (ms-epoch numbers, JSON strings), and
 * every JS↔SQLite conversion goes through a codec. The taxonomy enums and the `action` validator are
 * core's (`@pithy-sh/core/src/audit/auditEvent`) — the seam every emitter writes to; this table is
 * how `@pithy-sh/audit` persists it.
 *
 * The `pithy_audit_` prefix (CamelCasePlugin snake-cases `pithyAuditEvents` → `pithy_audit_events`)
 * keeps the table from clashing with an adopter's own (principle 1). `id` is an autoincrement
 * surrogate giving natural event ordering; it is internal and never exposed over HTTP.
 */
/**
 * The `metadata` column codec — the JSON ↔ object conversion, Zod-validated against {@link AuditMetadata}
 * on both sides. Exported so the recorder encodes the column through the same codec it is read back
 * with, rather than hand-rolling `JSON.stringify` (CLAUDE.md §Data layer).
 */
export const AuditMetadataColumn = sqliteJson(AuditMetadata);

export const AuditEventRow = z
  .object({
    id: z
      .number()
      .int()
      .describe(
        "Autoincrement surrogate primary key. Monotonic, so it gives natural event ordering; internal, never exposed.",
      ),
    eventId: z
      .string()
      .describe(
        "Client-generated unique idempotency key (a UUID), set by the recorder before the insert and held stable across `withD1Retry` attempts. The unique index turns a retry after a post-commit transport hiccup into a no-op (the guard fires) instead of a duplicate row.",
      ),
    occurredAt: SQLiteDate.describe(
      "When the action occurred. Ms-epoch in SQLite, a `Date` in app code; indexed for time-range queries.",
    ),
    action: AuditAction.describe(
      "What happened, as a namespaced `domain/reason` action code; indexed for per-action queries.",
    ),
    outcome: AuditOutcome.describe("Whether the action succeeded, failed, or was denied."),
    severity: AuditSeverity.describe(
      "How serious the event is, orthogonal to outcome; drives dashboard filtering and alerting.",
    ),
    actorType: AuditActorType.describe("The kind of principal that acted."),
    actorId: z
      .string()
      .nullable()
      .describe(
        "The acting principal's stable id (user id, service/token name); null for `system`/`anonymous`. Indexed.",
      ),
    sessionId: z
      .string()
      .nullable()
      .describe("The session this action belongs to, tying a chain of actions together; null when none."),
    resourceType: z
      .string()
      .nullable()
      .describe("The type of resource the action targeted (e.g. `user`, `secret`); null when not resource-scoped."),
    resourceId: z
      .string()
      .nullable()
      .describe("The id of the resource the action targeted; null when not resource-scoped."),
    ip: z.string().nullable().describe("The client IP the request came from, for correlation; null when unknown."),
    userAgent: z.string().nullable().describe("The client user-agent string, for correlation; null when unknown."),
    requestId: z
      .string()
      .nullable()
      .describe("The request correlation id, tying this event to one request/trace; null when unknown."),
    metadata: AuditMetadataColumn.nullable().describe(
      "Capability-specific structured detail as a JSON column, Zod-validated on write and read; null when there is none.",
    ),
  })
  .describe("One audit event in `pithy_audit_events` — the durable, queryable record of a security-relevant action.");
export type AuditEventRow = z.output<typeof AuditEventRow>;
