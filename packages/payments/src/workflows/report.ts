// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { LogLevel } from "@pithy-sh/core/src/logger/record";
import type { ReconcileReport } from "./reconcile";

/**
 * What a reconcile pass says about itself: its tally, and each repair it had to make.
 *
 * Both are pure functions of a logger and a value, and both used to live in `worker.ts` beside the
 * Workflow class that calls them. That module imports `cloudflare:workers`, which resolves in workerd
 * and nowhere else, so everything it exported was reachable only from inside the Workers runtime — a
 * Node-side caller taking one of these would have taken the whole runtime module with it and failed
 * with `Could not load pithy.config.ts`, naming the config rather than the import.
 *
 * That is #172 and #180, twice, and neither was noticed until somebody accepted the offer. The shape
 * both were fixed into is this one: a sibling module with no runtime import, which the runtime module
 * imports from. `configEntrypoints.test.ts` states the invariant and holds every runtime module to it.
 *
 * Nothing here needs a binding, a request, or a Workers global, which is why its tests are node tests.
 */

/** An audit event ranks itself; this is that rank as a log level. */
const AUDIT_LEVEL: Record<AuditSeverity, LogLevel> = { info: "info", warning: "warn", critical: "error" };

/**
 * The audit emitter a standalone host can honestly offer: a structured record per repaired purchase.
 *
 * A host worker composes no capabilities, so there is no `@pithy-sh/audit` recorder to reach and no
 * `c.var.emit` to inherit — writing to `pithy_audit_events` from here would mean this package reaching into
 * another capability's tables, which is exactly what the seam exists to prevent. A logged event is what the
 * seam degrades to everywhere else it is uncomposed, and it keeps the drift visible where an operator reads
 * this worker's output. The event shape is core's, so a recorder wired in later takes the identical input.
 *
 * It takes the run's logger rather than building its own, so every event carries the instance the repair
 * happened in — without that, a trail read out of Workers Logs cannot be attributed to a pass.
 */
export function auditLogEmit(log: Logger): AuditEmit {
  return async (event) => {
    // The event already ranks itself, so the record takes that rank rather than inventing one — a repaired
    // drift is emitted at `warning` because a pattern of them is a broken webhook path, and a log that
    // flattened it to `info` would hide exactly the thing the trail exists to surface. Absent severity is
    // the schema's own `info` default.
    log[AUDIT_LEVEL[event.severity ?? "info"]]("audit event, no recorder composed", { ...event });
  };
}

/**
 * The tally, as one record. The run's only visible output: a pass whose findings are invisible is a pass
 * nobody can tell has stopped working.
 *
 * Three levels, and the distinction is the point of logging it at all. `failed` counts purchases a store
 * refused to answer for — a failure that was observed, so an operator has something to chase. `drifted`
 * and `truncated` are the degraded-but-continuing pair: the first says webhooks are being dropped and the
 * repair is covering for them, the second says the page cap stopped the pass with catalog left unread. A
 * clean pass is routine, and a nightly job that reports routine at `warn` teaches an operator to ignore it.
 */
export function logReconcileReport(log: Logger, report: ReconcileReport): void {
  const level: LogLevel = report.failed > 0 ? "error" : report.drifted > 0 || report.truncated ? "warn" : "info";
  log[level]("reconcile pass complete", { ...report });
}
