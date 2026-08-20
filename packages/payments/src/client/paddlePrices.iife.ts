// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mountPrices } from "./paddlePricesTag";

/**
 * The browser build's entry: one classic script, configured by its own tag.
 *
 * ```html
 * <script src="/js/paddle-prices.js"
 *         data-paddle-env="sandbox"
 *         data-paddle-token="test_…"
 *         data-paddle-price-solo="pri_…"
 *         data-paddle-price-team="pri_…"></script>
 * ```
 *
 * It quotes every plan the tag names and writes each formatted total into the `[data-price-plan]` slot
 * that asked for it. A site with no build step gets the same quote path the dashboard imports, which is
 * the whole point: `#416` was one surface's copy of this being wrong while the other surface's copy was
 * right, and nothing ran both.
 *
 * **The answer is also handed back, on `window.pithyPaddlePrices`.** A site that keeps its own cache or its own
 * formatting rule — `$6.00` rendered as `$6`, say — sets `data-paddle-paint="off"` and awaits
 * `window.pithyPaddlePrices.quotes` instead. Caching and painting stay with whoever is rendering; only the
 * quote is shared.
 *
 * `document.currentScript` is read here and nowhere deeper, because it is only itself while the script is
 * running. Everything past that point takes the tag as an argument.
 */

/** What the page can reach once this has run. */
export interface PithyPaddlePrices {
  /** The quote, or the refusal. Resolves once; never rejects. */
  readonly quotes: ReturnType<typeof mountPrices>;
}

(globalThis as unknown as { pithyPaddlePrices: PithyPaddlePrices }).pithyPaddlePrices = {
  quotes: mountPrices(document, document.currentScript),
};
