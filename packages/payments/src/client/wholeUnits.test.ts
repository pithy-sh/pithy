// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { minorUnitDigits } from "../data/money";
import { withoutZeroFraction } from "./wholeUnits";

/**
 * The zero-fraction trim, against strings a browser really renders.
 *
 * **Every input here comes out of `Intl.NumberFormat`, and none of them is pasted.** A literal in a test
 * is somebody's memory of what a locale looks like, and the two rows that matter most — Kuwait and Egypt
 * — are the two nobody can check by eye: Arabic-Indic digits, a `U+066B` decimal separator that is not a
 * comma, and a right-to-left mark at each end. A reviewer regenerates any row here by running the same
 * two lines.
 *
 * **The expected string is rendered too, by asking `Intl` for the same amount with no fraction digits.**
 * That is a second, independent derivation of the answer: it never sees the string under test, so a trim
 * that removed the wrong characters cannot agree with it by construction. Each trimmed row also asserts
 * the two renderings differ, so a locale that never had a fraction cannot pass this vacuously.
 */

/** One row of the table: where the visitor is, what the price is in, and how much. */
interface Row {
  /** The locale Paddle rendered for. Never the browser's — see the module under test. */
  readonly locale: string;
  /** The ISO-4217 code, which is what decides how many digits the fraction occupies. */
  readonly currency: string;
  /** The amount in whole currency units — `6` for six dollars, `1200` for twelve hundred. */
  readonly amount: number;
}

/** What a browser renders for that row: the string Paddle would send as a formatted total. */
function rendered(row: Row): string {
  return new Intl.NumberFormat(row.locale, { style: "currency", currency: row.currency }).format(row.amount);
}

/** The same figure with no fraction at all. The independent answer a trimmed row must equal. */
function withoutFraction(row: Row): string {
  return new Intl.NumberFormat(row.locale, {
    style: "currency",
    currency: row.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(row.amount);
}

/** The same figure in minor units, as Paddle sends it — `"600"` for $6.00, `"6000"` for KD 6.000. */
function minorAmount(row: Row): string {
  return String(Math.round(row.amount * 10 ** minorUnitDigits(row.currency)));
}

/** The trim, applied to a row's own rendering — or to a string given in its place. */
function trim(row: Row, formatted: string = rendered(row)): string {
  return withoutZeroFraction({ formatted, minorAmount: minorAmount(row), currency: row.currency });
}

/** A row whose fraction must go, and the input and answer it renders to. */
function trimmed(row: Row): void {
  // Anti-vacuous, per row: a locale rendering no fraction in the first place would pass the assertion
  // below without the trim doing anything at all.
  expect(rendered(row)).not.toBe(withoutFraction(row));
  expect(trim(row)).toBe(withoutFraction(row));
}

describe("the fixtures are what a browser really renders", () => {
  test("this runtime has the locale data the table is built from", () => {
    // Without full ICU every row collapses to one locale's rendering and the whole table agrees with
    // itself about nothing. Two literals, checked once, so the rest of the file can be generated.
    expect(rendered({ locale: "en-US", currency: "USD", amount: 6 })).toBe("$6.00");
    expect(rendered({ locale: "de-DE", currency: "EUR", amount: 1200 })).toBe("1.200,00 €");
  });

  test("Kuwait renders three Arabic-Indic zeros after a separator that is not a comma", () => {
    // The row the two adopter copies were silent on, spelled out in code points so it is checkable.
    const kuwait = [...rendered({ locale: "ar-KW", currency: "KWD", amount: 6 })];
    expect(kuwait.slice(0, 6).map((character) => character.codePointAt(0))).toEqual([
      0x200f, 0x0666, 0x066b, 0x0660, 0x0660, 0x0660,
    ]);
  });
});

describe("withoutZeroFraction removes a fraction that is entirely zero", () => {
  test("a dollar price loses its two zeros", () => {
    trimmed({ locale: "en-US", currency: "USD", amount: 6 });
  });

  test("a German euro price loses a comma fraction and keeps its full-stop thousands", () => {
    // `1.200,00 €`. The one string that proves the separator is located rather than assumed: both
    // characters appear in it, doing opposite jobs.
    trimmed({ locale: "de-DE", currency: "EUR", amount: 1200 });
  });

  test("the same currency in Ireland uses the other separator, and is trimmed just the same", () => {
    // `€6.00` against `6,00 €`. The separator is a property of the locale, never of the currency, so
    // nothing may be derived from the ISO code.
    trimmed({ locale: "en-IE", currency: "EUR", amount: 6 });
  });

  test("a Swiss franc price grouped with a narrow space survives the removal", () => {
    trimmed({ locale: "fr-CH", currency: "CHF", amount: 1200 });
  });

  test("Indian grouping is left exactly as it was", () => {
    // `₹1,00,000.00`. Groups of two above the first three, so a rule counting digits from the end
    // would cut in the wrong place.
    trimmed({ locale: "hi-IN", currency: "INR", amount: 100_000 });
  });

  test("a three-decimal currency's whole-number price is trimmed, which no regex over the string does", () => {
    // Kuwait. `/([.,])00(?=\D*$)/` — the rule both adopters wrote — never fires here on either count:
    // three digits, and not one of them is `0`.
    trimmed({ locale: "ar-KW", currency: "KWD", amount: 6 });
  });

  test("an Arabic-Indic two-decimal price is trimmed too", () => {
    trimmed({ locale: "ar-EG", currency: "EGP", amount: 6 });
  });

  test("nothing left of the fraction is disturbed — the symbol, the marks and the spacing all stand", () => {
    // Stated as a whole string rather than as a property, because the bidi marks are what a positional
    // scan is most likely to eat and they are invisible in a diff.
    const kuwait = { locale: "ar-KW", currency: "KWD", amount: 6 };
    expect([...trim(kuwait)].map((character) => character.codePointAt(0))).toEqual([
      ...[...rendered(kuwait)].map((character) => character.codePointAt(0)).slice(0, 2),
      ...[...rendered(kuwait)].map((character) => character.codePointAt(0)).slice(6),
    ]);
  });

  test("zero is a price like any other", () => {
    trimmed({ locale: "en-US", currency: "USD", amount: 0 });
  });
});

describe("withoutZeroFraction never touches a fraction that is not zero", () => {
  test("$6.99 is left alone", () => {
    const row = { locale: "en-US", currency: "USD", amount: 6.99 };
    expect(trim(row)).toBe("$6.99");
  });

  test("6,50 € is left alone", () => {
    const row = { locale: "de-DE", currency: "EUR", amount: 6.5 };
    expect(trim(row)).toBe(rendered(row));
    expect(trim(row)).toContain("6,50");
  });

  test("a rounding of any kind would show here, and does not", () => {
    // The whole idea is a defect if this ever fails. Nothing in the module divides, rounds or truncates.
    for (const amount of [6.99, 6.5, 0.01, 1234.56]) {
      const row = { locale: "en-US", currency: "USD", amount };
      expect(trim(row)).toBe(rendered(row));
    }
  });
});

describe("withoutZeroFraction never mistakes a thousands group for a fraction", () => {
  test("$1,000 keeps its zeros", () => {
    // The ambiguity the arithmetic removes and the position confirms: `100000` minor units is divisible,
    // so only the character before the trailing zeros settles it — and here it is another digit.
    const row = { locale: "en-US", currency: "USD", amount: 1000 };
    expect(trim(row, withoutFraction(row))).toBe("$1,000");
  });

  test("1.000 € keeps its zeros, though the separator is the one a dollar fraction uses", () => {
    const row = { locale: "de-DE", currency: "EUR", amount: 1000 };
    expect(trim(row, withoutFraction(row))).toBe(withoutFraction(row));
  });

  test("a four-digit price nobody grouped keeps every one of them", () => {
    // Spanish renders a thousand as `1000 €` — no group separator at all, because CLDR only groups from
    // five digits here. So the character before the trailing zeros is another zero and the one before
    // *that* is a digit too, which is the only arrangement the grouping guard alone catches. Without it
    // this reads `1000 €` as a fraction and answers `10 €`, an order of magnitude off the price.
    const row = { locale: "es-ES", currency: "EUR", amount: 1000 };
    // The premise, checked rather than assumed: this locale really does render the four digits in a run.
    expect(withoutFraction(row).startsWith("1000")).toBe(true);
    expect(trim(row, withoutFraction(row))).toBe(withoutFraction(row));
  });

  test("and the same price with its fraction still loses only the fraction", () => {
    trimmed({ locale: "es-ES", currency: "EUR", amount: 1000 });
  });
});

describe("withoutZeroFraction leaves a currency with no fraction to remove", () => {
  test("￥500 is never considered, because the yen has no subunit", () => {
    const row = { locale: "ja-JP", currency: "JPY", amount: 500 };
    expect(trim(row)).toBe(rendered(row));
    expect(trim(row)).toContain("500");
  });

  test("a thousand yen keeps all three of its zeros", () => {
    // Handed a string whose trailing zeros are a thousands group and a currency with no fraction, the
    // only right answer is the string. A rule reading the digits would take three of them.
    //
    // Guarded twice, and this cannot tell which guard answered: `minorUnitDigits("JPY")` is 0, and a run
    // of no digits is preceded by the last digit of the figure, which the positional rule refuses on its
    // own. The early return in the module states the intent; the outcome is what is asserted here.
    expect(withoutZeroFraction({ formatted: "¥1,000", minorAmount: "1000", currency: "JPY" })).toBe("¥1,000");
  });
});

describe("withoutZeroFraction refuses what it cannot decide from", () => {
  test("an amount that is not an integer of minor units is left alone", () => {
    for (const amount of ["", " ", "6.00", "six hundred", "NaN", "1e3"]) {
      expect(withoutZeroFraction({ formatted: "$6.00", minorAmount: amount, currency: "USD" })).toBe("$6.00");
    }
  });

  test("a string with no digits at all is left alone", () => {
    expect(withoutZeroFraction({ formatted: "—", minorAmount: "600", currency: "USD" })).toBe("—");
  });

  test("a fraction with nothing in front of its separator is left alone", () => {
    // Neither is a price `Intl` renders, and both are shapes a hand-written or truncated string takes.
    // `.00` has no room for a separator and a digit; `$.00` has the room and no digit in it. Removing
    // either fraction leaves a string that is not a figure at all.
    expect(withoutZeroFraction({ formatted: ".00", minorAmount: "0", currency: "USD" })).toBe(".00");
    expect(withoutZeroFraction({ formatted: "$.00", minorAmount: "0", currency: "USD" })).toBe("$.00");
  });

  test("digits that are not zeros stay, even when the arithmetic says the fraction is zero", () => {
    // The two figures disagreeing is somebody handing this the wrong pair. The string is Paddle's and
    // is the only thing a visitor sees, so a disagreement leaves it exactly as it arrived.
    expect(withoutZeroFraction({ formatted: "$6.99", minorAmount: "600", currency: "USD" })).toBe("$6.99");
  });
});
