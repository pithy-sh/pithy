// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import de from "./price-preview-de.json" with { type: "json" };
import gb from "./price-preview-gb.json" with { type: "json" };
import jpYen from "./price-preview-jp-yen.json" with { type: "json" };
import usCountryOnly from "./price-preview-us-country-only.json" with { type: "json" };
import usNewYork from "./price-preview-us-new-york.json" with { type: "json" };

/**
 * Five real `PricePreview` answers, recorded from the Paddle **sandbox** on 2026-08-13 against one
 * $5.00/month price with no `unit_price_overrides`.
 *
 * They exist because the claim this rail makes — "prices render localized and tax-correct" — is a claim
 * about numbers Paddle chooses, and a test written against numbers *we* chose proves only that our
 * arithmetic agrees with itself. Each of these was fetched, not composed, and each pins a different
 * behaviour of Paddle's that the reader has to get right:
 *
 * | Fixture | Subtotal | Tax | Total | What it pins |
 * |---|---|---|---|---|
 * | {@link US_NEW_YORK} | $5.00 | $0.44 | $5.44 | Tax **added** on top of the listed price. |
 * | {@link US_COUNTRY_ONLY} | $5.00 | $0.00 | $5.00 | The same country with no postal code resolves **0% tax**. |
 * | {@link GB} | $4.17 | $0.83 | $5.00 | VAT taken **out of** the listed price. |
 * | {@link DE} | $4.20 | $0.80 | $5.00 | The same convention, a different rate. |
 * | {@link JP_YEN} | ¥725 | ¥73 | ¥798 | A **zero-decimal** currency, and a converted amount. |
 *
 * Two facts these recordings carry that are easy to state wrongly from memory:
 *
 * **Currency is not localized.** Every response but the last is in USD, from a UK, German and Japanese
 * address alike. Currency comes from `unit_price_overrides` in the catalogue, and this price has none.
 * What localizes without them is tax and formatting.
 *
 * **A converted amount is not a stable number.** {@link JP_YEN} was fetched twice minutes apart and
 * returned ¥797 then ¥798 — Paddle's FX rate moved between the calls. Nothing may assert an exact
 * converted figure against a live account; that is what a recording is for.
 *
 * Typed `unknown` on purpose. These are the input to {@link readPricePreview}, which is a trust
 * boundary, and handing it a value TypeScript already believes would test the guard against itself.
 */

/** New York, 10001. 8.875% added on top of a $5.00 listed price. */
export const US_NEW_YORK: unknown = usNewYork;

/** The United States with no postal code. Tax resolves to zero, and the buyer will still pay $5.44. */
export const US_COUNTRY_ONLY: unknown = usCountryOnly;

/** London, SW1A 1AA. 20% VAT taken out of an inclusive $5.00. */
export const GB: unknown = gb;

/** Berlin, 10115. 19% VAT, same inclusive convention, different rate. */
export const DE: unknown = de;

/** Tokyo, with `currencyCode: "JPY"` forced. Whole yen — ¥725, not ¥72500. */
export const JP_YEN: unknown = jpYen;
