// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { email } from "@pithy-sh/email/src/capability";
import { type EmailWorkerWranglerTemplate, resolveEmailConfig } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { defaultTheme } from "@pithy-sh/email/src/templates/theme";
import { parse } from "comment-json";
import { describe, expect, test } from "vitest";
import { emailWorkerDir } from "./emailProvisioner";

/**
 * The committed `wrangler.jsonc` template is deployment configuration nobody type-checks: `parse()`
 * hands back `unknown` and the provisioner casts it. Email's own resolver test uses an inline fixture,
 * which has already drifted from the real file — so before this suite, an edit to the template that
 * left a placeholder unresolved reached production untouched by CI.
 *
 * This reads the same file `deployWorker` reads, through the same resolution, and asserts the property
 * that actually matters: after resolution nothing is left to fill in.
 */

/** The marker the committed template uses for every value provisioning supplies. */
const PLACEHOLDER = "<filled-at-provision>";

/** Read and parse the real committed template, exactly as `CloudflareEmailProvisioner.deployWorker` does. */
async function readTemplate(): Promise<EmailWorkerWranglerTemplate> {
  const source = await readFile(join(emailWorkerDir(), "wrangler.jsonc"), "utf8");
  return parse(source) as unknown as EmailWorkerWranglerTemplate;
}

const params = {
  appDatabaseId: "app-123",
  suppressionDatabaseId: "sup-456",
  secretsDatabaseId: "sec-789",
  storeId: "store-abc",
  baseUrl: "https://api.staging.example.com",
  theme: defaultTheme,
} as const;

describe("the committed email worker template", () => {
  test("still marks every provisioned value, so the resolution below is a real one", async () => {
    const template = await readTemplate();
    expect(JSON.stringify(template)).toContain(PLACEHOLDER);
  });

  test("resolves with no placeholder left, in every managed environment", async () => {
    const template = await readTemplate();
    for (const env of ["staging", "production"] as const) {
      const config = resolveEmailConfig(template, { ...params, env });
      expect(JSON.stringify(config)).not.toContain(PLACEHOLDER);
      expect(config.name).toBe(`pithy-email-${env}`);
    }
  });

  test("fills the three database ids, the store id, and the env-scoped master key", async () => {
    const config = resolveEmailConfig(await readTemplate(), { ...params, env: "staging" });
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-123" },
      { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "sup-456" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "sec-789" },
    ]);
    expect(config.secrets_store_secrets).toEqual([
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "store-abc",
        secret_name: "STAGING_SECRETS_ENCRYPTION_KEYS",
      },
    ]);
  });

  test("keeps the static fields the template owns", async () => {
    const config = resolveEmailConfig(await readTemplate(), { ...params, env: "production" });
    expect(config.triggers.crons).toEqual(["* * * * *"]);
    expect(config.send_email).toEqual([{ name: "EMAIL", remote: true }]);
    expect(config.workers_dev).toBe(false);
    expect(config.vars).toMatchObject({ LINK_TTL_DAYS: "90", MAX_ATTEMPTS: "5", SCHEDULER_ENABLED: "true" });
  });

  test("its workflows are exactly the capability's specs, under the names the seam derives", async () => {
    const template = await readTemplate();
    const specs = email({ fromAddress: "noreply@pithy.sh", baseUrl: "https://api.example.com" }).workflows ?? {};

    // Same jobs, same bindings, same classes — the template and the specs are one declaration or they
    // are two that will disagree.
    expect(
      template.workflows.map((workflow) => ({ binding: workflow.binding, class_name: workflow.class_name })),
    ).toEqual(Object.values(specs).map((spec) => ({ binding: spec.binding, class_name: spec.className })));

    // And the deployed names the resolver produces are the ones `workflowScriptName` computes from the
    // job keys — the guarantee that formalizing the convention renamed nothing.
    const config = resolveEmailConfig(template, { ...params, env: "staging" });
    expect(config.workflows.map((workflow) => workflow.name)).toEqual(
      Object.keys(specs).map((job) => workflowScriptName("email", job, "staging")),
    );
    expect(config.workflows.map((workflow) => workflow.name)).toEqual([
      "pithy-email-send-staging",
      "pithy-email-schedule-staging",
    ]);
  });

  test("only the send binding is bound on an app worker, so the scheduler spec is optional", () => {
    const specs = email({ fromAddress: "noreply@pithy.sh", baseUrl: "https://api.example.com" }).workflows ?? {};
    // `pithy add email` wires EMAIL_SENDER into the app's wrangler and nothing else — EMAIL_SCHEDULER
    // exists only on the prebuilt host, which self-fires it. A required spec would derive a binding
    // every app is missing, and `validateBindings` would 500 the first request.
    expect(specs.send?.optional).toBeUndefined();
    expect(specs.schedule?.optional).toBe(true);
  });

  test("the cron the template declares is the one the scheduler spec carries", async () => {
    const template = await readTemplate();
    const specs = email({ fromAddress: "noreply@pithy.sh", baseUrl: "https://api.example.com" }).workflows ?? {};
    const schedules = Object.values(specs).flatMap((spec) => (spec.schedule ? [spec.schedule] : []));
    expect(template.triggers.crons).toEqual(schedules);
  });
});
