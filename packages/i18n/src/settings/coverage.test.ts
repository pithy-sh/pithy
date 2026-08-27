// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SettingsCheckContext, SettingsFinding } from "@pithy-sh/core/src/capability/settings";
import type { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { describe, expect, test } from "vitest";
import { KIT_CATALOGS } from "../catalogs/kit";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { i18nSettings } from "./coverage";

/**
 * Catalog coverage, as `pithy doctor`'s local tier.
 *
 * The question it answers is one sentence long: **would a reader in a supported locale meet a sentence
 * nobody wrote?** Everything below is that question asked in the shapes it actually arrives in — a
 * locale a project declared and never translated, a locale it translated and then extended, and the
 * default locale, which cannot be missing anything because it is what "missing" is measured against.
 */

const config = (input: I18nConfigInput = {}): I18nConfig => I18nConfig.parse(input);

/** What the runner tells a local check. This one reads none of it, and asserting so is part of the point. */
const CONTEXT: SettingsCheckContext = {
  project: "acme",
  worker: "api",
  environments: [{ name: "dev", origin: null }],
};

/** The findings `i18nSettings` reports for one config and one set of composed capability messages. */
function findings(resolved: I18nConfig, composed: LocaleCatalogs = {}): SettingsFinding[] {
  const local = i18nSettings(resolved, () => composed).local(CONTEXT);
  // The local tier is declared sync-or-async on the seam; this one is sync, and a check that quietly
  // became a promise would report a `Promise` object as zero findings.
  expect(Array.isArray(local)).toBe(true);
  return local as SettingsFinding[];
}

/** English keys a couple of composed capabilities contributed — the baseline every locale is measured against. */
const COMPOSED_EN: LocaleCatalogs = {
  en: {
    "app/greeting": "Hello.",
    "app/farewell": "Goodbye.",
    "app/nav.settings": "Settings",
  },
};

describe("a covered project reports nothing", () => {
  test("a monolingual project has nothing to be missing", () => {
    expect(findings(config(), COMPOSED_EN)).toEqual([]);
  });

  test("every supported locale covered by the adopter's own catalog is silent", () => {
    const resolved = config({
      supportedLocales: ["en", "es"],
      messages: {
        es: { "app/greeting": "Hola.", "app/farewell": "Adios.", "app/nav.settings": "Ajustes" },
      },
    });
    expect(findings(resolved, COMPOSED_EN)).toEqual([]);
  });

  test("a capability's own translation counts as coverage too", () => {
    // Coverage is the union of the adopter's catalogs, the kit's translations and every composed
    // capability's own — a reader does not care which layer answered, only that one did. This case is
    // the third of those three arms; the kit's own is exercised further down, against a real kit key.
    const composed: LocaleCatalogs = {
      ...COMPOSED_EN,
      es: { "app/greeting": "Hola.", "app/farewell": "Adios.", "app/nav.settings": "Ajustes" },
    };
    expect(findings(config({ supportedLocales: ["en", "es"] }), composed)).toEqual([]);
  });
});

describe("an uncovered locale is one finding, and it says which keys", () => {
  const resolved = config({
    supportedLocales: ["en", "es"],
    messages: { es: { "app/greeting": "Hola." } },
  });
  const [finding, ...rest] = findings(resolved, COMPOSED_EN);

  test("exactly one finding, for the locale that is short", () => {
    expect(rest).toEqual([]);
    expect(finding?.setting).toBe("i18n.supportedLocales.es");
  });

  test("the problem names the locale and what the reader meets instead", () => {
    expect(finding?.problem).toContain("`es`");
    expect(finding?.problem).toContain("en instead");
    expect(finding?.problem).toContain("2 messages");
  });

  test("the action names the missing keys, so it can be acted on without a second command", () => {
    expect(finding?.action).toContain("app/farewell");
    expect(finding?.action).toContain("app/nav.settings");
    // And not the one that is already translated.
    expect(finding?.action).not.toContain("app/greeting");
  });

  test("the action names the config key an adopter would edit", () => {
    // A finding nobody can act on is a complaint. This one names the exact call and the exact file.
    expect(finding?.action).toContain("i18n({ messages: { es: … } })");
    expect(finding?.action).toContain("pithy.config.ts");
  });

  test("the finding is not scoped to an environment, because language is not per-environment", () => {
    expect(finding?.environment).toBeNull();
  });

  test("one missing message is singular", () => {
    const nearlyCovered = config({
      supportedLocales: ["en", "es"],
      messages: { es: { "app/greeting": "Hola.", "app/farewell": "Adios." } },
    });
    expect(findings(nearlyCovered, COMPOSED_EN)[0]?.problem).toContain("1 message has no `es` translation");
  });
});

describe("the default locale is never reported against itself", () => {
  test("the default is skipped even when it is not `en`", () => {
    // The baseline *is* the default locale's key set, so a default reported against itself would be a
    // finding that no edit could ever clear.
    const spanishDefault = config({ supportedLocales: ["en", "es"], defaultLocale: "es" });
    const composed: LocaleCatalogs = { es: { "app/greeting": "Hola." } };
    const reported = findings(spanishDefault, composed);
    expect(reported.map((one) => one.setting)).toEqual(["i18n.supportedLocales.en"]);
  });

  test("with only the default supported, there is nothing to report at all", () => {
    expect(findings(config({ supportedLocales: ["en"] }), COMPOSED_EN)).toEqual([]);
  });

  test("each short locale gets its own finding", () => {
    const three = config({ supportedLocales: ["en", "es", "fr"] });
    expect(findings(three, COMPOSED_EN).map((one) => one.setting)).toEqual([
      "i18n.supportedLocales.es",
      "i18n.supportedLocales.fr",
    ]);
  });
});

describe("the kit's own translation counts as coverage", () => {
  /**
   * A sentence the kit ships Spanish for, and one it does not.
   *
   * **The arm this describe block exists for was untested until #441's verification pass**, and the
   * reason it survived is worth stating: every other case in this file uses `app/*` keys, and `app/*`
   * is the adopter's own domain — a key that is never in a kit catalog by construction. So deleting
   * `KIT_CATALOGS[locale]` from the union passed all thirteen of them, while
   * pithy.sh/docs/build/language-and-locale/serve-a-second-language documents the arm and the whole
   * "adopt a locale for free" story rests on it. (It was a line number in this package's README until
   * #459 shrank that to a pointer; a line number is the citation that rots on the next edit.)
   */
  const KIT_KEY = "auth/sign_in.title";
  const MINE = "app/greeting";

  test("the fixture is real — the kit really does ship Spanish for that key", () => {
    // Otherwise the two cases below are a comparison against a key nobody wrote, and both would pass
    // over a gutted `KIT_CATALOGS`.
    expect(KIT_CATALOGS.es?.[KIT_KEY], "Pick another kit key: this one is no longer in the `es` catalog.").toBeTypeOf(
      "string",
    );
    expect(KIT_CATALOGS.es?.[MINE]).toBeUndefined();
  });

  test("a kit sentence the adopter never translated is not a finding", () => {
    // What composing `i18n({ supportedLocales: ["en", "es"] })` buys with no catalog of your own: every
    // sentence the kit wrote arrives in Spanish from the package.
    const composed: LocaleCatalogs = { en: { [KIT_KEY]: "Welcome." } };
    expect(findings(config({ supportedLocales: ["en", "es"] }), composed)).toEqual([]);
  });

  test("and the adopter's own sentence beside it still is", () => {
    // The other half, and what makes the case above mean something: the kit arm covers the kit's keys
    // and nothing else, so a finding still names exactly the sentence only the adopter can write.
    const composed: LocaleCatalogs = { en: { [KIT_KEY]: "Welcome.", [MINE]: "Hello." } };
    const [finding, ...rest] = findings(config({ supportedLocales: ["en", "es"] }), composed);
    expect(rest).toEqual([]);
    expect(finding?.problem).toContain("1 message has no `es` translation");
    expect(finding?.action).toContain(MINE);
    expect(finding?.action).not.toContain(KIT_KEY);
  });
});

describe("a long list stops counting out loud", () => {
  test("more than five missing keys names five and counts the rest", () => {
    const composed: LocaleCatalogs = {
      en: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`app/key_${index}`, `Message ${index}`])),
    };
    const [finding] = findings(config({ supportedLocales: ["en", "es"] }), composed);
    expect(finding?.problem).toContain("8 messages");
    expect(finding?.action).toContain("and 3 more");
    // Sorted, so the same gap reads the same way twice and a diff of two runs means something.
    expect(finding?.action).toContain("app/key_0, app/key_1, app/key_2, app/key_3, app/key_4, and 3 more");
  });
});
