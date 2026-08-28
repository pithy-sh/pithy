// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEFAULT_LOCALE } from "@pithy-sh/core/src/i18n/translator";
import { describe, expect, test } from "vitest";
import { minorUnitDigits } from "./money";
import { RENDER_FALLBACK_LOCALE, renderMoney } from "./renderMoney";

/**
 * The one place this package turns an integer into a sentence a customer reads, and the whole risk it
 * carries: `6582` is `$65.82`, `¥6,582` and `₩6,582`, and a divide-by-100 gets two of those wrong by a
 * factor of a hundred.
 *
 * **Almost nothing here is a pasted string.** `Intl`'s output moves with ICU, so an expectation written
 * out by hand is a test that fails on a runtime upgrade for a reason that is not a defect —
 * `client/wholeUnits.test.ts` established that rule and this follows it. What is written by hand is the
 * part the renderer must not be allowed to decide: **the amount in whole units.** `6582` minor units is
 * `65.82` dollars and `6582` yen, and those two numbers are the assertion. Rendering them is `Intl`'s
 * job on both sides.
 *
 * The two exceptions are the two figures #465 was filed with — `$65.82` and `65,82 US$` — pinned
 * verbatim because they are what the issue measured and what a reader comparing this file to the issue
 * needs to find.
 */

/** The same formatter the renderer builds, driven from a whole-unit number written by hand. */
function expected(locale: string, currency: string, wholeUnits: number): string {
  const digits = minorUnitDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(wholeUnits);
}

/** Every decimal digit in a rendered figure, in order — what survives when the symbol and grouping do not. */
function digitsOf(rendered: string): string {
  return [...rendered].filter((character) => /\p{Nd}/u.test(character)).join("");
}

describe("renderMoney", () => {
  test("states the figure #465 was filed with, in the locale that asked for it", () => {
    // The two measurements from the issue, verbatim. Everything else in this file is rendered.
    expect(renderMoney(6582, "usd", "en")).toBe("$65.82");
    // `\u00a0`, escaped rather than pasted: `Intl` separates the figure from the symbol with a
    // non-breaking space, and a literal one here is a character a reader of this file cannot see.
    expect(renderMoney(6582, "usd", "es")).toBe("65,82\u00a0US$");
  });

  test("the exponent comes from the currency, not from a divide by a hundred", () => {
    // The whole risk, stated as six rows: the same 6582 is a different quantity in each currency. The
    // right-hand number is the amount a customer is being asked to agree to, written in whole units.
    expect(renderMoney(6582, "usd", "en")).toBe(expected("en", "usd", 65.82));
    expect(renderMoney(6582, "gbp", "en")).toBe(expected("en", "gbp", 65.82));
    expect(renderMoney(6582, "jpy", "en")).toBe(expected("en", "jpy", 6582));
    expect(renderMoney(6582, "krw", "en")).toBe(expected("en", "krw", 6582));
    expect(renderMoney(6582, "clp", "en")).toBe(expected("en", "clp", 6582));
    expect(renderMoney(6582, "kwd", "en")).toBe(expected("en", "kwd", 6.582));
  });

  test("the zero-decimal currencies keep every digit they arrived with", () => {
    // Independent of `expected` above, which shares the renderer's own table: a divide-by-100 would put
    // "6582" through as "65.82" and the digits would still read 6582, so the *separator* is the tell.
    // ¥6,582 groups; ¥65.82 fractions. What is asserted is that no fraction was invented.
    for (const currency of ["jpy", "krw", "clp"]) {
      const rendered = renderMoney(6582, currency, "en");
      expect(rendered, currency).not.toBeNull();
      expect(digitsOf(rendered ?? ""), currency).toBe("6582");
      // A hundredth of the figure is what the naive scaling would state. It must not be reachable.
      expect(rendered, currency).not.toBe(expected("en", "usd", 65.82).replace("$", ""));
      expect(minorUnitDigits(currency), currency).toBe(0);
    }
  });

  test("a naive divide-by-100 is refuted, not merely avoided", () => {
    // The plant: what this renderer would say if it scaled every currency by a hundred. Two of the four
    // rows are indistinguishable from the truth, which is exactly why the other two have to be pinned.
    const naive = (amountMinor: number, currency: string): string =>
      new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(amountMinor / 100);
    expect(renderMoney(6582, "usd", "en")).toBe(naive(6582, "usd"));
    expect(renderMoney(6582, "jpy", "en")).not.toBe(naive(6582, "jpy"));
    expect(renderMoney(6582, "krw", "en")).not.toBe(naive(6582, "krw"));
    expect(renderMoney(6582, "clp", "en")).not.toBe(naive(6582, "clp"));
  });

  test("the fraction digits are the store's, not the display convention's", () => {
    // Measured 2026-08-28. CLDR renders HUF and COP with **no** fraction — `Intl` at its own defaults
    // answers "66 Ft" for 6582 minor units — while Paddle's own supported-currency table gives both 2
    // decimals, so 6582 is 65.82 forint. Letting `Intl` choose would round a figure a customer confirms.
    for (const { locale, currency } of [
      { locale: "hu", currency: "huf" },
      { locale: "en", currency: "cop" },
    ]) {
      const loose = new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() });
      expect(loose.resolvedOptions().maximumFractionDigits, currency).toBe(0);
      expect(renderMoney(6582, currency, locale), currency).toBe(expected(locale, currency, 65.82));
      expect(renderMoney(6582, currency, locale), currency).not.toBe(loose.format(65.82));
      expect(digitsOf(renderMoney(6582, currency, locale) ?? ""), currency).toBe("6582");
    }
  });

  test("a credit is signed, because the store's own figures are", () => {
    expect(renderMoney(-6582, "usd", "en")).toBe(expected("en", "usd", -65.82));
    expect(renderMoney(0, "usd", "en")).toBe(expected("en", "usd", 0));
  });

  test("no digit is lost at the top of the safe-integer range", () => {
    // The reason the scaling is a string operation and not a division. `9007199254740991 / 100` is
    // 90071992547409.9 in binary floating point — a cent gone, silently, on the largest figures.
    const rendered = renderMoney(Number.MAX_SAFE_INTEGER, "usd", "en");
    expect(digitsOf(rendered ?? "")).toBe("9007199254740991");
    expect(rendered).not.toBe(
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number.MAX_SAFE_INTEGER / 100),
    );
  });

  test("a figure under one whole unit keeps its leading zero", () => {
    expect(renderMoney(7, "usd", "en")).toBe(expected("en", "usd", 0.07));
    expect(renderMoney(7, "kwd", "en")).toBe(expected("en", "kwd", 0.007));
    expect(renderMoney(7, "jpy", "en")).toBe(expected("en", "jpy", 7));
  });

  test("a locale nothing resolved falls back to the kit's own, stated rather than guessed", () => {
    expect(RENDER_FALLBACK_LOCALE).toBe(DEFAULT_LOCALE);
    expect(renderMoney(6582, "usd")).toBe(renderMoney(6582, "usd", RENDER_FALLBACK_LOCALE));
    expect(renderMoney(6582, "usd", "")).toBe(renderMoney(6582, "usd", RENDER_FALLBACK_LOCALE));
  });

  test("a locale `Intl` refuses costs the reader their language, never the figure", () => {
    // A tag that is not constructible reaches here only from an adopter's own config; the answer is the
    // fallback language, because a quote with no amount on it is the one outcome worse than English.
    expect(() => new Intl.NumberFormat("not a tag!!")).toThrow(RangeError);
    expect(renderMoney(6582, "usd", "not a tag!!")).toBe(renderMoney(6582, "usd", RENDER_FALLBACK_LOCALE));
  });

  test("a currency `Intl` cannot name is null, not a guess", () => {
    // The idiom `minorUnitsFromScaled` and `minorAmount` already set: null rather than an approximation.
    // The rail refuses the quote on it, which is the answer a hostile store response already gets.
    for (const currency of ["", "zz", "dollars", "us$", "usd "]) {
      expect(renderMoney(6582, currency, "en"), JSON.stringify(currency)).toBeNull();
    }
  });

  test("a well-formed code nobody has heard of still renders, with the code standing in", () => {
    // `XTS` is ISO 4217's reserved testing code. The refusal above is about a *shape* nothing can be
    // denominated in, not about a list of known currencies — a second allowlist here would be a table to
    // keep current and a way for a real currency to become unrenderable on a customer's screen.
    const rendered = renderMoney(6582, "xts", "en");
    expect(rendered).not.toBeNull();
    expect(rendered).toContain("XTS");
    expect(digitsOf(rendered ?? "")).toBe("6582");
    expect(minorUnitDigits("xts")).toBe(2);
  });

  test("an amount that is not a whole number of minor units renders loudly", () => {
    // Unreachable through the rail — `minorAmount` refuses anything but an integer string and
    // `QuotedMoney` refuses a float — so this pins the direction of the failure rather than a feature.
    // Nothing here rounds, so the only thing left to be is obviously broken.
    expect(renderMoney(65.82, "usd", "en")).toContain("NaN");
    expect(renderMoney(Number.NaN, "usd", "en")).toContain("NaN");
  });
});
