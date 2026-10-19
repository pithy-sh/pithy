// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { describe, expect, test } from "vitest";
import { logAuditEmit } from "./auditLog";

describe("logAuditEmit — the manager's audit trail, in its own logs (#602)", () => {
  test("writes one record per event, at the level the event ranks itself", async () => {
    const records: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const log = createWorkerLogger({ name: "secrets:value-rotation", emit: (record) => records.push(record as never) });
    const emit = logAuditEmit(log);
    await emit({ action: "secrets/rotated", outcome: "success", actorType: "system" });
    await emit({ action: "secrets/rotated", outcome: "failure", severity: "critical", actorType: "system" });
    await emit({ action: "secrets/version_retired", outcome: "failure", severity: "warning", actorType: "system" });
    expect(records.map((record) => record.level)).toEqual(["info", "error", "warn"]);
    expect(JSON.stringify(records[1])).toContain("secrets/rotated");
  });
});
