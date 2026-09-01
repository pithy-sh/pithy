// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEFAULT_LOCALE } from "@pithy-sh/core/src/i18n/translator";
import { minorUnitDigits } from "./money";

/**
 * An integer in a currency's minor unit, as a sentence a customer reads — `6582` to `$65.82`.
 *
 * ## Why this exists at all, when `client/paddle.ts` says never to format a price
 *
 * That rule stands, and this does not break it: **it never decides an amount.** Paddle's integer goes in
 * and comes back out, digit for digit, with a separator placed and a symbol attached. Nothing here
 * divides, rounds, sums or nets, and the minor amount stays on the shape beside the string, so a consumer
 * that wants the integer still gets the integer (see `QuotedMoney`).
 *
 * The reason the kit gave for never doing this was wrong, and it was measured wrong on 2026-08-28 (#465).
 * `client/paddle.ts` argued that `Intl.NumberFormat` "would have to carry a table of which currencies have
 * two decimals, and would get one wrong". It carries exactly that table, from CLDR, and it is right about
 * the zero-decimal currencies: `resolvedOptions().maximumFractionDigits` answers 2 for `USD` and `GBP` and
 * 0 for `JPY`, `KRW` and `CLP`. Paddle's own documentation instructs adopters to do this — "use a currency
 * library to format monetary values to the correct number of decimals… symbols and decimal separators are
 * placed correctly" (api-reference/about/data-types) — and offers `formatted_totals` only on the
 * pricing-preview endpoint, "for convenience". `subscriptions.preview` and `transactions.preview` return no
 * formatted field at any depth, verified against the recordings. So a plan-change quote has minor units or
 * it has nothing, and a confirmation screen with no figure on it is a customer agreeing to an amount they
 * were never shown.
 *
 * ## The exponent is the store's, and `Intl`'s own is not it
 *
 * This is the part the correction above would get wrong if it stopped one sentence early. **CLDR's
 * fraction digits are a display convention, not the denomination the money arrived in**, and they are
 * maintained by different people for a different purpose.
 *
 * The example this originally carried was wrong and is worth keeping as the correction. It claimed
 * `Intl` renders 6582 forint as `66 Ft`, from CLDR giving `HUF` no fraction. CLDR carries **two**
 * fraction tables — standard digits, and `cashDigits` for rounding physical currency — and `HUF` and
 * `COP` are zero only in the second. `Intl.NumberFormat` reads the first, answers 2 for both, and
 * renders `65,82 Ft`. Re-measured on ICU 75.1: across every code this package can be paid in, CLDR and
 * ISO 4217 agree on all of them, so there is no live divergence to point at.
 *
 * The pinning stays anyway, and agreement today is the reason it is cheap rather than the reason to
 * drop it: `Intl` is asked for a symbol and separators, and a renderer that let it choose the exponent
 * would be taking the denomination from a table that can move under a runtime upgrade.
 *
 * So the digits come from {@link minorUnitDigits} — ISO 4217, the table this package already converts
 * every rail's amounts through and the one `client/wholeUnits.ts` already trusts against Paddle's own
 * strings — and `Intl` is **pinned** to it on both ends. `Intl` decides the symbol, the separators, the
 * grouping and the placement; it does not decide how much money this is.
 *
 * ## The scaling is a string operation, deliberately
 *
 * `9007199254740991 / 100` is `90071992547409.9` in binary floating point — a cent, gone, on the largest
 * figure this package can hold. `Intl.NumberFormat.prototype.format` accepts a decimal **string** (ES2023,
 * and available in Workers and Node 22 alike), so the point is placed by moving characters and the digits
 * that arrived are the digits that render. There is no arithmetic to be wrong.
 *
 * ## Where the locale comes from
 *
 * Not from here, and not from a request field. `Translator.formattingLocale` — `c.var.t` on every route —
 * is what the kit already negotiates per reader, and `@pithy-sh/email` sets the precedent by building a
 * per-recipient translator from a stored locale rather than inventing a second rule. This module takes
 * that string as a value, which is the seam's stated contract for exactly this case: "an adopter who
 * already owns their date and number rendering needs the locale as a *value* to hand to `Intl`".
 *
 * When nothing resolves it, the answer is {@link RENDER_FALLBACK_LOCALE} and it is *stated*: a quote
 * rendered in the wrong language is recoverable, and a quote with no figure on it is not.
 */

/**
 * The language a figure is rendered in when the reader's own did not resolve.
 *
 * Core's `DEFAULT_LOCALE` rather than a second constant: it is already the locale a project falls back to
 * and the one the kit writes in, and two answers to "what language when we do not know" is how a screen
 * ends up in one and its money in another.
 */
export const RENDER_FALLBACK_LOCALE = DEFAULT_LOCALE;

/**
 * A currency code `Intl` can be asked about at all: three ASCII letters, which is every code ISO 4217
 * issues.
 *
 * **The shape, deliberately, and not a list of codes.** `Intl` throws a `RangeError` only on a code that is
 * not well-formed; a well-formed one nobody has heard of renders with the code itself standing in for the
 * symbol, which is the honest answer and is what CLDR does for `XTS`. A second allowlist of currencies here
 * would be a table to keep current and a way for a real currency to become unrenderable.
 */
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/**
 * `Intl.NumberFormat` with the `format` signature the runtime actually has.
 *
 * ES2023 — "NumberFormat V3" — widened `format` to accept a decimal **string**, and V8 has shipped it for
 * years: it is what Workers and Node 22 both do, and `renderMoney.test.ts` proves it by asserting the
 * cent that a `number` loses at the top of the safe-integer range. This repository compiles against
 * `lib: ["ES2022"]`, whose declaration stops at `number | bigint` — and moving to TypeScript's own ES2023
 * declaration would not help: it widens `format` to the template literal type `` `${number}` ``, which a
 * string assembled at runtime is never assignable to.
 *
 * So the runtime's signature is named here, once, behind one assertion — rather than moving every
 * package's `lib` for a single call, or passing a `number` and losing the digit the string exists to keep.
 */
interface DecimalFormatter {
  /** The amount, as a decimal string in whole units — `"65.82"`, `"-6582"`, `"0.007"`. */
  format(value: string): string;
}

/**
 * The amount as a decimal string, with the point moved `digits` places left.
 *
 * Lexical from end to end. The caller's integer is documented as a safe integer — `minorAmount` refuses
 * anything else and `QuotedMoney` refuses a float — and when that is violated the split produces a string
 * `Intl` renders as `NaN`. That is the intended direction of the failure: loud, and impossible to mistake
 * for a figure, where a rounded or truncated one would be a wrong number nobody notices.
 */
function decimalOf(amountMinor: number, digits: number): string {
  const sign = amountMinor < 0 ? "-" : "";
  const magnitude = String(Math.abs(amountMinor));
  if (digits === 0) return `${sign}${magnitude}`;
  const padded = magnitude.padStart(digits + 1, "0");
  const point = padded.length - digits;
  return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`;
}

/**
 * `amountMinor` of `currency`, rendered for a reader of `locale` — or `null` when the currency cannot be
 * named.
 *
 * Null rather than a guess, which is the idiom `minorAmount` and `minorUnitsFromScaled` already set in this
 * package: a store that answered `"dollars"` where a currency goes has answered with something no amount can
 * be denominated in, and the caller refuses the whole quote on it rather than letting a `RangeError` out of
 * `Intl` reach a confirmation screen as a 500. A **locale** `Intl` refuses is the other case entirely, and
 * costs the reader only their language — see {@link RENDER_FALLBACK_LOCALE}.
 *
 * `locale` is optional so that a caller with nothing to pass writes nothing, rather than writing `"en"` at
 * a call site and putting the fallback in two places.
 */
export function renderMoney(amountMinor: number, currency: string, locale?: string): string | null {
  if (!CURRENCY_CODE.test(currency)) return null;
  const digits = minorUnitDigits(currency);
  const options: Intl.NumberFormatOptions = {
    style: "currency",
    // Uppercased only here. Lowercase is how this package stores a currency, and `Intl` accepts either —
    // but the ISO spelling is what a reader of this line should see being handed over.
    currency: currency.toUpperCase(),
    // Pinned to the store's denomination on both ends, so `Intl` cannot round a figure off a quote. See
    // the module note: CLDR would render `HUF` and `COP` with no fraction at all.
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  };
  return formatter(options, locale).format(decimalOf(amountMinor, digits));
}

/**
 * A formatter for `locale`, or one for {@link RENDER_FALLBACK_LOCALE} when `locale` is not a tag `Intl`
 * accepts.
 *
 * The chain negotiates and canonicalizes every reader-supplied tag before it reaches a route, so the only
 * way an unconstructible one arrives here is an adopter's own configured default. That is a mistake worth
 * surviving rather than raising through a confirmation screen: the fallback keeps the amount readable and
 * the misconfiguration is visible in the language, not in a 500.
 *
 * The fallback formatter cannot throw in turn — the currency was checked before this was called, and
 * `RENDER_FALLBACK_LOCALE` is a constant.
 */
function formatter(options: Intl.NumberFormatOptions, locale: string | undefined): DecimalFormatter {
  if (locale !== undefined && locale !== "") {
    try {
      return decimalFormatter(locale, options);
    } catch {
      // A `RangeError` from a malformed tag. Nothing else here can throw, and the reader still gets a figure.
    }
  }
  return decimalFormatter(RENDER_FALLBACK_LOCALE, options);
}

/** The one assertion in this module. See {@link DecimalFormatter} for what it asserts and what proves it. */
function decimalFormatter(locale: string, options: Intl.NumberFormatOptions): DecimalFormatter {
  return new Intl.NumberFormat(locale, options) as unknown as DecimalFormatter;
}
