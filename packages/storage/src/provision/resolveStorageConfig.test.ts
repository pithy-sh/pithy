// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { describe, expect, test } from "vitest";
import { StorageConfig } from "../config/config";
import { resolveStorageConfig } from "./resolveStorageConfig";

/** The committed template, as `pithy storage provision` parses it off disk. */
function template(): WorkflowHostTemplate {
  return {
    name: "pithy-storage",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    d1_databases: [
      { binding: "DB", database_name: "pithy-app", database_id: "<filled-at-provision>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled-at-provision>" },
    ],
    r2_buckets: [{ binding: "STORAGE_BUCKET", bucket_name: "<filled-at-provision>" }],
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled>", secret_name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    workflows: [{ binding: "STALE", name: "stale-name", class_name: "StaleClass" }],
    triggers: { crons: ["@stale"] },
    vars: { STORAGE_CONFIG: "<filled-at-provision>", ENVIRONMENT: "<filled-at-provision>" },
  };
}

const params = {
  env: "staging" as const,
  appDatabaseId: "app-db-id",
  secretsDatabaseId: "secrets-db-id",
  storeId: "store-id",
  resources: { bucketName: "pithy-storage-staging" },
  storageConfig: StorageConfig.parse({}),
};

describe("resolveStorageConfig", () => {
  test("names the worker per environment and fills every provisioned id", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.name).toBe("pithy-storage-staging");
    expect(resolved.d1_databases?.map((entry) => entry.database_id)).toEqual(["app-db-id", "secrets-db-id"]);
    expect(resolved.r2_buckets?.[0]?.bucket_name).toBe("pithy-storage-staging");
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("store-id");
  });

  test("the master key is environment-scoped; the template's other names are not rewritten", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.secrets_store_secrets?.[0]?.secret_name).toBe("STAGING_SECRETS_ENCRYPTION_KEYS");
  });

  test("the workflows array comes from the specs, not from the template's own block", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.workflows).toEqual([
      { binding: "STORAGE_SWEEP", name: "pithy-storage-sweep-staging", class_name: "StorageSweepWorkflow" },
    ]);
  });

  test("the cron comes from the spec's schedule, so changing it is a one-line spec edit", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.triggers).toEqual({ crons: ["0 3 * * *"] });
  });

  test("the resolved config is serialized into STORAGE_CONFIG, and the environment is stamped", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.vars?.ENVIRONMENT).toBe("staging");
    expect(JSON.parse(resolved.vars?.STORAGE_CONFIG ?? "{}")).toEqual(StorageConfig.parse({}));
  });

  test("resolution is pure — the template it was handed is untouched", () => {
    const original = template();
    resolveStorageConfig(original, params);
    expect(original.name).toBe("pithy-storage");
    expect(original.workflows?.[0]?.binding).toBe("STALE");
  });

  test("production resolves to its own worker, bucket, and workflow names", () => {
    const resolved = resolveStorageConfig(template(), {
      ...params,
      env: "production",
      resources: { bucketName: "pithy-storage-production" },
    });
    expect(resolved.name).toBe("pithy-storage-production");
    expect(resolved.workflows?.[0]?.name).toBe("pithy-storage-sweep-production");
  });
});
