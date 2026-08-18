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
  send_email: [{ name: "EMAIL" }],
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
    // Not static: the resolver decides `remote`, because the template cannot un-decide it. Real mail
    // is the default, and a deployed environment ignores the flag anyway.
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

/**
 * Real delivery is the default, and the simulator is the deliberate choice (pithy-sh/pithy#410).
 *
 * The template used to carry `"remote": true` itself, which read as a decision and was in fact a
 * dead end: `resolveWorkflowHost` only ever *adds* the flag, so nothing downstream could ever turn it
 * off. Moving it here is what makes a documented config flag possible at all.
 */
describe("how mail leaves the host under pithy dev", () => {
  const base = {
    project: "acme",
    appDatabaseId: "app-123",
    suppressionDatabaseId: "sup-456",
    secretsDatabaseId: "sec-789",
    storeId: "store-abc",
    baseUrl: "http://localhost:8787",
    theme: defaultTheme,
  };

  test("dev sends real mail by default — the local loop ends in an inbox", () => {
    const config = resolveEmailConfig(template, { ...base, env: "dev" });
    expect(config.send_email).toEqual([{ name: "EMAIL", remote: true }]);
  });

  test("the simulator is selectable, and then nothing leaves the machine", () => {
    const config = resolveEmailConfig(template, { ...base, env: "dev", devDelivery: "simulator" });
    // No `remote`, so `wrangler dev` logs the message and writes the rendered bodies to disk.
    expect(config.send_email).toEqual([{ name: "EMAIL" }]);
  });

  test("a deployed environment ignores the flag — its config is the same either way", () => {
    const remote = resolveEmailConfig(template, { ...base, env: "prod" });
    const simulated = resolveEmailConfig(template, { ...base, env: "prod", devDelivery: "simulator" });

    expect(remote.send_email).toEqual([{ name: "EMAIL", remote: true }]);
    expect(simulated).toEqual(remote);
  });
});
