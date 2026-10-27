// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { readFileSync } from "node:fs";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { describe, expect, test } from "vitest";
import { auditCheckpointBucketName, resolveAuditConfig } from "./resolveAuditConfig";

const template = parse(
  readFileSync(new URL("../workflows/wrangler.jsonc", import.meta.url), "utf8"),
) as unknown as WorkflowHostTemplate;

describe("resolveAuditConfig (#822)", () => {
  test("names the host, its Workflow and its cron for the project and environment", () => {
    const resolved = resolveAuditConfig(template, {
      project: "acme",
      env: "prod",
      auditDatabaseId: "db-123",
      bucketName: "acme-prod-audit-checkpoints",
    });
    expect(resolved.name).toBe("acme-prod-audit");
    expect(resolved.workflows).toEqual([
      { binding: "AUDIT_CHECKPOINT", name: "acme-prod-audit-checkpoint", class_name: "AuditCheckpointWorkflow" },
    ]);
    expect(resolved.triggers).toEqual({ crons: ["20 * * * *"] });
    expect(resolved.d1_databases?.[0]).toMatchObject({ binding: "DB", database_id: "db-123" });
    expect(resolved.r2_buckets).toEqual([{ binding: "AUDIT_CHECKPOINTS", bucket_name: "acme-prod-audit-checkpoints" }]);
  });

  test("the bucket is the one `pithy provision` creates for the app's binding", () => {
    expect(auditCheckpointBucketName("acme", "staging")).toBe("acme-staging-audit-checkpoints");
  });
});
