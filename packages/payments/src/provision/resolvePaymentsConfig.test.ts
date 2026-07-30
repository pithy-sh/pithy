// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { paymentsWorkerName, resolvePaymentsConfig } from "./resolvePaymentsConfig";

/**
 * The template resolution, which is the only place the reconcile worker's deployed identity is decided.
 *
 * The cases that matter are the two the generic resolver deliberately leaves alone: the `workflows` array and
 * the cron come from `workflows/specs.ts`, never from the template's own block. A stale block is planted in
 * the fixture so a resolution that trusted it would be visible rather than plausible.
 */

/** The committed template, as `pithy payments provision` parses it off disk. */
function template(): WorkflowHostTemplate {
  return {
    name: "pithy-payments",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    d1_databases: [
      { binding: "DB", database_name: "pithy-app", database_id: "<filled-at-provision>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled-at-provision>" },
    ],
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled>", secret_name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    workflows: [{ binding: "STALE", name: "stale-name", class_name: "StaleClass" }],
    triggers: { crons: ["@stale"] },
    vars: { PAYMENTS_CONFIG: "<filled-at-provision>", ENVIRONMENT: "<filled-at-provision>" },
  };
}

const CATALOG = PaymentsConfig.parse({
  rails: { apple: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
    },
  },
});

const params = {
  env: "staging" as const,
  appDatabaseId: "app-db-id",
  secretsDatabaseId: "secrets-db-id",
  storeId: "store-id",
  paymentsConfig: CATALOG,
};

describe("resolvePaymentsConfig", () => {
  test("names the worker per environment and fills every provisioned id", () => {
    const resolved = resolvePaymentsConfig(template(), params);
    expect(resolved.name).toBe("pithy-payments-staging");
    expect(resolved.d1_databases?.map((entry) => entry.database_id)).toEqual(["app-db-id", "secrets-db-id"]);
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("store-id");
  });

  test("the master key is environment-scoped; the template's other names are not rewritten", () => {
    const resolved = resolvePaymentsConfig(template(), params);
    expect(resolved.secrets_store_secrets?.[0]?.secret_name).toBe("STAGING_SECRETS_ENCRYPTION_KEYS");
  });

  test("the workflows array comes from the specs, not from the template's own block", () => {
    const resolved = resolvePaymentsConfig(template(), params);
    expect(resolved.workflows).toEqual([
      {
        binding: "PAYMENTS_RECONCILE",
        name: "pithy-payments-reconcile-staging",
        class_name: "PaymentsReconcileWorkflow",
      },
    ]);
  });

  test("the cron comes from the spec's schedule, so moving the pass is a one-line spec edit", () => {
    const resolved = resolvePaymentsConfig(template(), params);
    expect(resolved.triggers).toEqual({ crons: ["0 4 * * *"] });
  });

  test("the catalog is serialized into PAYMENTS_CONFIG, and the environment is stamped", () => {
    // The pass has to map a refreshed store SKU back to a product before it can project it, so the whole
    // catalog travels. Nothing sensitive is in it — every credential lives in the secrets store.
    const resolved = resolvePaymentsConfig(template(), params);
    expect(resolved.vars?.ENVIRONMENT).toBe("staging");
    expect(JSON.parse(resolved.vars?.PAYMENTS_CONFIG ?? "{}")).toEqual(CATALOG);
  });

  test("no credential can reach the worker's vars — they are not in the config to begin with", () => {
    const resolved = resolvePaymentsConfig(template(), params);
    const serialized = JSON.stringify(resolved.vars);
    for (const shape of ["sk_live_", "whsec_", "BEGIN PRIVATE KEY", "issuerId", "serviceAccountEmail"]) {
      expect(serialized).not.toContain(shape);
    }
  });

  test("the worker keeps no public URL — it holds three stores' credentials", () => {
    expect(resolvePaymentsConfig(template(), params).workers_dev).toBe(false);
  });

  test("resolution is pure — the template it was handed is untouched", () => {
    const original = template();
    resolvePaymentsConfig(original, params);
    expect(original.name).toBe("pithy-payments");
    expect(original.workflows?.[0]?.binding).toBe("STALE");
    expect(original.triggers).toEqual({ crons: ["@stale"] });
  });

  test("production resolves to its own worker and workflow names", () => {
    const resolved = resolvePaymentsConfig(template(), { ...params, env: "production" });
    expect(resolved.name).toBe("pithy-payments-production");
    expect(resolved.workflows?.[0]?.name).toBe("pithy-payments-reconcile-production");
  });

  test("the deployed worker name is the one the provisioner and the resolver both derive", () => {
    expect(paymentsWorkerName("staging")).toBe("pithy-payments-staging");
    expect(paymentsWorkerName("production")).toBe("pithy-payments-production");
  });
});
