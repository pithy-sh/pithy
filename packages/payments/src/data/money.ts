// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Money, as the three rails report it and as the purchases table stores it.
 *
 * `amountMinor` is an integer in the currency's minor unit — cents for USD, yen for JPY, fils for KWD.
 * No rail reports that directly. Apple reports thousandths of the currency unit ("milliunits"), Google
 * reports millionths ("micros"), and Stripe reports minor units already. Converting means dividing by the
 * rail's scale and then multiplying by the currency's own exponent, and the exponent is the part that
 * catches people out: dividing Apple's 500000 for ¥500 by ten yields 50000, a hundredfold overstatement,
 * because the yen has no subunit to divide into.
 *
 * So this holds the short list of currencies whose exponent is not two. It is a fixed list — ISO 4217 does
 * not churn — and an unknown code falls back to two rather than throwing, because a webhook must not fail
 * over a reporting detail.
 *
 * **{@link minorUnitDigits} is read from the browser half too**, by `../client/wholeUnits`, which is why
 * this module imports nothing and must keep importing nothing: it is on the browser allowlist in
 * `../client/sameOrigin.test.ts`, so anything reached from here lands in an adopter's bundle. The
 * exponent is the same fact on both sides — how many digits the fraction occupies — and a second table
 * for the client would be the drift `#427` exists to remove.
 */

/** Currencies with no subunit — the amount is already in minor units whatever the rail's scale. */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** Currencies whose minor unit is a thousandth, not a hundredth. */
const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** How many digits the currency's minor unit occupies. Two unless ISO 4217 says otherwise. */
export function minorUnitDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Convert a rail-reported amount into minor units, or null when it cannot be trusted.
 *
 * `scale` is what one currency unit is worth in the rail's own integer — 1000 for Apple's milliunits,
 * 1_000_000 for Google's micros, 10 ** `minorUnitDigits` for a rail already reporting minor units.
 *
 * Null is returned rather than an approximation for a missing price, a missing currency, a non-finite
 * number, or a negative amount. The last matters: `pithy_payments_purchases` refuses a negative
 * `amountMinor` by CHECK constraint, so a rail reporting one would abort the whole projection batch and
 * lose the purchase. An absent amount costs a reporting figure; a lost purchase costs a subscriber.
 */
export function minorUnitsFromScaled(scaled: number | null, scale: number, currency: string | null): number | null {
  if (scaled === null || currency === null) return null;
  if (!Number.isFinite(scaled) || scaled < 0) return null;
  // Multiply before dividing. `(1005 / 1000) * 100` is 100.49999999999999 in binary floating point, which
  // rounds to 100 and quietly loses a cent on every price that lands on a half; `(1005 * 100) / 1000` is
  // exactly 100.5. The operands are small integers, so the product cannot approach the safe-integer limit.
  return Math.round((scaled * 10 ** minorUnitDigits(currency)) / scale);
}
