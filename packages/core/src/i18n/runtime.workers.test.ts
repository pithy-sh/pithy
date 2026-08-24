// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { localeDirection } from "./locale";
import { createTranslator } from "./translator";

/**
 * The same properties as the node suite, asserted inside workerd — because the two runtimes genuinely
 * disagree about the API this seam is built on.
 *
 * `Intl.Locale.prototype.getTextInfo()` exists in workerd and Bun; the `textInfo` accessor exists in
 * Node 22, which is the declared floor and therefore the CLI. A direction helper written against
 * either name alone passes one of these files and fails the other, which is why both run.
 *
 * The formatting assertions are here for the second reason the design rests on: **workerd embeds full
 * ICU**, so Spanish grouping, currency, collation and relative time are correct with nothing bundled.
 * If that were ever untrue, this file is where it surfaces — not in an adopter's production Worker.
 */
describe("the i18n seam inside the Workers runtime", () => {
  test("text direction resolves through whichever accessor workerd exposes", () => {
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("he")).toBe("rtl");
    expect(localeDirection("es")).toBe("ltr");
    expect(localeDirection("en")).toBe("ltr");
  });

  test("full ICU is present, so no polyfill, `@formatjs/*` or CLDR JSON is bundled", () => {
    const es = createTranslator({ catalogLocale: "es", formattingLocale: "es-ES", layers: [{}] });
    expect(es.formatCurrency(1234567.891, "EUR")).toBe("1.234.567,89\u00a0€");
    expect(es.formatList(["a", "b", "c"])).toBe("a, b y c");
    expect(es.formatRelativeTime(-1, "day", { numeric: "auto" })).toBe("ayer");
  });

  test("plural categories come from ICU, not from a table we wrote", () => {
    const ru = createTranslator({
      catalogLocale: "ru",
      layers: [{ "a/b.one": "one", "a/b.few": "few", "a/b.many": "many", "a/b.other": "other" }],
    });
    expect(ru.plural("a/b", 1)).toBe("one");
    expect(ru.plural("a/b", 2)).toBe("few");
    expect(ru.plural("a/b", 5)).toBe("many");
  });

  test("collation is Spanish, so a sorted list reads the way a Spanish reader expects", () => {
    expect(["z", "a", "ñ", "n", "o"].sort(new Intl.Collator("es-ES").compare).join("")).toBe("anñoz");
  });
});
