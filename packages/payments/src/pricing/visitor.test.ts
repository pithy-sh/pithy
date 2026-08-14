// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsPricingEnvelope } from "../http/responses";
import { fetchPriceVisitor, type PriceVisitorFetch, readPaddleCustomer } from "./visitor";

/**
 * The trust boundary between a browser and the adopter's own Worker.
 *
 * The response is JSON off a network, and a reader that trusted it would put `undefined` into a Paddle
 * price request and a price nobody can read on the page. Everything below is a malformed, hostile or
 * absent answer, and the required behaviour is the same for all of them: `null`, which resolves to the
 * IP location and renders the figure labelled an estimate. **Failing to an honest guess is the safe
 * direction; the unsafe one is reading a failed request as proof there is no address on file.**
 */

/** A fetch answering one body with one status, recording what it was asked. */
function stubFetch(body: unknown, ok = true): { fetch: PriceVisitorFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (input, init) => {
      urls.push(input);
      expect(init.credentials, "the session rides a cookie; a request without it is signed out").toBe("include");
      return Promise.resolve({ ok, json: () => Promise.resolve(body) });
    },
  };
}

/** What the route answers a customer with. Parsed by the server's own schema, so it cannot drift. */
const WITH_CUSTOMER = PaymentsPricingEnvelope.parse({
  pricing: null,
  quotedFrom: { rail: "paddle", providerAccountId: "ctm_01hv8wptq8987qeep44cyrewp9" },
});

describe("readPaddleCustomer", () => {
  test("reads the customer off the envelope the route actually returns", () => {
    expect(readPaddleCustomer(WITH_CUSTOMER)).toBe("ctm_01hv8wptq8987qeep44cyrewp9");
  });

  test("a caller with no store customer reads as nobody", () => {
    expect(readPaddleCustomer(PaymentsPricingEnvelope.parse({ pricing: null, quotedFrom: null }))).toBeNull();
  });

  test("nothing malformed, hostile or absent gets through", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      "ctm_01hv8wptq8987qeep44cyrewp9",
      42,
      [],
      {},
      // An older Worker than this bundle: the field does not exist yet.
      { pricing: null },
      // The shapes a broken or malicious answer arrives in.
      { quotedFrom: { rail: "paddle" } },
      { quotedFrom: { rail: "paddle", providerAccountId: "" } },
      { quotedFrom: { rail: "paddle", providerAccountId: 42 } },
      { quotedFrom: { rail: "paddle", providerAccountId: { toString: () => "ctm_x" } } },
      { quotedFrom: ["paddle", "ctm_x"] },
      // A rail this reader does not price with. Paddle is the one that quotes in a browser.
      { quotedFrom: { rail: "stripe", providerAccountId: "cus_123" } },
    ];
    for (const body of hostile) expect(readPaddleCustomer(body), JSON.stringify(body) ?? "undefined").toBeNull();
  });
});

describe("fetchPriceVisitor", () => {
  test("asks this project's own pricing route, with the session cookie", async () => {
    const stub = stubFetch(WITH_CUSTOMER);
    expect(await fetchPriceVisitor({ fetch: stub.fetch })).toEqual({
      customerId: "ctm_01hv8wptq8987qeep44cyrewp9",
    });
    expect(stub.urls).toEqual(["/payments/pricing"]);
  });

  test("follows a project that moved its routes", async () => {
    const stub = stubFetch(WITH_CUSTOMER);
    await fetchPriceVisitor({ fetch: stub.fetch, basePath: "/billing" });
    expect(stub.urls).toEqual(["/billing/pricing"]);
  });

  test("a refusal is not an answer, and reads as nobody", async () => {
    expect(await fetchPriceVisitor({ fetch: stubFetch(WITH_CUSTOMER, false).fetch })).toBeNull();
  });

  test("a body that will not parse reads as nobody rather than crashing the pane", async () => {
    // A corporate proxy's HTML error page reaches a browser far more often than anyone expects.
    const throwing: PriceVisitorFetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error("Unexpected token < in JSON at position 0")),
      });
    expect(await fetchPriceVisitor({ fetch: throwing })).toBeNull();
  });

  test("an unreachable Worker reads as nobody rather than throwing", async () => {
    const refused: PriceVisitorFetch = () => Promise.reject(new Error("Failed to fetch"));
    expect(await fetchPriceVisitor({ fetch: refused })).toBeNull();
  });

  test("no fetch at all — a server render — reads as nobody", async () => {
    const global = globalThis as { fetch?: unknown };
    const held = global.fetch;
    global.fetch = undefined;
    try {
      expect(await fetchPriceVisitor()).toBeNull();
    } finally {
      global.fetch = held;
    }
  });
});
