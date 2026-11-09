// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { describe, expect, test } from "vitest";
import { catalogsFromEnv } from "../templates/messages";
import { defaultTheme } from "../templates/theme";
import {
  type EmailWorkerWranglerTemplate,
  emailWorkflowNames,
  MAX_WORKER_VAR_BYTES,
  resolveEmailConfig,
} from "./resolveEmailConfig";

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

  test("the link-signing key's binding is filled with this environment's entry", () => {
    const config = resolveEmailConfig(
      {
        ...template,
        secrets_store_secrets: [
          ...template.secrets_store_secrets,
          { binding: "EMAIL_LINK_SIGNING_KEY", store_id: "<filled>", secret_name: "<filled>" },
        ],
      },
      {
        project: "acme",
        env: "staging",
        appDatabaseId: "app-123",
        suppressionDatabaseId: "sup-456",
        secretsDatabaseId: "sec-789",
        storeId: "store-abc",
        baseUrl: "https://api.staging.example.com",
        theme: { ...defaultTheme, appName: "Acme" },
      },
    );

    // The entry keeps the registry key's name; only the binding is SCREAMING_SNAKE_CASE.
    expect(config.secrets_store_secrets[1]).toEqual({
      binding: "EMAIL_LINK_SIGNING_KEY",
      store_id: "store-abc",
      secret_name: "acme-staging-email-link-signing-key",
    });
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
 * Real delivery is the default, and the simulator is the deliberate choice.
 *
 * The template used to carry `"remote": true` itself, which read as a decision and was in fact a
 * dead end: `resolveWorkflowHost` only ever *adds* the flag, so nothing downstream could ever turn it
 * off. Moving it here is what makes a documented config flag possible at all.
 */
/**
 * **A feature gets its own email host, named and bound as the feature.** Worker and Workflow names are
 * account-wide and a Secrets Store is flat, so a host resolved with `env: "feature"` alone would be one host
 * every open branch deployed over, reading a master key no feature has. Handed the feature, every name is its own.
 */
describe("a Worker's own email host", () => {
  test("is named for its owner, Workflows and all, and reads the database it is handed", () => {
    const config = resolveEmailConfig(template, {
      project: "acme",
      env: "staging",
      owner: "two",
      appDatabaseId: "two-db",
      suppressionDatabaseId: "sup-456",
      secretsDatabaseId: "sec-789",
      storeId: "store-abc",
      baseUrl: "https://two.staging.example.com",
      theme: { ...defaultTheme, appName: "Two" },
      messages: { es: { "email/welcome.subject": "Hola de dos" } },
    });
    expect(config.name).toBe("acme-staging-two---email");
    expect(JSON.parse(config.vars.EMAIL_THEME as string).appName).toBe("Two");
    expect(JSON.stringify(config.vars)).toContain("Hola de dos");
    expect(config.workflows.map((workflow) => workflow.name)).toEqual([
      "acme-staging-two---email-send",
      "acme-staging-two---email-schedule",
    ]);
    expect(config.d1_databases[0]).toMatchObject({ binding: "DB", database_id: "two-db" });
    expect(config.vars.BASE_URL).toBe("https://two.staging.example.com");
  });
});

describe("a feature's email host", () => {
  const feature = { project: "acme", issue: "643", slug: "feature-address" };
  const config = resolveEmailConfig(
    {
      ...template,
      secrets_store_secrets: [
        ...template.secrets_store_secrets,
        { binding: "EMAIL_LINK_SIGNING_KEY", store_id: "<filled>", secret_name: "<filled>" },
      ],
    },
    {
      project: "acme",
      env: "feature",
      feature,
      appDatabaseId: "app-1",
      suppressionDatabaseId: "sup-1",
      secretsDatabaseId: "sec-1",
      storeId: "store-abc",
      baseUrl: "https://acme-f643-feature-address--board.acme.workers.dev",
      theme: defaultTheme,
    },
  );

  test("names the Worker and both Workflows for the feature, and says it is a feature", () => {
    expect(config.name).toBe("acme-f643-feature-address--email");
    expect(config.workflows?.map((entry) => entry.name).sort()).toEqual([
      "acme-f643-feature-address--email-schedule",
      "acme-f643-feature-address--email-send",
    ]);
    expect(config.vars?.ENVIRONMENT).toBe("feature");
  });

  test("binds the feature's own master key, link key and suppression list — never a declared environment's", () => {
    expect(config.secrets_store_secrets.map((entry) => entry.secret_name)).toEqual([
      "acme-f643-feature-address--secrets-encryption-keys",
      "acme-f643-feature-address--email-link-signing-key",
    ]);
    const suppressions = config.d1_databases.find((entry) => entry.binding === "EMAIL_SUPPRESSIONS");
    expect(suppressions?.database_name).toBe("acme-f643-feature-address--email-suppressions-d1");
    expect(suppressions?.database_id).toBe("sup-1");
  });
});

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

/**
 * The catalogs the host renders in — **the var, asserted on the provisioner's output**.
 *
 * `EMAIL_MESSAGES` is read by `workflows/worker.ts` and by `@pithy-sh/testers`'s enqueue seam, and this resolver is
 * its only writer: without it the send Workflow renders the kit's English whatever tag is on the row, and discards
 * the translated subject the app worker computed at enqueue when it re-renders.
 *
 * It asserts what the resolver *produced*, never that a constant exists. A test over `EMAIL_MESSAGES.en`
 * passes just as happily when nobody deploys it.
 */
describe("the words the host is deployed with", () => {
  const base = {
    project: "acme",
    env: "prod" as const,
    appDatabaseId: "app-123",
    suppressionDatabaseId: "sup-456",
    secretsDatabaseId: "sec-789",
    storeId: "store-abc",
    baseUrl: "https://api.example.com",
    theme: defaultTheme,
  };

  test("each locale is stamped into its own var, parseable by the seam the host reads it with", () => {
    const messages = {
      es: { "email/magic_link.subject": "Tu enlace de acceso" },
      fr: { "email/magic_link.subject": "Votre lien de connexion" },
    };
    const config = resolveEmailConfig(template, { ...base, messages });
    expect(config.vars.EMAIL_MESSAGES_ES).toBeDefined();
    expect(config.vars.EMAIL_MESSAGES_FR).toBeDefined();
    // And no mega pack: the thing that used to hold every locale at once is gone.
    expect(config.vars.EMAIL_MESSAGES).toBeUndefined();
    // Round-tripped through the seam the host actually collects them with, so a value this test can
    // read but the host cannot is not a value that was delivered.
    expect(catalogsFromEnv(config.vars)).toEqual(messages);
  });

  test("a regional tag becomes a legal var name, and comes back as the tag", () => {
    const messages = { "pt-BR": { "email/magic_link.subject": "Seu link de acesso" } };
    const config = resolveEmailConfig(template, { ...base, messages });
    expect(config.vars.EMAIL_MESSAGES_PT_BR).toBeDefined();
    expect(catalogsFromEnv(config.vars)).toEqual(messages);
  });

  test("a project with no catalogs gets no var, rather than an empty one", () => {
    // Absent is how the host spells "the English I bundle". `"{}"` in a deployed config reads like a
    // value somebody failed to fill.
    expect(catalogsFromEnv(resolveEmailConfig(template, base).vars)).toEqual({});
    expect(catalogsFromEnv(resolveEmailConfig(template, { ...base, messages: {} }).vars)).toEqual({});
    expect(catalogsFromEnv(resolveEmailConfig(template, { ...base, messages: { es: {} } }).vars)).toEqual({});
  });

  test("twenty languages deploy, because the ceiling is per pack and not per project", () => {
    // The shape this replaced held every locale in one var, so twenty 3 KB packs became one 62 KB
    // value and the project could not deploy a second language. Each pack is read on its own — the
    // host renders one email, in one locale — so each travels on its own.
    const messages: Record<string, Record<string, string>> = {};
    for (const tag of ["es", "fr", "de", "it", "pt", "nl", "pl", "tr", "ru", "uk"]) {
      const catalog: Record<string, string> = {};
      for (let i = 0; i < 50; i += 1) catalog[`email/key_${i}`] = "x".repeat(50);
      messages[tag] = catalog;
    }
    const config = resolveEmailConfig(template, { ...base, messages });
    expect(Object.keys(catalogsFromEnv(config.vars))).toHaveLength(10);
    for (const [name, value] of Object.entries(config.vars)) {
      if (!name.startsWith("EMAIL_MESSAGES_")) continue;
      expect(new TextEncoder().encode(value).length, name).toBeLessThanOrEqual(MAX_WORKER_VAR_BYTES);
    }
  });

  test("one language pack too large for a var is refused, naming that language", () => {
    // Cloudflare's ceiling is 5 KB per variable and the upload fails with error 10054 — an exit nobody
    // can act on, in the middle of a run that has already created databases. A silently shortened
    // catalog would be worse: a locale rendering half in Spanish and half in English, with nothing
    // anywhere saying so. Now that each pack travels alone, this guards the only thing left that can
    // trip it, and names the language to shorten.
    const filler = "a".repeat(200);
    const es: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) es[`email/overflow.key_${i}`] = filler;
    expect(() => resolveEmailConfig(template, { ...base, messages: { es } })).toThrow(
      /The `es` email catalog is \d+ bytes; a Cloudflare Worker variable holds 5120/,
    );
  });

  test("a pack that fits is not refused — the limit is a ceiling, not a ban on catalogs", () => {
    const es: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) es[`email/fits.key_${i}`] = "x".repeat(100);
    const config = resolveEmailConfig(template, { ...base, messages: { es } });
    expect(new TextEncoder().encode(config.vars.EMAIL_MESSAGES_ES ?? "").length).toBeLessThanOrEqual(
      MAX_WORKER_VAR_BYTES,
    );
  });
});

describe("what email teardown deletes, by the names provision used", () => {
  const resolved = resolveEmailConfig(template, {
    project: "acme",
    env: "staging",
    appDatabaseId: "app-123",
    suppressionDatabaseId: "sup-456",
    secretsDatabaseId: "sec-789",
    storeId: "store-1",
    baseUrl: "https://staging.example.com",
    theme: defaultTheme,
  });

  test("emailWorkflowNames is every Workflow the resolved host declares", () => {
    expect(emailWorkflowNames("acme", "staging")).toEqual(["acme-staging-email-send", "acme-staging-email-schedule"]);
    expect(emailWorkflowNames("acme", "staging")).toEqual(resolved.workflows.map((workflow) => workflow.name));
  });
});
