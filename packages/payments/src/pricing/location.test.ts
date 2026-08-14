// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type PriceVisitor, priceQueryFor, quoteIsEstimated, resolvePriceLocation } from "./location";

/**
 * The one resolver, held to the rule it exists to state: a customer is charged from their billing
 * address, so the browser's IP is an estimate and has to say so.
 *
 * The cases that matter are the ones where a caller *nearly* knows something — an empty customer id, an
 * address with no country, a postal code that is the empty string a blank form field produces. Each is
 * "nothing known" wearing the shape of an answer, and each has to resolve to the IP and be labelled.
 */

/** One line, so the query cases are about location and never about what is being priced. */
const ITEMS = [{ priceId: "pri_01kzvyz9e21z9vbhd7xqq3csyh", quantity: 1 }];

describe("resolvePriceLocation", () => {
  test("a Paddle customer is the authority, and is not provisional", () => {
    expect(resolvePriceLocation({ customerId: "ctm_01hv8wptq8987qeep44cyrewp9" })).toEqual({
      source: "customer",
      customerId: "ctm_01hv8wptq8987qeep44cyrewp9",
      address: null,
      provisional: false,
    });
  });

  test("a customer beats an address the caller also holds", () => {
    // A traveller, or a VPN, or an address the app collected before the purchase. Paddle charges the
    // address it holds against the customer, so that is what the screen must quote.
    const both: PriceVisitor = {
      customerId: "ctm_01hv8wptq8987qeep44cyrewp9",
      address: { countryCode: "US", postalCode: "10001" },
    };
    expect(resolvePriceLocation(both).source).toBe("customer");
    expect(resolvePriceLocation(both).address).toBeNull();
  });

  test("an address is used when there is no customer yet", () => {
    expect(resolvePriceLocation({ address: { countryCode: "GB", postalCode: "SW1A 1AA" } })).toEqual({
      source: "address",
      customerId: null,
      address: { countryCode: "GB", postalCode: "SW1A 1AA" },
      provisional: false,
    });
  });

  test("an address with no postal code carries none, rather than an empty one", () => {
    // Paddle answers a country-only request with `postalCode: ""`. Sending one *in* would be claiming a
    // precision nobody has, and `priceQueryKey` would treat two spellings of nothing as two questions.
    expect(resolvePriceLocation({ address: { countryCode: "DE", postalCode: "" } }).address).toEqual({
      countryCode: "DE",
    });
    expect(resolvePriceLocation({ address: { countryCode: "DE" } }).address).toEqual({ countryCode: "DE" });
  });

  test("nothing known is the IP, and says it is provisional", () => {
    for (const visitor of [null, undefined, {}, { customerId: null }, { address: null }] as const) {
      expect(resolvePriceLocation(visitor)).toEqual({
        source: "ip",
        customerId: null,
        address: null,
        provisional: true,
      });
    }
  });

  test("an answer-shaped nothing is still nothing", () => {
    // An empty string is what a cleared field and an unset column both arrive as. Passing one to Paddle
    // as a customer id would be a refused request; treating one as an address would be worse, because it
    // would wear the authority of an address while naming no country.
    expect(resolvePriceLocation({ customerId: "" }).source).toBe("ip");
    expect(resolvePriceLocation({ address: { countryCode: "" } }).source).toBe("ip");
    expect(resolvePriceLocation({ customerId: "", address: { countryCode: "" } }).provisional).toBe(true);
  });
});

describe("priceQueryFor", () => {
  test("a customer is asked about by id, and no address is sent beside it", () => {
    const query = priceQueryFor(ITEMS, resolvePriceLocation({ customerId: "ctm_01hv8wptq8987qeep44cyrewp9" }));
    expect(query).toEqual({ items: ITEMS, customerId: "ctm_01hv8wptq8987qeep44cyrewp9" });
  });

  test("an address is sent as an address", () => {
    const query = priceQueryFor(ITEMS, resolvePriceLocation({ address: { countryCode: "JP" } }));
    expect(query).toEqual({ items: ITEMS, address: { countryCode: "JP" } });
  });

  test("the IP query names neither, and names them by absence rather than by undefined", () => {
    // `priceQueryKey` serializes the query into an effect dependency. `{ customerId: undefined }` and a
    // query with no such key are the same question, and a screen must not re-quote between them.
    const query = priceQueryFor(ITEMS, resolvePriceLocation(null));
    expect(query).toEqual({ items: ITEMS });
    expect(Object.keys(query)).toEqual(["items"]);
  });

  test("nothing here invents a price, a currency or a country", () => {
    // The query carries what the caller knew and the items it was given. A default country would be a
    // price for somewhere the visitor does not live, chosen by whoever typed it.
    const serialized = JSON.stringify(priceQueryFor(ITEMS, resolvePriceLocation(null)));
    expect(serialized).not.toMatch(/[$€£¥]/);
    expect(serialized).toBe(JSON.stringify({ items: ITEMS }));
  });
});

describe("quoteIsEstimated", () => {
  test("an IP-derived figure is an estimate however well the tax resolved", () => {
    // The case the old rule got wrong. `taxUnresolved` false means Paddle returned a postal code; it
    // does not mean the buyer lives there. The charge settles on a billing address nobody has given yet.
    expect(quoteIsEstimated(resolvePriceLocation(null), false)).toBe(true);
  });

  test("an unresolved tax is an estimate however well the location is known", () => {
    // United States tax lives below the country, and Paddle answers a country-only request with 0%.
    expect(quoteIsEstimated(resolvePriceLocation({ address: { countryCode: "US" } }), true)).toBe(true);
  });

  test("a known location with resolved tax is not an estimate, or the label means nothing", () => {
    expect(quoteIsEstimated(resolvePriceLocation({ address: { countryCode: "US", postalCode: "10001" } }), false)).toBe(
      false,
    );
    expect(quoteIsEstimated(resolvePriceLocation({ customerId: "ctm_01hv8wptq8987qeep44cyrewp9" }), false)).toBe(false);
  });
});
