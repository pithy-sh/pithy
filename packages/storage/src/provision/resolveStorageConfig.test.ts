// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
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
  project: "acme",
  env: "staging" as const,
  appDatabaseId: "app-db-id",
  secretsDatabaseId: "secrets-db-id",
  storeId: "store-id",
  resources: { bucketName: "acme-staging-storage" },
  storageConfig: StorageConfig.parse({}),
};

describe("resolveStorageConfig", () => {
  test("names the worker per environment and fills every provisioned id", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.name).toBe("acme-staging-storage");
    expect(resolved.d1_databases?.map((entry) => entry.database_id)).toEqual(["app-db-id", "secrets-db-id"]);
    expect(resolved.r2_buckets?.[0]?.bucket_name).toBe("acme-staging-storage");
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("store-id");
  });

  test("the master key entry is the project's and the environment's, as the secrets manager named it", () => {
    const resolved = resolveStorageConfig(template(), params);
    // Asserted through the secrets package's own function rather than a literal: it owns that naming,
    // and a copy here would be a second declaration free to drift from the value actually written.
    expect(resolved.secrets_store_secrets?.[0]?.secret_name).toBe(masterKeySecretName("acme", "staging"));
  });

  test("the workflows array comes from the specs, not from the template's own block", () => {
    const resolved = resolveStorageConfig(template(), params);
    expect(resolved.workflows).toEqual([
      { binding: "STORAGE_SWEEP", name: "acme-staging-storage-sweep", class_name: "StorageSweepWorkflow" },
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

  test("prod resolves to its own worker, bucket, and workflow names", () => {
    const resolved = resolveStorageConfig(template(), {
      ...params,
      env: "prod",
      resources: { bucketName: "acme-prod-storage" },
    });
    expect(resolved.name).toBe("acme-prod-storage");
    expect(resolved.workflows?.[0]?.name).toBe("acme-prod-storage-sweep");
  });

  test("a second project resolves to entirely different worker and Workflow names", () => {
    const resolved = resolveStorageConfig(template(), { ...params, project: "globex" });
    expect(resolved.name).toBe("globex-staging-storage");
    expect(resolved.workflows?.[0]?.name).toBe("globex-staging-storage-sweep");
  });
});
