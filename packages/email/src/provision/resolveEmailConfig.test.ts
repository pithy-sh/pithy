// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultTheme } from "../templates/theme";
import { type EmailWorkerWranglerTemplate, resolveEmailConfig } from "./resolveEmailConfig";

const template: EmailWorkerWranglerTemplate = {
  name: "pithy-email",
  main: "./worker.ts",
  compatibility_date: "2025-01-01",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  d1_databases: [
    { binding: "DB", database_name: "pithy-app", database_id: "<filled>" },
    { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "<filled>" },
    { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled>" },
  ],
  send_email: [{ name: "EMAIL", remote: true }],
  secrets_store_secrets: [
    { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled>", secret_name: "SECRETS_ENCRYPTION_KEYS" },
  ],
  workflows: [
    { binding: "EMAIL_SENDER", name: "pithy-email-send", class_name: "EmailSendWorkflow" },
    { binding: "EMAIL_SCHEDULER", name: "pithy-email-schedule", class_name: "EmailSchedulerWorkflow" },
  ],
  triggers: { crons: ["* * * * *"] },
  vars: { APP_NAME: "Pithy", BASE_URL: "<filled>", ENVIRONMENT: "<filled>" },
};

describe("resolveEmailConfig", () => {
  test("fills per-env name, the three D1 ids, the env-prefixed master key, workflow names, and vars", () => {
    const config = resolveEmailConfig(template, {
      env: "staging",
      appDatabaseId: "app-123",
      suppressionDatabaseId: "sup-456",
      secretsDatabaseId: "sec-789",
      storeId: "store-abc",
      baseUrl: "https://api.staging.example.com",
      theme: { ...defaultTheme, appName: "Acme" },
    });

    expect(config.name).toBe("pithy-email-staging");
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-123" },
      { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "sup-456" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "sec-789" },
    ]);
    expect(config.secrets_store_secrets[0]).toEqual({
      binding: "SECRETS_ENCRYPTION_KEYS",
      store_id: "store-abc",
      secret_name: "STAGING_SECRETS_ENCRYPTION_KEYS",
    });
    expect(config.workflows.map((w) => w.name)).toEqual(["pithy-email-send-staging", "pithy-email-schedule-staging"]);
    expect(config.vars).toMatchObject({ BASE_URL: "https://api.staging.example.com", ENVIRONMENT: "staging" });
    // Static fields pass through untouched.
    expect(config.triggers.crons).toEqual(["* * * * *"]);
    expect(config.send_email).toEqual([{ name: "EMAIL", remote: true }]);
  });

  test("does not mutate the input template", () => {
    resolveEmailConfig(template, {
      env: "production",
      appDatabaseId: "a",
      suppressionDatabaseId: "s",
      secretsDatabaseId: "x",
      storeId: "st",
      baseUrl: "u",
      theme: defaultTheme,
    });
    expect(template.name).toBe("pithy-email");
    expect(template.d1_databases[0]?.database_id).toBe("<filled>");
  });
});
