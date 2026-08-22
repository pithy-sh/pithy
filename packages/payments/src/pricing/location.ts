// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Where a price quote's location comes from, decided in one place.
 *
 * **A customer is charged from their billing address.** Paddle settles tax on the transaction's address,
 * not on where the browser happened to be — so the browser's IP is a *provisional estimate* and the
 * address on file is the authority. Both are legitimate answers; which one a screen got is a fact the
 * screen has to be able to state, because one of them is what the card will be charged and the other is
 * a guess that resolves at checkout.
 *
 * That is the whole of this module. It takes what a caller knows about a visitor, picks the best source
 * available, and says which one it picked. Nothing here fetches, renders, or formats.
 *
 * **One resolver, not a decision at each call site.** A pricing screen, a paywall and a cart all have to
 * answer "where does this person live", and three answers is how a page quotes from an address the
 * checkout does not charge from. Every site that derives a location for a Paddle price quote calls
 * {@link resolvePriceLocation}, and the honesty label comes off the same object.
 *
 * **No imports, deliberately.** This compiles inside the Worker's program *and* inside an adopter's
 * DOM-typed browser program — `../client/api.ts` explains at length why those are two programs — so it
 * names its own shapes rather than reaching for Zod, for core's codecs, or for Paddle's types. The
 * scaffolded pricing screen hands {@link priceQueryFor}'s answer straight to `usePricePreview`, so
 * TypeScript pins the shape against the real `PaddlePriceQuery` at the one place it matters.
 *
 * **No price, no currency, no country table.** Figures come from Paddle, rendered by Paddle. Nothing in
 * this file knows what anything costs, and nothing in it may learn: a table of amounts here would be
 * wrong in every country it did not list and wrong silently in the ones it did.
 */

/**
 * Where a quote's location came from, in order of authority.
 *
 * - `customer` — a Paddle customer id. Paddle prices from the address it holds for them, which is the
 *   address the checkout charges. The best answer there is, and the only one that is not a guess.
 * - `address` — a billing address the caller holds but Paddle does not yet. Better than the network,
 *   still not proof of what the checkout will settle on, because the buyer may enter another.
 * - `ip` — nobody said. Paddle resolves the country from the browser's own IP. Right for a marketing
 *   page a stranger is reading, and an estimate every time.
 */
export type PriceLocationSource = "customer" | "address" | "ip";

/** A billing address, as far as a price quote cares about one. */
export interface PriceAddress {
  /** ISO 3166-1 alpha-2 — `"US"`, `"GB"`, `"JP"`. Paddle takes it verbatim. */
  countryCode: string;
  /**
   * The postal code, where the caller has one.
   *
   * Load-bearing rather than decorative. United States tax resolves below the country — 15% in Chicago,
   * 8.875% in New York, 0% in Oregon — and Paddle answers a country-only request with 0% rather than
   * with an error, so a quote without one can be short of what the card is charged.
   */
  postalCode?: string;
}

/**
 * What the caller knows about this visitor. Every field optional, because "nothing" is a real answer.
 *
 * A stranger on a marketing page is `null`. A signed-in visitor whose account has never bought anything
 * carries an address and no customer. A returning customer carries the `ctm_…` the webhook path recorded
 * against them, which is the same value `POST /payments/checkout` hands Paddle as `customer_id`.
 */
export interface PriceVisitor {
  /** The Paddle customer this visitor is, or null. An identifier, not a credential. */
  customerId?: string | null;
  /** A billing address the caller holds, or null. */
  address?: PriceAddress | null;
}

/**
 * The decision: which source was used, and what to send.
 *
 * Both halves matter to a screen. The `customerId`/`address` pair is what goes to Paddle; `source` is
 * what the sentence under the figure has to be true about.
 */
export interface PriceLocation {
  /** Which source won. */
  source: PriceLocationSource;
  /** The Paddle customer to price as, or null. */
  customerId: string | null;
  /** The address to price at, or null. */
  address: PriceAddress | null;
  /**
   * Whether this location is a guess about where the buyer lives rather than the address they are
   * charged from.
   *
   * True exactly when `source` is `ip`. Kept as a field rather than left to every reader to derive,
   * because "is this provisional" is the question, and re-deriving it from the union is how a fourth
   * source arrives one day and half the readers keep answering for three.
   */
  provisional: boolean;
}

/**
 * Pick the best location available, and say which one it is.
 *
 * Precedence is authority, not convenience: a Paddle customer beats an address the caller holds, because
 * Paddle prices the customer from the address it will actually charge — and if the two disagree, a
 * traveler or a VPN, the billing address wins for what they are charged, so it wins for what they are
 * shown.
 *
 * **Never a silent default.** `null`, `undefined`, an empty customer id and an address with no country
 * all resolve to `ip` *and say so*, so a caller that meant to pass something and passed nothing gets an
 * estimate labeled as one rather than a guess wearing the authority of an address.
 */
export function resolvePriceLocation(visitor: PriceVisitor | null | undefined): PriceLocation {
  const customerId = visitor?.customerId;
  if (typeof customerId === "string" && customerId.length > 0) {
    return { source: "customer", customerId, address: null, provisional: false };
  }
  const address = visitor?.address;
  if (address && typeof address.countryCode === "string" && address.countryCode.length > 0) {
    // Rebuilt rather than passed through, so an empty postal code — the shape an unfilled form field
    // arrives in — does not reach Paddle as though somebody had typed one.
    const postalCode =
      typeof address.postalCode === "string" && address.postalCode.length > 0 ? address.postalCode : undefined;
    return {
      source: "address",
      customerId: null,
      address:
        postalCode === undefined
          ? { countryCode: address.countryCode }
          : { countryCode: address.countryCode, postalCode },
      provisional: false,
    };
  }
  return { source: "ip", customerId: null, address: null, provisional: true };
}

/** One line of a price request: what to quote, and how many. */
export interface PriceQuoteItem {
  /** The Paddle price — `pri_…`. */
  priceId: string;
  /** How many units. */
  quantity: number;
}

/**
 * What to ask Paddle, for these items at this location.
 *
 * Structurally a `PaddlePriceQuery`, and deliberately not typed as one — see this module's header. The
 * absent fields are absent rather than `undefined`-valued: `priceQueryKey` serializes the query into an
 * effect dependency, and a key that changed shape between "no address" and "an address of undefined"
 * would re-quote a page that asked the same question twice.
 */
export function priceQueryFor(
  items: readonly PriceQuoteItem[],
  location: PriceLocation,
): { items: readonly PriceQuoteItem[]; customerId?: string; address?: PriceAddress } {
  if (location.customerId !== null) return { items, customerId: location.customerId };
  if (location.address !== null) return { items, address: location.address };
  return { items };
}

/**
 * Whether the figure has to be labeled an estimate.
 *
 * Two independent reasons, and either one is enough:
 *
 * **The location is provisional.** An IP says where a browser connected from, not where a card is
 * registered. The buyer enters a billing address at the card form and the total settles then — which is
 * how commerce works everywhere, and is expected rather than a broken promise, *provided the figure said
 * it was an estimate first*.
 *
 * **The tax is not fully resolved.** `priceSummary().estimated` is true when Paddle resolved no postal
 * code, and United States tax lives below the country. Pass it in; this is where the two facts meet.
 *
 * Deriving the label from the postal code alone made it right by accident — Paddle resolves no postal
 * code from an IP today — and an accident is not a rule. This states the rule.
 */
export function quoteIsEstimated(location: PriceLocation, taxUnresolved: boolean): boolean {
  return location.provisional || taxUnresolved;
}
