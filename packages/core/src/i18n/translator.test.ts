// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { bakedTranslator, createTranslator } from "./translator";

const EN = {
  "auth/sign_in.title": "Welcome.",
  "auth/sign_in.inbox": "We sent {n} digits to {email}.",
  "auth/sign_in.tries.one": "{count} try left.",
  "auth/sign_in.tries.other": "{count} tries left.",
};

const ES = {
  "auth/sign_in.title": "Bienvenido.",
  "auth/sign_in.tries.one": "Queda {count} intento.",
  "auth/sign_in.tries.other": "Quedan {count} intentos.",
};

describe("bakedTranslator", () => {
  test("is the seam's behavior with no i18n capability composed", () => {
    const t = bakedTranslator(EN);
    expect(t.catalogLocale).toBe("en");
    expect(t.formattingLocale).toBe("en");
    expect(t.direction).toBe("ltr");
    expect(t.t("auth/sign_in.title")).toBe("Welcome.");
  });

  test("a key nothing has renders as the key, which is the honest answer", () => {
    expect(bakedTranslator(EN).t("auth/sign_in.absent")).toBe("auth/sign_in.absent");
  });
});

describe("createTranslator", () => {
  test("walks layers per key, so an untranslated key falls through to English", () => {
    const t = createTranslator({ catalogLocale: "es", layers: [ES, EN] });
    expect(t.t("auth/sign_in.title")).toBe("Bienvenido.");
    expect(t.t("auth/sign_in.inbox", { n: 6, email: "a@b.c" })).toBe("We sent 6 digits to a@b.c.");
  });

  test("the catalog locale falls back and the formatting locale does not", () => {
    // An `es-AR` reader reads the `es` catalog and sees `es-AR` numbers. Collapsing the two is the bug
    // where an Argentine reads Spanish and sees `1,234.56`.
    const t = createTranslator({ catalogLocale: "es", formattingLocale: "es-AR", layers: [ES, EN] });
    expect(t.t("auth/sign_in.title")).toBe("Bienvenido.");
    expect(t.formatNumber(1234.5)).toBe("1.234,5");
    expect(t.catalogLocale).toBe("es");
    expect(t.formattingLocale).toBe("es-AR");
  });

  test("formatting locale defaults to the catalog locale", () => {
    expect(createTranslator({ catalogLocale: "es", layers: [ES] }).formattingLocale).toBe("es");
  });

  test("direction follows the catalog locale", () => {
    expect(createTranslator({ catalogLocale: "ar", layers: [{}] }).direction).toBe("rtl");
  });
});

describe("maybe", () => {
  test("answers null on a miss, which is what `t` cannot do", () => {
    const t = bakedTranslator(EN);
    expect(t.maybe("auth/sign_in.title")).toBe("Welcome.");
    expect(t.maybe("auth/sign_in.absent")).toBeNull();
    // The distinction the error path is built on: `t` is total, so its miss is a string.
    expect(t.t("auth/sign_in.absent")).toBe("auth/sign_in.absent");
  });

  test("the documented client contract falls back to the English the server sent", () => {
    // `t.maybe(payload.code, payload.params) ?? payload.message`. Written against `t` instead, this
    // renders `auth/invalid_token` on a caller's screen for every code a locale does not cover.
    const es = createTranslator({ catalogLocale: "es", layers: [{ "auth/invalid_token": "Sesión no válida." }] });
    const covered = { code: "auth/invalid_token", message: "Your session is not valid." };
    const uncovered = { code: "core/not_found", message: "The requested resource does not exist." };
    expect(es.maybe(covered.code) ?? covered.message).toBe("Sesión no válida.");
    expect(es.maybe(uncovered.code) ?? uncovered.message).toBe("The requested resource does not exist.");
  });

  test("interpolates like `t` when it does answer", () => {
    expect(bakedTranslator(EN).maybe("auth/sign_in.inbox", { n: 6, email: "a@b.c" })).toBe(
      "We sent 6 digits to a@b.c.",
    );
  });

  test("an empty string is an answer, not a miss", () => {
    expect(bakedTranslator({ "a/b": "" }).maybe("a/b")).toBe("");
  });
});

describe("plural", () => {
  test("selects the form the count calls for, in the catalog's locale", () => {
    const en = createTranslator({ catalogLocale: "en", layers: [EN] });
    expect(en.plural("auth/sign_in.tries", 1)).toBe("1 try left.");
    expect(en.plural("auth/sign_in.tries", 3)).toBe("3 tries left.");
  });

  test("the second locale is what exposes a concatenated string", () => {
    const es = createTranslator({ catalogLocale: "es", layers: [ES, EN] });
    expect(es.plural("auth/sign_in.tries", 1)).toBe("Queda 1 intento.");
    expect(es.plural("auth/sign_in.tries", 3)).toBe("Quedan 3 intentos.");
  });

  test("count is available as {count} without being passed twice, and params still reach it", () => {
    const t = createTranslator({ catalogLocale: "en", layers: [{ "a/b.other": "{count} of {total}" }] });
    expect(t.plural("a/b", 2, { total: 9 })).toBe("2 of 9");
  });

  test("falls back to the `other` form when a category has no entry", () => {
    const t = createTranslator({ catalogLocale: "en", layers: [{ "a/b.other": "{count} items" }] });
    expect(t.plural("a/b", 1)).toBe("1 items");
  });

  test("a key with no forms at all renders as the key", () => {
    expect(bakedTranslator({}).plural("a/b", 1)).toBe("a/b");
  });
});

describe("Intl formatting", () => {
  // workerd embeds full ICU, so none of this needs a polyfill, `@formatjs/*`, or CLDR JSON.
  const es = createTranslator({ catalogLocale: "es", formattingLocale: "es-ES", layers: [ES] });

  test("numbers, currency and lists follow the formatting locale", () => {
    expect(es.formatNumber(1234567.891)).toBe("1.234.567,891");
    expect(es.formatCurrency(1234567.891, "EUR")).toBe("1.234.567,89\u00a0€");
    expect(es.formatList(["a", "b", "c"])).toBe("a, b y c");
  });

  test("dates take a Date or an epoch, and relative time reads as prose", () => {
    const day = Date.UTC(2026, 5, 1);
    expect(es.formatDate(day, { dateStyle: "long", timeZone: "UTC" })).toBe("1 de junio de 2026");
    expect(es.formatDate(new Date(day), { dateStyle: "long", timeZone: "UTC" })).toBe("1 de junio de 2026");
    expect(es.formatRelativeTime(-1, "day", { numeric: "auto" })).toBe("ayer");
  });
});
