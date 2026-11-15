// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type Capability, defineCapability } from "../capability/capability";
import type { MessageCatalog } from "./catalog";
import { composedTranslator } from "./composed";

const ES: MessageCatalog = { "payments/purge.retained": "Se conservan." };
const EN: MessageCatalog = { "payments/purge.retained": "Kept." };

/** An i18n capability as `@pithy-sh/i18n` publishes it: `layersFor` and its resolved config. */
function i18nLike(
  defaultLocale = "en",
  supportedLocales: readonly string[] = ["en", "es"],
  exceptions: Record<string, string> = {},
): Capability {
  const layers: Record<string, MessageCatalog> = { es: ES, en: EN };
  return Object.assign(defineCapability({ name: "i18n", requiredBindings: [] }), {
    i18nConfig: { defaultLocale, supportedLocales, exceptions },
    layersFor: (locale: string) => [layers[locale], layers[defaultLocale]],
  });
}

describe("composedTranslator", () => {
  test("translates in the locale it is asked for, through the composed i18n layers", () => {
    const t = composedTranslator([i18nLike()], "es");
    expect(t?.catalogLocale).toBe("es");
    expect(t?.maybe("payments/purge.retained")).toBe("Se conservan.");
  });

  test("falls back the way every catalog lookup does: a locale with no entry reads the project default", () => {
    expect(composedTranslator([i18nLike()], "fr")?.maybe("payments/purge.retained")).toBe("Kept.");
  });

  test("a person who never chose a locale reads the project default", () => {
    const t = composedTranslator([i18nLike("es")], null);
    expect(t?.catalogLocale).toBe("es");
    expect(t?.maybe("payments/purge.retained")).toBe("Se conservan.");
  });

  test("a stored tag that is not a locale reads the project default rather than reaching `Intl`", () => {
    expect(composedTranslator([i18nLike()], "en-x")?.catalogLocale).toBe("en");
  });

  test("a regional tag reads the supported language it narrows, as the request path resolves it", () => {
    const t = composedTranslator([i18nLike()], "es-MX");
    expect(t?.catalogLocale).toBe("es");
    expect(t?.maybe("payments/purge.retained")).toBe("Se conservan.");
  });

  test("a declared exception maps a stored tag onto the supported locale it means", () => {
    expect(composedTranslator([i18nLike("en", ["en", "es"], { ca: "es" })], "ca")?.catalogLocale).toBe("es");
  });

  test("a locale the project does not offer reads the project default, never a kit catalog it does not serve", () => {
    const t = composedTranslator([i18nLike("en", ["en"])], "es");
    expect(t?.catalogLocale).toBe("en");
    expect(t?.maybe("payments/purge.retained")).toBe("Kept.");
  });

  test("a key no layer holds answers null, so the caller's own fallback stands", () => {
    expect(composedTranslator([i18nLike()], "es")?.maybe("payments/purge.unknown")).toBeNull();
  });

  test("with no i18n capability composed there is nothing to translate through", () => {
    expect(composedTranslator([defineCapability({ name: "turnstile", requiredBindings: [] })], "es")).toBeNull();
  });

  test("a capability merely named i18n, publishing no layers, is not taken for one", () => {
    expect(composedTranslator([defineCapability({ name: "i18n", requiredBindings: [] })], "es")).toBeNull();
  });
});
