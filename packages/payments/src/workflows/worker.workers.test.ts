// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { describe, expect, test } from "vitest";
import { PaymentsAuditActions } from "../audit/actions";
import type { ReconcileReport } from "./reconcile";
import { auditLogEmit, logReconcileReport } from "./worker";

/**
 * The reconcile worker's two outputs, as records rather than as text.
 *
 * A workers-project test because the module imports `cloudflare:workers` to extend `WorkflowEntrypoint`; a node
 * test cannot load it. Nothing here runs a pass — the pass has its own suite. What is proved is the part an
 * operator depends on: that the tally and every uncomposed audit event arrive as queryable fields, and that
 * their level tells a degraded pass from a healthy one instead of flattening both to `info`.
 */

/** A logger whose records land in `records`, through the adapter's own injection point. */
function capture(): { records: LogRecord[]; log: ReturnType<typeof createWorkerLogger> } {
  const records: LogRecord[] = [];
  return { records, log: createWorkerLogger({ name: "payments:reconcile", emit: (r) => records.push(r) }) };
}

const CLEAN: ReconcileReport = {
  pages: 1,
  scanned: 12,
  unchanged: 12,
  drifted: 0,
  superseded: 0,
  skipped: 0,
  failed: 0,
  truncated: false,
  dryRun: false,
};

describe("logReconcileReport", () => {
  test("carries the tally as fields, not as a serialized string", () => {
    const { records, log } = capture();
    logReconcileReport(log, { ...CLEAN, drifted: 0 });

    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("payments:reconcile");
    expect(records[0]?.fields).toMatchObject({ pages: 1, scanned: 12, unchanged: 12, drifted: 0, dryRun: false });
    // The point of the change: no `{` in the message means nothing was stringified into it.
    expect(String(records[0]?.msg)).not.toContain("{");
  });

  test("a clean pass is info", () => {
    const { records, log } = capture();
    logReconcileReport(log, CLEAN);
    expect(records[0]?.level).toBe("info");
  });

  test("drift found is warn — repaired, but the webhook path is dropping deliveries", () => {
    const { records, log } = capture();
    logReconcileReport(log, { ...CLEAN, drifted: 3 });
    expect(records[0]?.level).toBe("warn");
  });

  test("a pass that stopped at its page cap is warn — the rest of the catalog went unexamined", () => {
    const { records, log } = capture();
    logReconcileReport(log, { ...CLEAN, truncated: true });
    expect(records[0]?.level).toBe("warn");
  });

  test("a store that refused to answer is error, even beside repaired drift", () => {
    const { records, log } = capture();
    logReconcileReport(log, { ...CLEAN, drifted: 3, failed: 1 });
    expect(records[0]?.level).toBe("error");
  });
});

describe("auditLogEmit", () => {
  test("the event lands in fields — action, resource, and metadata all queryable", async () => {
    const { records, log } = capture();
    await auditLogEmit(log)({
      action: PaymentsAuditActions.purchaseReconciled,
      outcome: "success",
      severity: "warning",
      actorType: "service",
      actorId: PaymentsAuditActions.purchaseReconciled,
      resourceType: "purchase",
      resourceId: "pur_1",
      metadata: { rail: "apple", from: "active", to: "expired" },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toMatchObject({
      action: "payments/purchase_reconciled",
      outcome: "success",
      resourceType: "purchase",
      resourceId: "pur_1",
      metadata: { rail: "apple", from: "active", to: "expired" },
    });
    expect(String(records[0]?.msg)).not.toContain("{");
  });

  test("the event's own severity picks the level — a warning never logs as info", async () => {
    const { records, log } = capture();
    const emit = auditLogEmit(log);
    const base = { action: "payments/x", outcome: "success", actorType: "service" } as const;

    await emit({ ...base, severity: "info" });
    await emit({ ...base, severity: "warning" });
    await emit({ ...base, severity: "critical" });
    // Absent is the schema's own default, and must not become a level the emitter invented.
    await emit(base);

    expect(records.map((r) => r.level)).toEqual(["info", "warn", "error", "info"]);
  });
});
