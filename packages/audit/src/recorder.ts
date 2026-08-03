// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

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

/**
 * Where the recording happened — the three origin columns, supplied to the **recorder**, never by an
 * emitter.
 *
 * This is deliberately not a field on `AuditEvent`. Origin is a property of the *writer*, not of the
 * action, and putting it on the event seam would make it caller-settable: any of the ~40 `c.var.emit`
 * sites could then claim to be another Worker, another environment, or another project, and the column
 * would be worth nothing precisely when it mattered. Binding it here means an emitter cannot set it,
 * cannot omit it, and cannot get it wrong.
 *
 * Every field is nullable because every field is genuinely unknowable in some real case: a Worker
 * scaffolded before the vars existed carries none of them, and `worker` is always null for a
 * CLI-originated action, which came from no Worker at all.
 */
export interface AuditOrigin {
  /** The owning project, from the Worker's `PROJECT` var or the CLI's resolved project name. */
  project: string | null;
  /** The environment served, from `ENVIRONMENT` or the command's `--env`. */
  environment: string | null;
  /** The recording Worker's `apps/<name>` directory name; null for a CLI action. */
  worker: string | null;
}

/** No origin established — what an unstamped Worker and an un-migrated caller both record. */
const NO_ORIGIN: AuditOrigin = { project: null, environment: null, worker: null };

/** Options for the recorder. All optional; the defaults route failures to a sink and retry transient D1 faults. */
export interface AuditRecorderOptions {
  /**
   * Where this recorder is writing from, stamped onto every event it records. Omitted, the three
   * columns are `null` — the same shape as a row written before they existed, which is the truthful
   * answer rather than a guess.
   */
  origin?: AuditOrigin;
  /**
   * Called with the namespaced failure when an event can't be validated or persisted. The audit write
   * is non-fatal, so this is the only signal a drop happened. The audit capability wires it to the core
   * logger seam (`c.var.log.error(...)`); when omitted the failure is dropped silently — pass a sink.
   */
  onError?: (error: PithyError) => void;
  /** Retry tuning for the insert. Defaults to retrying `timeout` and `database-busy`. */
  retry?: D1RetryOptions;
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
  const onError = options?.onError ?? (() => {});
  const origin = options?.origin ?? NO_ORIGIN;
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
            // Last, and from `options` rather than `event` — the event cannot reach these columns.
            project: origin.project,
            environment: origin.environment,
            worker: origin.worker,
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
