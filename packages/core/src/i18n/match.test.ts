// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { parseAcceptLanguage } from "./acceptLanguage";
import { matchLocale } from "./match";

const SHIPPING = ["en", "es"];

/**
 * The names every plain object inherits, read off `Object.prototype` rather than listed.
 *
 * Derived because the language owns this set, not this file: `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `__proto__` and the rest. Read through a bare index every one of them is truthy
 * and none is a string, which is how `?lang=constructor` became a 500 on every request inside a global
 * middleware. Deriving it also means the two files that assert this property cannot drift apart, and
 * neither has to export anything for the other.
 */
const INHERITED = Object.getOwnPropertyNames(Object.prototype);

/** The two together, as a resolver actually uses them. */
function negotiate(header: string, supported: readonly string[] = SHIPPING): string | null {
  const ranges = parseAcceptLanguage(header).map((entry) => entry.range);
  return matchLocale(ranges, supported)?.locale ?? null;
}

describe("matchLocale", () => {
  test("answers the weighted header the issue names", () => {
    expect(negotiate("pt-PT;q=1.0, es;q=0.8, en;q=0.5")).toBe("es");
  });

  test("a malformed header falls back rather than throwing", () => {
    for (const header of ["*", "en_US", "", "  ", "es-ES;q=0.9;q=;q"]) {
      expect(() => negotiate(header), header).not.toThrow();
    }
    // `*` means "anything you have", so it takes the first supported locale rather than falling back.
    expect(negotiate("*")).toBe("en");
    expect(negotiate("en_US")).toBeNull();
  });

  test("right-truncation answers a region variant with the base language", () => {
    expect(matchLocale(["es-AR"], SHIPPING)?.locale).toBe("es");
    expect(matchLocale(["es-419"], SHIPPING)?.locale).toBe("es");
    expect(matchLocale(["en-GB"], SHIPPING)?.locale).toBe("en");
  });

  test("a more specific catalog wins over the base when it ships", () => {
    // The day `es-ES` lands, Spain gets it and Mexico still gets `es`, with nothing changing in config.
    expect(matchLocale(["es-ES"], ["en", "es", "es-ES"])?.locale).toBe("es-ES");
    expect(matchLocale(["es-MX"], ["en", "es", "es-ES"])?.locale).toBe("es");
  });

  test("maximizing reaches a script subtag no truncation of the range would", () => {
    expect(matchLocale(["zh-TW"], ["zh-Hans", "zh-Hant"])?.locale).toBe("zh-Hant");
  });

  test("a trailing single-character subtag is dropped with the one before it", () => {
    expect(matchLocale(["en-a-bbb"], ["en"])?.locale).toBe("en");
  });

  test("matching is case-insensitive, and answers with the supported spelling", () => {
    expect(matchLocale(["ES-ar"], ["en", "es"])?.locale).toBe("es");
    expect(matchLocale(["zh-hant-tw"], ["zh-Hant"])?.locale).toBe("zh-Hant");
  });

  test("the declared exception map overrides the walk, because that is what it is for", () => {
    expect(matchLocale(["nb"], ["en", "no"])).toBeNull();
    expect(matchLocale(["nb"], ["en", "no"], { nb: "no" })?.locale).toBe("no");
  });

  test("nothing supported, or nothing matched, is null", () => {
    expect(matchLocale(["es"], [])).toBeNull();
    expect(matchLocale(["de", "fr"], SHIPPING)).toBeNull();
  });

  test("preference order is honored over supported order", () => {
    expect(matchLocale(["es", "en"], ["en", "es"])?.locale).toBe("es");
  });
});

describe("an inherited name is not a language range", () => {
  test("a range naming an inherited property matches nothing, and does not throw", () => {
    // `exceptions["constructor"]` is `Object`; `exceptions["__proto__"]` is the prototype. Both are
    // truthy and neither is a string, so reading them bare threw `TypeError` on `.toLowerCase()` —
    // inside a global middleware, which made `?lang=constructor` a 500 on every request and a stale
    // `pithy_locale=__proto__` cookie a 500 on every request that client made until it was cleared.
    for (const name of INHERITED) {
      expect(() => matchLocale([name], SHIPPING), name).not.toThrow();
      expect(matchLocale([name], SHIPPING), name).toBeNull();
    }
  });

  test("the same name in the exception map is still honored when really declared", () => {
    // `hasOwn`, not a deny-list — an adopter who genuinely writes one of these gets it. `constructor`
    // rather than `toString` because the lookup lower-cases the range, and rather than `__proto__`
    // because `{ __proto__: "es" }` in a literal sets the prototype instead of an own key.
    expect(matchLocale(["constructor"], ["en", "es"], { constructor: "es" })?.locale).toBe("es");
  });

  test("an inherited name is harmless on every link of a real chain, not only this one", () => {
    for (const name of INHERITED) {
      expect(() => matchLocale([name, "es"], SHIPPING), name).not.toThrow();
      // And the link after it is still asked, so one bad candidate does not lose the good one.
      expect(matchLocale([name, "es"], SHIPPING)?.locale, name).toBe("es");
    }
  });
});
