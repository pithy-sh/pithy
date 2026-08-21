// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsResult } from "./api";
import {
  type PaddleOptions,
  type PaddlePriceQuery,
  type PaddleSetup,
  type PriceSummaryOptions,
  previewPrices,
  priceSummary,
} from "./paddle";

/**
 * One quote per named plan — the whole of what two Pithy surfaces share.
 *
 * The marketing site at `pithy.sh/pricing` and the dashboard both quote the same plans from the same
 * Paddle account, and each once carried its own copy of the twelve lines that do it. One of those copies
 * was wrong for months: `#416` read `currencyCode` and `details` off the top of `PricePreview()`'s answer
 * when they live under `data`, so the reader refused every real response — and because a refusal is
 * deliberately not an error, the screen rendered an empty price slot that looked deliberate. It was the
 * *reviewed* copy that was wrong. The hand-written one on the marketing site had it right the whole time.
 * Nothing could tell, because there was nothing that both of them ran.
 *
 * This is that thing. It goes through {@link previewPrices}, so it goes through `readPricePreview`, so
 * the `#416` class of defect has exactly one place left it can exist.
 *
 * **What it deliberately does not do** is the reason it can be shared at all. It does not choose the
 * account — the marketing site decides from the hostname at request time and the dashboard decides from
 * `CLOUDFLARE_ENV` at build time, and both are right for their surface. It does not name a price id —
 * the marketing site holds literals per account and the dashboard has a gate saying only one file in the
 * Worker may name one. It does not cache — the dashboard forbids `localStorage` in a client module
 * outright. And it does not paint: marketing writes text nodes, the dashboard renders React from the
 * same answer. Given an account and a set of price ids, hand back a formatted total per plan. Everything
 * above that stays with whoever is rendering.
 */

/** Plan name to the Paddle price — `pri_…` — that quotes it. */
export type PaddlePlanPrices = Readonly<Record<string, string>>;

/**
 * Who the quote is for, and where — every part of a `PricePreview` query but the prices themselves.
 *
 * **A quote must resolve from the same Paddle row the charge will.** Omitted, Paddle resolves location
 * from the browser's IP, which is right for a stranger reading a marketing page and wrong for everybody
 * who has signed in: a customer with an address on file is quoted from whatever network they happen to
 * be on, and `priceSummary` marks the figure `estimated` because no postal code resolved. Pass
 * `customerId` and Paddle prices them from the address `POST /payments/checkout` will bill.
 *
 * Derived from {@link PaddlePriceQuery} rather than restated, so a field Paddle adds arrives here with
 * it. `items` is the one part {@link quotePlans} owns — it is the plans, and there is one source of it.
 */
export type PaddleQuoteQuery = Omit<PaddlePriceQuery, "items">;

/** What {@link quotePlans} lets a caller replace, plus who the quote is for. */
export interface PaddleQuoteOptions extends PaddleOptions, PriceSummaryOptions {
  /** Who to quote for, and where they are. Omitted, Paddle resolves it from the visitor's IP. */
  readonly query?: PaddleQuoteQuery;
}

/** What one plan costs this visitor, ready to render. */
export interface PaddlePlanQuote {
  /** The plan this quotes, as the caller named it. */
  readonly plan: string;
  /** The Paddle price it resolved to. */
  readonly priceId: string;
  /**
   * The figure to show, already formatted by Paddle for this visitor.
   *
   * Per unit, and not the same field in every country: where tax is added on top the listed price is the
   * subtotal, and where it is taken out of an inclusive figure the listed price is the total. See
   * {@link priceSummary}, which is where that decision is made and tested.
   *
   * Paddle's own string, unless the caller passed `wholeUnits` — the one thing that ever changes it, and
   * only by removing a fraction that is entirely zero.
   */
  readonly headline: string;
  /** One sentence about tax, or null where there is nothing true to say. */
  readonly note: string | null;
  /** Whether the tax in this quote may be short of what the buyer is charged. */
  readonly estimated: boolean;
  /**
   * The ISO-4217 currency Paddle answered in — `"USD"`, `"JPY"`.
   *
   * {@link headline} is already formatted, so nothing here needs this to render. A caller that formats
   * the figure itself does, and this is the only place it exists: `PriceSummary` carries no currency, so
   * a caller reading only the quote had `preview.currencyCode` held one layer down and dropped.
   */
  readonly currency: string;
}

/**
 * Quote every named plan, or refuse.
 *
 * One `PricePreview` call for the whole set, because it is one round trip and Paddle answers a line per
 * item. A plan Paddle returned no line for is left out rather than quoted from another plan's line — the
 * caller sees a plan missing, which its own markup already has a sentence for, instead of two plans
 * showing one price.
 *
 * **No plans means no network.** An unconfigured page must cost a visitor nothing, and `PricePreview`
 * with an empty `items` is a request Paddle refuses anyway.
 *
 * **One price is asked for once, however many plans name it.** A pricing table with a highlighted row
 * points two plans at one price often enough; asking for it twice is redundant at best, and whether
 * Paddle tolerates a repeated `priceId` is not a thing to find out in production — a refusal there takes
 * the whole table down to its placeholders, not just the duplicated row. Both plans still resolve, off
 * the one line, because a plan is matched to its line by id.
 */
export async function quotePlans(
  setup: PaddleSetup,
  plans: PaddlePlanPrices,
  options?: PaddleQuoteOptions,
): Promise<PaymentsResult<readonly PaddlePlanQuote[]>> {
  const named = Object.entries(plans);
  if (named.length === 0) return { ok: true, value: [] };

  const asked = [...new Set(named.map(([, priceId]) => priceId))];
  // The caller's half of the query first and `items` last, so a query naming items — which TypeScript
  // forbids and a caller compiled from JavaScript is not asking TypeScript about — cannot quietly replace
  // the prices the plans named.
  const preview = await previewPrices(
    setup,
    { ...options?.query, items: asked.map((priceId) => ({ priceId, quantity: 1 })) },
    options,
  );
  if (!preview.ok) return preview;

  const quotes: PaddlePlanQuote[] = [];
  for (const [plan, priceId] of named) {
    const line = preview.value.lines.find((candidate) => candidate.priceId === priceId);
    if (line === undefined) continue;
    const summary = priceSummary(preview.value, line, { wholeUnits: options?.wholeUnits });
    quotes.push({
      plan,
      priceId,
      headline: summary.headline,
      note: summary.note,
      estimated: summary.estimated,
      currency: preview.value.currencyCode,
    });
  }
  return { ok: true, value: quotes };
}
