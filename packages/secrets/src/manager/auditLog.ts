// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEventInput, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { LogLevel } from "@pithy-sh/core/src/logger/record";

/** An audit event ranks itself; this is that rank as a log level. */
const AUDIT_LEVEL: Record<AuditSeverity, LogLevel> = { info: "info", warning: "warn", critical: "error" };

/**
 * **The audit emitter the secrets manager can honestly offer: a structured record per event (#602).**
 *
 * The manager composes no capabilities, so there is no `@pithy-sh/audit` recorder to reach and no
 * `c.var.emit` to inherit — and writing `pithy_audit_events` from here would mean this package reaching into
 * another capability's table in another database, which is what the seam exists to prevent. A logged event
 * is what the seam degrades to wherever it is uncomposed, the same shape `@pithy-sh/payments`' reconcile
 * host emits, and it lands in Workers Logs for this Worker, where an operator reads the manager's output.
 * The event shape is core's, so a recorder wired in later takes the identical input.
 *
 * Nothing in an event carries a value: the rotation emits names, version keys and reason codes, and the
 * schema's own rule — never a secret in metadata — is the one these events were written against.
 */
export function logAuditEmit(log: Logger): AuditEmit {
  // Annotated, not inferred: `AuditEmit` is generic over `metadata` so an emit site carrying a marked value
  // fails to compile (#132), and an event that reached here already passed that gate.
  return async (event: AuditEventInput) => {
    log[AUDIT_LEVEL[event.severity ?? "info"]]("audit event, no recorder composed", { ...event });
  };
}
