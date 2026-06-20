import { AuditEvent, type AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { type D1RetryOptions, withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { AuditMetadataColumn } from "./data/auditEvent";
import type { AuditDatabase } from "./data/tables";
import { AuditInvalidEventError, AuditWriteFailedError } from "./error/errors";

/**
 * The D1-backed audit recorder. `recordAuditEvent` performs a **synchronous, non-fatal** insert: it
 * awaits a direct `INSERT` into `pithy_audit_events` inside the handler, before the response — so the
 * event is durably persisted by the time the caller gets a reply — and it **never throws**. A write
 * failure (or an invalid event) is converted to a namespaced `PithyError` and handed to `onError`
 * (logged by default), so an audit write can never break the action it records (CLAUDE.md §Security:
 * audit is a non-blocking side effect).
 *
 * The insert is wrapped in {@link withD1Retry} to ride out transient `timeout`/`database-busy` faults
 * before falling through to the non-fatal drop; its always-on idempotency guard means a retry after a
 * transport hiccup never double-writes.
 */

/** Options for the recorder. All optional; the defaults log failures and retry transient D1 faults. */
export interface AuditRecorderOptions {
  /**
   * Called with the namespaced failure when an event can't be validated or persisted. Defaults to
   * {@link logAuditError} (a `console.error`). The audit write is non-fatal, so this is the only
   * signal a drop happened — wire it to your log sink in production.
   */
  onError?: (error: PithyError) => void;
  /** Retry tuning for the insert. Defaults to retrying `timeout` and `database-busy`. */
  retry?: D1RetryOptions;
}

/** The default failure sink: log the public message and internal detail. Never re-throws. */
export function logAuditError(error: PithyError): void {
  // The audit record itself failed — surface it. `detail` is internal context (a cause/SQL error),
  // never sent to a client; here it only reaches the server log.
  console.error(`[pithy/audit] ${error.payload.code}: ${error.payload.message}`, error.payload.detail ?? "");
}

/** Map any caught failure to its namespaced audit `PithyError`. A bad event is `invalid_event`; anything else is `write_failed`. */
function toAuditError(error: unknown): PithyError {
  if (error instanceof PithyError) return error;
  if (error instanceof z.ZodError) {
    return new AuditInvalidEventError({ detail: error.message }, { cause: error });
  }
  return new AuditWriteFailedError({ detail: messageOf(error) }, { cause: error });
}

/**
 * Record one audit event. Validates the event against the core {@link AuditEvent} seam, stamps
 * `occurredAt` when the emitter did not, encodes every column through its codec, and inserts the row
 * — all wrapped so no failure escapes. Returns when the event is persisted (or its failure logged).
 */
export async function recordAuditEvent(
  db: AuditDatabase,
  input: AuditEventInput,
  options?: AuditRecorderOptions,
): Promise<void> {
  const onError = options?.onError ?? logAuditError;
  try {
    const event = AuditEvent.parse(input);
    const occurredAt = event.occurredAt ?? new Date();
    // Generated once, before the retry wrapper, so every retry of this one record reuses it. A
    // post-commit transport failure then retries onto the unique eventId index — a UNIQUE violation
    // the guard reads as "already landed", not a duplicate row.
    const eventId = crypto.randomUUID();
    await withD1Retry(
      () =>
        db
          .insertInto("pithyAuditEvents")
          .values({
            eventId,
            occurredAt: SQLiteDate.encode(occurredAt),
            action: event.action,
            outcome: event.outcome,
            severity: event.severity,
            actorType: event.actorType,
            actorId: event.actorId ?? null,
            sessionId: event.sessionId ?? null,
            resourceType: event.resourceType ?? null,
            resourceId: event.resourceId ?? null,
            ip: event.ip ?? null,
            userAgent: event.userAgent ?? null,
            requestId: event.requestId ?? null,
            metadata: event.metadata == null ? null : AuditMetadataColumn.encode(event.metadata),
          })
          .execute(),
      options?.retry,
    );
  } catch (error) {
    onError(toAuditError(error));
  }
}

/** Bind a recorder to one audit database — the `emit` seam `@pithy-sh/audit` installs on the request context. */
export function createAuditEmit(db: AuditDatabase, options?: AuditRecorderOptions): AuditEmit {
  return (input) => recordAuditEvent(db, input, options);
}
