// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
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
  test("fills the scoped name, the three D1 ids, the master key, workflow names, and vars", () => {
    const config = resolveEmailConfig(template, {
      project: "acme",
      env: "staging",
      appDatabaseId: "app-123",
      suppressionDatabaseId: "sup-456",
      secretsDatabaseId: "sec-789",
      storeId: "store-abc",
      baseUrl: "https://api.staging.example.com",
      theme: { ...defaultTheme, appName: "Acme" },
    });

    expect(config.name).toBe("acme-staging-email");
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-123" },
      // Rewritten: the suppression database is email's own, and its name now carries the project.
      // `pithy-app` and `pithy-secrets` are owned elsewhere and pass through untouched.
      { binding: "EMAIL_SUPPRESSIONS", database_name: "acme-global-email-suppressions", database_id: "sup-456" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "sec-789" },
    ]);
    expect(config.secrets_store_secrets[0]).toEqual({
      binding: "SECRETS_ENCRYPTION_KEYS",
      store_id: "store-abc",
      // Through the secrets package's own function: it owns that naming, and a literal here would be a
      // second declaration free to drift from the value actually written.
      secret_name: masterKeySecretName("acme", "staging"),
    });
    expect(config.workflows.map((w) => w.name)).toEqual(["acme-staging-email-send", "acme-staging-email-schedule"]);
    expect(config.vars).toMatchObject({ BASE_URL: "https://api.staging.example.com", ENVIRONMENT: "staging" });
    // Static fields pass through untouched.
    expect(config.triggers.crons).toEqual(["* * * * *"]);
    expect(config.send_email).toEqual([{ name: "EMAIL", remote: true }]);
  });

  test("a second project resolves to entirely different worker and Workflow names", () => {
    const config = resolveEmailConfig(template, {
      project: "globex",
      env: "staging",
      appDatabaseId: "app-123",
      suppressionDatabaseId: "sup-456",
      secretsDatabaseId: "sec-789",
      storeId: "store-abc",
      baseUrl: "https://api.staging.example.com",
      theme: defaultTheme,
    });
    expect(config.name).toBe("globex-staging-email");
    expect(config.workflows.map((w) => w.name)).toEqual(["globex-staging-email-send", "globex-staging-email-schedule"]);
  });

  test("does not mutate the input template", () => {
    resolveEmailConfig(template, {
      project: "acme",
      env: "prod",
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
