// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { email } from "@pithy-sh/email/src/capability";
import { type EmailWorkerWranglerTemplate, resolveEmailConfig } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { renderEmail } from "@pithy-sh/email/src/templates/engine";
import { catalogLayers, catalogsFromEnv, emailTranslator } from "@pithy-sh/email/src/templates/messages";
import { defaultTheme } from "@pithy-sh/email/src/templates/theme";
import { i18n } from "@pithy-sh/i18n/src/capability";
import { describe, expect, test } from "vitest";

/**
 * **A project that speaks two languages, from `pithy.config.ts` to the mail that arrives.**
 *
 * This test exists because the combination it drives existed nowhere in the monorepo, and that absence
 * was the defect rather than a symptom of it (pithy-sh/pithy#441). Two things had no coverage at all:
 *
 *   - `@pithy-sh/email`'s `compose` hook, which adopts a composed `i18n` capability's `layersFor` — the
 *     entire mechanism by which an app worker's enqueue renders a subject in a language the kit does
 *     not write.
 *   - The catalog vars, which `workflows/hostEnv.ts` documents as something `pithy email
 *     provision` writes, which `workflows/worker.ts` reads, and which **no provisioner wrote**. The
 *     send Workflow rendered the kit's English whatever tag was on the row — and because `runSend`
 *     re-renders the subject, it discarded the translated one the app worker had computed at enqueue
 *     as well. Two Workers, one message, and they disagreed about its language.
 *
 * It lives in the CLI because the CLI is the one package that already depends on both, and because the
 * CLI is where a project is actually assembled: `pithy email provision` composes the adopter's
 * capabilities, reads `hostCatalogs()` off the email one, and hands it to `resolveEmailConfig`.
 */

/** The composed English + kit Spanish sentence for `welcome`, as `@pithy-sh/i18n` ships it. */
const KIT_ES_WELCOME_SUBJECT = "Te damos la bienvenida a {app}";

/** The committed template's shape, reduced to what this resolution needs. */
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
  vars: { BASE_URL: "<filled>", ENVIRONMENT: "<filled>" },
};

const resolveParams = {
  project: "acme",
  env: "prod" as const,
  appDatabaseId: "app-1",
  suppressionDatabaseId: "sup-1",
  secretsDatabaseId: "sec-1",
  storeId: "store-1",
  baseUrl: "https://api.acme.test",
  theme: { ...defaultTheme, appName: "Acme" },
};

/**
 * Assemble a project the way `createBackend` does at Worker startup
 * (`@pithy-sh/core/src/createBackend.ts` — every hook, in composition order), which is also what
 * `pithy email provision` now does before it reads the catalogs off the email capability.
 */
function compose(...capabilities: Capability[]): void {
  for (const capability of capabilities) capability.compose?.({ capabilities });
}

function emailCapability() {
  return email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
}

describe("a project composing i18n() alongside email()", () => {
  test("the host worker is deployed carrying the words it will render in", () => {
    const mail = emailCapability();
    compose(i18n({ supportedLocales: ["en", "es"] }), mail);

    const config = resolveEmailConfig(template, { ...resolveParams, messages: mail.hostCatalogs() });
    const stamped = config.vars.EMAIL_MESSAGES_ES;
    expect(stamped).toBeDefined();

    // Collected through the seam the host itself reads them with — a value this test can read and the
    // host cannot is not a value that was delivered.
    expect(stamped).toBeDefined();
    const carried = catalogsFromEnv(config.vars);
    expect(carried.es?.["email/welcome.subject"]).toBe(KIT_ES_WELCOME_SUBJECT);
    // Only this capability's domain travels. A screen's copy or an error's translation in this var is
    // weight against a hard 5 KB ceiling for a key no template will ever ask for.
    expect(Object.keys(carried.es ?? {}).every((key) => key.startsWith("email/"))).toBe(true);
    // And nothing that merely repeats the English the host already bundles.
    expect(carried.en).toBeUndefined();
  });

  test("and rendering through them is what a Spanish reader actually receives", async () => {
    const mail = emailCapability();
    compose(i18n({ supportedLocales: ["en", "es"] }), mail);
    const config = resolveEmailConfig(template, { ...resolveParams, messages: mail.hostCatalogs() });

    // Exactly what `workflows/worker.ts` does with the var, and then exactly what `runSend` does with
    // the result: `catalogLayers(...)` into `emailTranslator(job.locale, ...)` into `renderEmail`.
    const layers = catalogLayers(catalogsFromEnv(config.vars));
    const rendered = await renderEmail(
      "welcome",
      { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Empezar" },
      resolveParams.theme,
      undefined,
      emailTranslator("es", layers),
    );

    expect(rendered.subject).toBe("Te damos la bienvenida a Acme");
    expect(rendered.html).toContain('lang="es"');
    expect(rendered.html).not.toContain("Welcome to Acme");
  });

  test("an adopter's own sentence wins over the kit's translation of it", () => {
    const mail = emailCapability();
    compose(
      i18n({
        supportedLocales: ["en", "es"],
        messages: { es: { "email/welcome.subject": "Hola, {app}" } },
      }),
      mail,
    );

    const carried = mail.hostCatalogs();
    // Per key, not per catalog: the one sentence they wrote is theirs and every other key still
    // arrives from the package.
    expect(carried.es?.["email/welcome.subject"]).toBe("Hola, {app}");
    expect(carried.es?.["email/welcome.heading"]).toBe("Te damos la bienvenida a {app}");
  });

  test("a project that composes no i18n capability deploys no var at all", () => {
    const mail = emailCapability();
    compose(mail);
    expect(mail.hostCatalogs()).toEqual({});
    const config = resolveEmailConfig(template, { ...resolveParams, messages: mail.hostCatalogs() });
    // Absent is how the host's env schema spells "the English I bundle", which is what a project
    // serving one language wants and gets.
    expect(catalogsFromEnv(config.vars)).toEqual({});
  });
});
