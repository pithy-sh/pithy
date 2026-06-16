import { describe, expect, test } from "vitest";
import {
  type ManagerWranglerTemplate,
  managerWorkerName,
  resolveAllManagerConfigs,
  resolveManagerConfig,
} from "./resolveManagerConfig";

/** A template mirroring `src/manager/wrangler.jsonc`, with the `<filled-at-provision>` placeholders. */
function template(): ManagerWranglerTemplate {
  return {
    name: "pithy-secrets",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    d1_databases: [{ binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled-at-provision>" }],
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled-at-provision>", secret_name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    workflows: [
      { binding: "SECRETS_WRITE", name: "pithy-secrets-write", class_name: "SecretsWriteWorkflow" },
      { binding: "AT_REST_ROTATION", name: "pithy-secrets-rotate", class_name: "AtRestKeyRotationWorkflow" },
    ],
    triggers: { crons: ["0 3 * * *"] },
    vars: {
      ROTATION_INTERVAL_DAYS: "30",
      CLOUDFLARE_ACCOUNT_ID: "<filled-at-provision>",
      SECRETS_STORE_ID: "<filled>",
    },
  };
}

describe("managerWorkerName", () => {
  test("is the per-env worker name", () => {
    expect(managerWorkerName("staging")).toBe("pithy-secrets-staging");
    expect(managerWorkerName("production")).toBe("pithy-secrets-production");
  });
});

describe("resolveManagerConfig", () => {
  test("fills the per-env name, D1, store, account, and env-suffixed Workflow names", () => {
    const resolved = resolveManagerConfig(template(), {
      env: "staging",
      databaseId: "db-123",
      storeId: "store-abc",
      accountId: "acct-9",
    });

    expect(resolved.name).toBe("pithy-secrets-staging");
    expect(resolved.d1_databases[0]).toEqual({
      binding: "SECRETS",
      database_name: "pithy-secrets-staging",
      database_id: "db-123",
    });
    expect(resolved.secrets_store_secrets[0]).toEqual({
      binding: "SECRETS_ENCRYPTION_KEYS",
      store_id: "store-abc",
      secret_name: "STAGING_SECRETS_ENCRYPTION_KEYS",
    });
    // The write Workflow name is the CLI's dispatch target; both Workflows are env-suffixed.
    expect(resolved.workflows.map((w) => w.name)).toEqual([
      "pithy-secrets-write-staging",
      "pithy-secrets-rotate-staging",
    ]);
    expect(resolved.vars.CLOUDFLARE_ACCOUNT_ID).toBe("acct-9");
    expect(resolved.vars.SECRETS_STORE_ID).toBe("store-abc");
    // Static fields are untouched.
    expect(resolved.compatibility_date).toBe("2025-01-01");
    expect(resolved.triggers.crons).toEqual(["0 3 * * *"]);
    expect(resolved.vars.ROTATION_INTERVAL_DAYS).toBe("30");
    expect(resolved.workers_dev).toBe(false);
  });

  test("does not mutate the input template", () => {
    const input = template();
    resolveManagerConfig(input, { env: "production", databaseId: "d", storeId: "s", accountId: "a" });
    expect(input.name).toBe("pithy-secrets");
    expect(input.d1_databases[0]?.database_id).toBe("<filled-at-provision>");
  });
});

describe("resolveAllManagerConfigs", () => {
  test("resolves one config per managed env from each env's ids", () => {
    const all = resolveAllManagerConfigs(template(), "acct-9", {
      staging: { databaseId: "db-s", storeId: "store-s" },
      production: { databaseId: "db-p", storeId: "store-p" },
    });
    expect(all.map((c) => c.env)).toEqual(["staging", "production"]);
    expect(all[0]?.config.name).toBe("pithy-secrets-staging");
    expect(all[0]?.config.d1_databases[0]?.database_id).toBe("db-s");
    expect(all[1]?.config.name).toBe("pithy-secrets-production");
    expect(all[1]?.config.secrets_store_secrets[0]?.store_id).toBe("store-p");
  });
});
