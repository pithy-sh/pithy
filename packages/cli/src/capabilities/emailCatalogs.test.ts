// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { email } from "@pithy-sh/email/src/capability";
import { type EmailWorkerWranglerTemplate, resolveEmailConfig } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { renderEmail } from "@pithy-sh/email/src/templates/engine";
import {
  catalogLayers,
  catalogsFromEnv,
  EMAIL_MESSAGES,
  emailTranslator,
} from "@pithy-sh/email/src/templates/messages";
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
const OVERRIDDEN = "Hola y bienvenido a {app}";

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
  test("the host worker is deployed carrying the words the adopter changed", () => {
    // **Only the diff, since #442.** The kit's own Spanish is bundled into the host, so what a
    // provision run has to carry is what this project said differently — and a project that said
    // nothing differently carries nothing at all, which the next case pins.
    const mail = emailCapability();
    compose(i18n({ supportedLocales: ["en", "es"], messages: { es: { "email/welcome.subject": OVERRIDDEN } } }), mail);

    const config = resolveEmailConfig(template, { ...resolveParams, messages: mail.hostCatalogs() });
    const stamped = config.vars.EMAIL_MESSAGES_ES;
    expect(stamped).toBeDefined();

    // Collected through the seam the host itself reads them with — a value this test can read and the
    // host cannot is not a value that was delivered.
    const carried = catalogsFromEnv(config.vars);
    expect(carried.es).toEqual({ "email/welcome.subject": OVERRIDDEN });
    // Only this capability's domain travels. A screen's copy or an error's translation in this var is
    // weight against a hard 5 KB ceiling for a key no template will ever ask for.
    expect(Object.keys(carried.es ?? {}).every((key) => key.startsWith("email/"))).toBe(true);
    // And nothing that merely repeats what the host already bundles, in English or in Spanish.
    expect(carried.en).toBeUndefined();
  });

  test("and a project that changed nothing deploys no catalog variable at all", () => {
    const mail = emailCapability();
    compose(i18n({ supportedLocales: ["en", "es"] }), mail);
    const config = resolveEmailConfig(template, { ...resolveParams, messages: mail.hostCatalogs() });
    expect(catalogsFromEnv(config.vars)).toEqual({});
  });

  test("and rendering through them is what a Spanish reader actually receives", async () => {
    const mail = emailCapability();
    compose(i18n({ supportedLocales: ["en", "es"] }), mail);
    const config = resolveEmailConfig(template, { ...resolveParams, messages: mail.hostCatalogs() });

    // The var is empty here, and the render is still Spanish — which is the property. The host is
    // built with the kit's words, so `catalogLayers` finds them in `EMAIL_MESSAGES` rather than in
    // anything a provision run sent.
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

    // **Per key, not per catalog — and since #442 that is visible in two places rather than one.**
    //
    // What *travels* is the one sentence they wrote: every other key is already in the host's bundle,
    // so sending it back would be sending the Worker words it was built with.
    const carried = mail.hostCatalogs();
    expect(carried.es).toEqual({ "email/welcome.subject": "Hola, {app}" });

    // What the host *renders* is still the whole catalog — their sentence over the kit's, and the kit's
    // for everything they did not mention. That is the property the adopter actually feels, and it is
    // asserted through the same layer walk `runSend` uses.
    const layers = catalogLayers(carried);
    const t = emailTranslator("es", layers);
    expect(t.t("email/welcome.subject")).toBe("Hola, {app}");
    expect(t.t("email/welcome.heading")).toBe(EMAIL_MESSAGES.es?.["email/welcome.heading"]);
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
