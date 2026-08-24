// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { resolveChain, tagLink } from "./chain";

/**
 * The chain is where the two locales are decided, and where the one asymmetry of this whole design
 * lives: **the catalog locale falls back and the formatting locale does not.** An `es-AR` reader gets
 * the `es` words, because `es` is what anybody wrote — and `es-AR` numbers, because `Intl` knows that
 * locale whether or not a translator ever did. Collapsing the two is the bug where an Argentine reads
 * Spanish and sees `1,234.56`, and every case below exists to keep it collapsed-proof.
 */

const config = (input: I18nConfigInput = {}): I18nConfig => I18nConfig.parse(input);

/** Two supported locales and an English default — the shape most of these cases negotiate against. */
const BILINGUAL = config({ supportedLocales: ["en", "es"], defaultLocale: "en" });

describe("resolveChain", () => {
  test("the first link that matches wins, and later links are not consulted", () => {
    const resolved = resolveChain(
      [tagLink("param", "es"), tagLink("cookie", "en"), tagLink("default", "en")],
      BILINGUAL,
    );
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("param");
  });

  test("an empty link is skipped, not fatal", () => {
    // A cookie the browser never set and a cookie the browser cleared are the same thing here. If an
    // empty link ended the walk, one unset signal would sink every link behind it.
    const resolved = resolveChain(
      [tagLink("param", null), tagLink("user", undefined), tagLink("cookie", "   "), tagLink("header", "es")],
      BILINGUAL,
    );
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("header");
  });

  test("a link whose range matches nothing is skipped too", () => {
    const resolved = resolveChain([tagLink("param", "de"), tagLink("cookie", "es")], BILINGUAL);
    expect(resolved.resolvedBy).toBe("cookie");
  });

  test("the catalog locale falls back and the formatting locale does not", () => {
    // The property the whole two-locale seam exists for. `es-AR` is not in `supportedLocales`; the
    // truncation walk answers `es` for the words, and the reader's own tag survives for `Intl`.
    const resolved = resolveChain([tagLink("header", "es-AR")], BILINGUAL);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es-AR");
  });

  test("the reader's tag is canonicalized, not echoed", () => {
    // Headers arrive lower-cased and the matcher lower-cases what it compares, so `es-ar` is what
    // reaches here. `Intl` is content either way; a `lang` attribute and a stamped email row are not.
    const resolved = resolveChain([tagLink("header", "es-ar")], BILINGUAL);
    expect(resolved.formattingLocale).toBe("es-AR");
  });

  test("a range that is not a constructible tag formats as the catalog locale", () => {
    // `*` is a legal language range and no tag at all — `new Intl.Locale("*")` throws. It takes the
    // first supported locale, and the formatting locale has to fall back to that rather than carry a
    // string `Intl` would reject on the first `formatNumber`.
    const spanishFirst = config({ supportedLocales: ["es", "en"], defaultLocale: "en" });
    const resolved = resolveChain([tagLink("header", "*")], spanishFirst);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es");
    // Not the default, so this is genuinely the wildcard answering rather than the chain falling off.
    expect(resolved.resolvedBy).toBe("header");
  });

  test("falling off the end gives the project default, marked `default`", () => {
    const resolved = resolveChain([tagLink("param", null), tagLink("cookie", "de")], BILINGUAL);
    expect(resolved).toEqual({
      catalogLocale: "en",
      formattingLocale: "en",
      direction: "ltr",
      resolvedBy: "default",
    });
  });

  test("an empty chain gives the project default", () => {
    expect(resolveChain([], BILINGUAL).resolvedBy).toBe("default");
  });

  test("the direction comes from the locale that won, not from the project default", () => {
    const arabic = config({ supportedLocales: ["en", "ar"], defaultLocale: "en" });
    expect(resolveChain([tagLink("param", "ar")], arabic).direction).toBe("rtl");
    expect(resolveChain([tagLink("param", "en")], arabic).direction).toBe("ltr");
  });

  test("a declared exception answers a range no truncation would reach", () => {
    // `nb` truncates to `nb` and stops; nothing derives that it means `no`. The pair is historical, so
    // it is declared rather than computed.
    const norwegian = config({ supportedLocales: ["en", "no"], defaultLocale: "en", exceptions: { nb: "no" } });
    const resolved = resolveChain([tagLink("header", "nb")], norwegian);
    expect(resolved.catalogLocale).toBe("no");
    expect(resolved.resolvedBy).toBe("header");
  });

  test("a chain fed nothing but malformed ranges lands on the default rather than throwing", () => {
    const links = [
      { name: "header", ranges: ["en_US", "", "   ", ";q=0.9", "*".repeat(200)] },
      { name: "cookie", ranges: ["de"] },
    ];
    expect(() => resolveChain(links, BILINGUAL)).not.toThrow();
    expect(resolveChain(links, BILINGUAL).resolvedBy).toBe("default");
  });
});

describe("tagLink", () => {
  test("a blank tag is nothing, not a range", () => {
    expect(tagLink("cookie", "  ").ranges).toEqual([]);
    expect(tagLink("cookie", "").ranges).toEqual([]);
    expect(tagLink("cookie", null).ranges).toEqual([]);
    expect(tagLink("cookie", undefined).ranges).toEqual([]);
  });

  test("a tag is trimmed and kept whole", () => {
    expect(tagLink("cookie", " es-AR ")).toEqual({ name: "cookie", ranges: ["es-AR"] });
  });
});

describe("a formatting locale is a locale, not an instruction", () => {
  test("an extension subtag on the range never reaches Intl", () => {
    // `?lang=en-u-nu-hanidec` truncates to `en` and matches a project that ships English. Carried
    // whole into `formattingLocale` it steers `Intl` itself — Han decimal numerals on a price.
    const resolved = resolveChain([{ name: "param", ranges: ["en-u-nu-hanidec"] }], config());
    expect(resolved.catalogLocale).toBe("en");
    expect(resolved.formattingLocale).toBe("en");
    expect(new Intl.NumberFormat(resolved.formattingLocale).format(1234)).toBe("1,234");
  });

  test("and the region a reader really asked for still survives", () => {
    // And the RFC-4647 walk gets there: `es-ar-u-ca-islamic` drops `islamic`, then `ca`, then the
    // single-character `u` with the subtag before it, landing on `es-ar` and matching `es`.
    const resolved = resolveChain(
      [{ name: "param", ranges: ["es-AR-u-ca-islamic"] }],
      config({ supportedLocales: ["en", "es"] }),
    );
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es-AR");
  });
});
