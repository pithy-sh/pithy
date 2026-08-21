// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { minorUnitDigits } from "../data/money";

/**
 * Removing a fraction that is entirely zero from a price Paddle already rendered.
 *
 * A seller whose plans are `$6`, `€12` and `KD 6` renders `$6.00`, `12,00 €` and `‏٦٫٠٠٠ د.ك.‏`, and on a
 * pricing table the decimal is noise on every row. Two Pithy surfaces reached the same conclusion and each
 * wrote `total.replace(/([.,])00(?=\D*$)/, "")` — the same rule, byte for byte, in two repositories. That
 * regex is wrong in the three-decimal dinars, silent in every Arabic-Indic script, and cannot be made
 * right, because the only thing either surface holds is the finished string. This module is the reason
 * neither of them has to.
 *
 * **The decision is arithmetic, and only this package holds the number.** Paddle sends every figure twice:
 * in minor units for comparing, and rendered for showing. $6.00 is `600`, so whether the fraction is zero
 * is `amount % 10 ** places === 0` — no parsing, no locale, no guess. That is what `PriceLine.totals` says
 * it is for. It also removes the whole ambiguity class: *is the trailing `000` in `$1,000` a fraction or a
 * thousands group?* is never asked, because the fraction is known before the string is touched.
 *
 * **The removal never asks which character the separator is.** It is a property of the locale, not of the
 * currency, so the ISO code cannot give it — `de-DE` renders EUR as `6,00 €` and `en-IE` renders the same
 * currency as `€6.00`. And the browser cannot give it either: `Intl.NumberFormat(undefined, …)` answers
 * for the **visitor's** locale while the string was rendered by **Paddle**, so matching the browser's
 * separator is a silent no-op in exactly the case where the two differ, which is the case that matters.
 *
 * So the fraction is located positionally: the trailing run of `places` decimal digits, in whatever
 * script, with a single non-digit before it that must itself follow a digit. Trailing symbols, spaces and
 * bidi marks sit after the run and are carried through untouched. A run preceded by another digit is a
 * thousands group and is left alone — `$1,000` and `1.000 €` both come back exactly as they arrived.
 *
 * **A digit is its own script's zero when the code point below it is not a decimal digit.** Every `Nd`
 * block is ten contiguous points beginning at zero, so that one comparison answers it for Arabic-Indic,
 * Devanagari and the rest. The usual shortcuts do not: `Number("٠")` is `NaN`, and `"٠".normalize("NFKD")`
 * is still `"٠"`.
 *
 * **Only an all-zero fraction ever goes.** Nothing here divides, rounds or truncates, and a real fraction
 * comes back whole. Both halves have to agree before a character is removed — the arithmetic says the
 * fraction is zero *and* the digits in the string are zeros — because the two figures disagreeing means
 * somebody handed this the wrong pair, and the string is the only thing a visitor sees.
 *
 * **`minorUnitDigits` is shared with the server half, deliberately.** It is `../data/money`'s ISO-4217
 * exponent table, the one the purchase projection already uses, and it imports nothing — so the browser
 * bundle gains a set of currency codes and no graph. A second copy of that table here would be this
 * issue's own defect, one layer down.
 */

/** A decimal digit in any script. `Nd`, so Arabic-Indic and Devanagari count as much as ASCII. */
const DECIMAL_DIGIT = /\p{Nd}/u;

/** An amount in minor units, as Paddle writes one: an integer, optionally signed, and nothing else. */
const MINOR_UNITS = /^-?[0-9]+$/;

/** One figure, in both of the forms Paddle sends it in, and what it is denominated in. */
export interface WholeUnitPrice {
  /** Paddle's own rendering of the figure for this visitor. The only thing ever returned. */
  readonly formatted: string;
  /** The same figure in minor units — `"600"` for $6.00, `"6000"` for KD 6.000. Never rendered. */
  readonly minorAmount: string;
  /** The ISO-4217 code the quote is in. It decides how many digits the fraction occupies. */
  readonly currency: string;
}

/** Whether a single character is a decimal digit. */
function isDecimalDigit(character: string | undefined): boolean {
  return character !== undefined && DECIMAL_DIGIT.test(character);
}

/** Whether a single character is the zero of its own script. */
function isScriptZero(character: string | undefined): boolean {
  if (character === undefined || !isDecimalDigit(character)) return false;
  const code = character.codePointAt(0);
  if (code === undefined) return false;
  return !isDecimalDigit(String.fromCodePoint(code - 1));
}

/**
 * The string with its trailing `places`-digit zero fraction and that fraction's separator removed.
 *
 * By code point rather than by UTF-16 unit: a digit outside the BMP would be two units, and a scan that
 * counted units would cut one of them in half. The string itself is returned wherever the shape is not
 * exactly a fraction, which is every refusal in this file — there is no partial removal.
 */
function withoutTrailingZeros(formatted: string, places: number): string {
  const characters = [...formatted];
  // Trailing symbols, spaces and bidi marks come after the fraction, so walk back to the last digit.
  let end = characters.length;
  while (end > 0 && !isDecimalDigit(characters[end - 1])) end -= 1;
  const start = end - places;
  // Two characters at least must precede the run: the separator, and the digit it separates from.
  if (start < 2) return formatted;
  for (let index = start; index < end; index += 1) {
    if (!isScriptZero(characters[index])) return formatted;
  }
  // A digit before the run makes it a thousands group. A non-digit before *that* makes it something
  // this cannot read as a price at all.
  if (isDecimalDigit(characters[start - 1])) return formatted;
  if (!isDecimalDigit(characters[start - 2])) return formatted;
  return [...characters.slice(0, start - 1), ...characters.slice(end)].join("");
}

/**
 * Paddle's rendering with an all-zero fraction removed, or that rendering exactly as it arrived.
 *
 * Opt-in everywhere it is reachable from, and never a default. Only an all-zero fraction ever goes, so an
 * adopter selling at `$6.99` is unaffected either way — but which figures a seller advertises is a pricing
 * decision, and this kit does not get to restyle somebody's prices on their behalf.
 */
export function withoutZeroFraction(price: WholeUnitPrice): string {
  const places = minorUnitDigits(price.currency);
  // The yen has no subunit, so there is no fraction to consider and every digit in the string is part of
  // the figure. This states that rather than enforcing it: with no places the scan below looks at a run
  // of no digits, whose preceding character is the last digit of the figure, and refuses on its own. A
  // test can only see the outcome, so the comment is where the intent lives.
  if (places === 0) return price.formatted;
  if (!MINOR_UNITS.test(price.minorAmount)) return price.formatted;
  const amount = Number(price.minorAmount);
  if (!Number.isSafeInteger(amount)) return price.formatted;
  if (amount % 10 ** places !== 0) return price.formatted;
  return withoutTrailingZeros(price.formatted, places);
}
