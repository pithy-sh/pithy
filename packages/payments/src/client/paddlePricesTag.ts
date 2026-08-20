// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsFailure, PaymentsResult } from "./api";
import type { PaddleOptions, PaddleSetup } from "./paddle";
import { type PaddlePlanPrices, type PaddlePlanQuote, quotePlans } from "./paddlePrices";

/**
 * The script tag as configuration, for a site with no build step.
 *
 * A static site loads one classic script and gets prices. It cannot import a module, it has no bundler,
 * and it must not carry a price id in its markup — an id belongs to one Paddle account, so it is
 * environment-specific and a page that names one is a page that quotes the wrong account the day the
 * account changes. So the ids arrive on the tag, where whoever deploys the site puts them, and the page
 * itself names only plans.
 */

/** The tag names no account, or is still carrying the placeholders it was scaffolded with. */
export const PADDLE_PRICES_NOT_CONFIGURED: PaymentsFailure = {
  code: "client/paddle_prices_not_configured",
  message: "Prices aren't available right now.",
  action:
    "Set data-paddle-env, data-paddle-token and every data-paddle-price-<name> id on the paddle-prices script tag.",
};

/** The slice of a script element this reads, declared structurally for the reason `./checkout` gives. */
export interface PaddlePricesTag {
  /** Every attribute on the tag, so the `data-paddle-price-*` set can be enumerated rather than guessed. */
  getAttributeNames(): readonly string[];
  /** One attribute's value, or null. */
  getAttribute(name: string): string | null;
}

/** What a configured tag says. */
export interface PaddlePricesTagConfig {
  /** Which Paddle account answers, and with which publishable token. */
  readonly setup: PaddleSetup;
  /** Plan name to price id, one entry per `data-paddle-price-*` attribute. */
  readonly plans: PaddlePlanPrices;
  /** Whether to write the totals into the page, or only to hand them to whoever asked. */
  readonly paint: boolean;
}

/** The prefix that marks an attribute as naming a plan. */
const PRICE_PREFIX = "data-paddle-price-";

/** The token prefix each Paddle account issues. Sandbox and live are separate accounts, not a flag. */
const CLIENT_TOKEN: Readonly<Record<PaddleSetup["environment"], string>> = {
  sandbox: "test_",
  production: "live_",
};

/** A real Paddle price. */
const PRICE_ID = /^pri_/;

/**
 * Read a tag's configuration, or refuse it.
 *
 * **Refusal is the whole point of this function, and it is why the shapes are checked rather than
 * trusted.** A site is deployed with the placeholders still in it far more often than anyone plans to:
 * the live account is opened weeks after the sandbox one, and the tag ships carrying
 * `REPLACE_WITH_LIVE_CLIENT_TOKEN` in the meantime. Handing that to Paddle produces a refused
 * initialization, a console warning nobody is watching, and — because a page that has already blanked
 * its own sentence has nothing left to fall back to — an empty price slot that looks deliberate. That is
 * `#416` arriving by a second road.
 *
 * So an unconfigured tag is not an error and not a quote. It is null, and a null tag paints nothing, so
 * the sentence the page shipped with is still standing. **All or nothing across the plans**: one plan
 * still on a placeholder refuses the tag rather than quoting the others, because a pricing table with
 * one real figure and one placeholder is the version a reader believes.
 *
 * **The token is checked against the environment beside it, not merely for a prefix.** The half-updated
 * deploy above has a second shape: the environment is switched to `production` and the token below it is
 * still the sandbox one. Paddle refuses that pairing itself, eventually — after the page has fetched
 * Paddle.js and spent a round trip finding out. Refusing it here is what makes "no request" true of
 * every misconfigured tag rather than of most of them.
 */
export function readPaddlePricesTag(tag: PaddlePricesTag | null): PaddlePricesTagConfig | null {
  if (tag === null) return null;
  const environment = tag.getAttribute("data-paddle-env");
  if (environment !== "sandbox" && environment !== "production") return null;
  const clientToken = tag.getAttribute("data-paddle-token");
  if (clientToken === null || !clientToken.startsWith(CLIENT_TOKEN[environment])) return null;

  const plans: Record<string, string> = {};
  for (const name of tag.getAttributeNames()) {
    if (!name.startsWith(PRICE_PREFIX)) continue;
    const priceId = tag.getAttribute(name);
    if (priceId === null || !PRICE_ID.test(priceId)) return null;
    plans[name.slice(PRICE_PREFIX.length)] = priceId;
  }
  if (Object.keys(plans).length === 0) return null;

  return { setup: { clientToken, environment }, plans, paint: tag.getAttribute("data-paddle-paint") !== "off" };
}

/** The slice of a plan slot this writes. */
export interface PricesPlanNode {
  /** Which plan the slot is for. */
  getAttribute(name: string): string | null;
  /** The sentence in the slot — the page's own until a quote replaces it. */
  textContent: string | null;
}

/** The slice of `document` this reaches, as an injectable seam. */
export interface PricesDocument {
  /** Whether the page is still being parsed, so the slots to paint may not all exist yet. */
  readyState: string;
  /** How the paint waits for the rest of the page. */
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  /** Every plan slot on the page. */
  querySelectorAll(selectors: string): ArrayLike<PricesPlanNode>;
}

/** The attribute a page marks a plan slot with. */
const PLAN_SLOT = "data-price-plan";

/** The attribute a page marks the sentence beside a figure with. */
const NOTE_SLOT = "data-price-note";

/**
 * Match a plan named on the tag to a plan named in the markup.
 *
 * Case-insensitively, and that is forced rather than lenient. A plan arrives on the tag as part of an
 * *attribute name* — `data-paddle-price-teamPlus` — and HTML lower-cases those, so the tag can only ever say
 * `teamplus`. In the markup the same plan is an attribute *value*, `data-price-plan="teamPlus"`, which
 * keeps its case. Matching exactly would leave that slot on its placeholder with nothing anywhere saying
 * why.
 */
function samePlan(named: string | null, quoted: string): boolean {
  return named !== null && named.toLowerCase() === quoted.toLowerCase();
}

/**
 * Write each quote into the slot that named its plan, and the sentence that makes it true beside it.
 *
 * **The headline alone is not the price, and a page that shows only the headline is the defect the quote
 * path exists to avoid.** Where tax is added on top — the United States convention — the headline is the
 * subtotal and the buyer is charged more; where no postal code resolved, Paddle returns 0% tax and the
 * card is charged up to 15% above the figure. `priceSummary` returns a sentence for each of those cases,
 * and this puts it in `[data-price-note="<plan>"]`. A page quoting a tax-added price wants that slot.
 *
 * **A slot no quote names is left exactly as it was**, and so is a note slot for a quote with nothing to
 * say. A pricing page ships a true sentence in every slot — "Priced where you are billed" — precisely so
 * that a plan which cannot be quoted still says something honest. Blanking it, or writing `undefined`
 * into it, replaces a true sentence with a worse one; leaving it is the whole reason it is there.
 */
export function paintPlanQuotes(document: PricesDocument, quotes: readonly PaddlePlanQuote[]): void {
  // `Array.from` because the seam is an `ArrayLike` — a `NodeList` in a browser, and something else in a
  // test — and indexing one is where an off-by-one would live.
  for (const slot of Array.from(document.querySelectorAll(`[${PLAN_SLOT}]`))) {
    const quote = quotes.find((candidate) => samePlan(slot.getAttribute(PLAN_SLOT), candidate.plan));
    if (quote === undefined) continue;
    slot.textContent = quote.headline;
  }
  for (const slot of Array.from(document.querySelectorAll(`[${NOTE_SLOT}]`))) {
    const quote = quotes.find((candidate) => samePlan(slot.getAttribute(NOTE_SLOT), candidate.plan));
    if (quote === undefined || quote.note === null) continue;
    slot.textContent = quote.note;
  }
}

/** Resolve once the page has the slots this paints into. */
function parsed(document: PricesDocument): Promise<void> {
  if (document.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

/**
 * Read the tag, quote its plans, and — unless the page said it paints itself — put the figures on it.
 *
 * The one entry point the browser build calls, and the one place the three halves meet: configuration
 * off the tag, the quote from `./prices`, and the page. It answers with the result rather than swallowing
 * it, so a page that keeps its own cache and its own formatting can have the same answer this painted.
 */
export async function mountPrices(
  document: PricesDocument,
  tag: PaddlePricesTag | null,
  options?: PaddleOptions,
): Promise<PaymentsResult<readonly PaddlePlanQuote[]>> {
  const config = readPaddlePricesTag(tag);
  if (config === null) return { ok: false, failure: PADDLE_PRICES_NOT_CONFIGURED };

  const quoted = await quotePlans(config.setup, config.plans, options);
  if (!quoted.ok || !config.paint) return quoted;
  // **The quote starts immediately and the paint waits.** A third-party tag's usual home is `<head>`,
  // where nothing it paints into has been parsed yet — so a paint that ran the moment Paddle answered
  // would find some of the page's slots, or none, and leave the rest on their placeholders for good.
  // Starting the round trip early is the reason to load early; only the writing has to wait.
  await parsed(document);
  paintPlanQuotes(document, quoted.value);
  return quoted;
}
