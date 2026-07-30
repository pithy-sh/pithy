// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll, describe, expect, test } from "vitest";
import {
  PaymentsInvalidReceiptError,
  PaymentsProviderUnavailableError,
  PaymentsVerificationFailedError,
} from "../../error/errors";
import type { PaymentsGoogleCredentials } from "../../secret/registry";
import playProduct from "./fixtures/play-product-purchased.json" with { type: "json" };
import playSubscription from "./fixtures/play-subscription-active.json" with { type: "json" };
import { mintServiceAccountKey } from "./fixtures/push";
import type { GoogleHttpFetch } from "./http";
import { GOOGLE_TOKEN_URL } from "./playApi";
import { verifyGooglePurchase } from "./verify";

/**
 * The client-submission path. What matters here is that **nothing the client said is believed**: the purchase
 * token is looked up at Google, and the product id it declared is only a path segment Google either confirms by
 * answering or refuses by 404. That is what stops a caller presenting a cheap token as an expensive product.
 */

const PACKAGE = "com.acme.app";
const NOW = new Date("2026-01-15T00:00:00.000Z");
const TOKEN = "gjdmnbkpaifcmlkgomhnpjbi.AO-J1OwXn3rM5pQe7vT2yLb0dK";

let credentials: PaymentsGoogleCredentials;

beforeAll(async () => {
  const key = await mintServiceAccountKey();
  credentials = {
    packageName: PACKAGE,
    serviceAccountEmail: "pithy-play@acme-42.iam.gserviceaccount.com",
    privateKey: key.pem,
    pubsubAudience: "https://acme.example/payments/webhooks/google",
  };
});

/**
 * A transport that answers the subscription endpoint and the products endpoint independently, so a test says
 * which lookup Play knows about rather than which one ran.
 */
function playAnswering(
  answers: { subscription?: unknown; product?: unknown; status?: number },
  seen: string[] = [],
): GoogleHttpFetch {
  return async (url) => {
    seen.push(url);
    if (url === GOOGLE_TOKEN_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "t" }) };
    }
    if (answers.status !== undefined) {
      return { ok: false, status: answers.status, text: async () => "{}" };
    }
    const body = url.includes("/subscriptionsv2/") ? answers.subscription : answers.product;
    if (body === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

const verify = (receipt: unknown, transport: GoogleHttpFetch) =>
  verifyGooglePurchase(typeof receipt === "string" ? receipt : JSON.stringify(receipt), {
    credentials,
    now: NOW,
    transport,
  });

/** What Play Billing's `Purchase.getOriginalJson()` hands an app, trimmed to what is read. */
const originalJson = (overrides: Record<string, unknown> = {}) => ({
  orderId: "GPA.3311-8452-9910-77301..0",
  packageName: PACKAGE,
  productId: "pro_monthly",
  purchaseTime: 1767225600000,
  purchaseState: 0,
  purchaseToken: TOKEN,
  quantity: 1,
  acknowledged: false,
  ...overrides,
});

describe("verifyGooglePurchase", () => {
  test("verifies a subscription through the token alone", async () => {
    const verified = await verify(originalJson(), playAnswering({ subscription: playSubscription }));
    expect(verified.event).toMatchObject({
      rail: "google",
      providerTransactionId: "GPA.3311-8452-9910-77301..0",
      providerProductId: "pro_monthly",
      status: "active",
      environment: "production",
    });
    expect(verified.providerAccountId).toBe("b7e1c94f2a6d4c0e");
  });

  test("probes the subscription endpoint first, and only then the product one", async () => {
    // Play has no "what kind of purchase is this token" call. The subscription lookup takes a token alone, so it
    // is the one that can answer without believing anything the client said.
    const seen: string[] = [];
    await verify(originalJson({ productId: "coins_100" }), playAnswering({ product: playProduct }, seen));
    const lookups = seen.filter((url) => url !== GOOGLE_TOKEN_URL);
    expect(lookups[0]).toContain("/subscriptionsv2/tokens/");
    expect(lookups[1]).toContain("/products/coins_100/tokens/");
  });

  test("verifies a one-time purchase through the product lookup", async () => {
    const verified = await verify(originalJson({ productId: "coins_100" }), playAnswering({ product: playProduct }));
    expect(verified.event).toMatchObject({
      providerTransactionId: "GPA.3311-8452-9910-77304",
      providerProductId: "coins_100",
      status: "active",
      expiresAt: null,
    });
  });

  test("accepts the `productIds` array newer Play Billing versions emit", async () => {
    // Play Billing 5 replaced `productId` with a list. Both shapes are in the wild, and which one arrives depends
    // on the app's library version rather than on anything a server can control.
    const { productId: _replaced, ...receipt } = originalJson();
    const verified = await verify({ ...receipt, productIds: ["coins_100"] }, playAnswering({ product: playProduct }));
    expect(verified.event.providerProductId).toBe("coins_100");
  });

  test("a product id the token does not belong to is refused by Google, not believed here", async () => {
    // The escalation this design exists to close. The client declares the product; Play answers 404 because the
    // token is not for it; the submission fails. A server that trusted the declared id would have projected an
    // expensive product against a cheap purchase.
    const seen: string[] = [];
    const thrown = await catchError(() => verify(originalJson({ productId: "pro_annual" }), playAnswering({}, seen)));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(seen.some((url) => url.includes("/products/pro_annual/tokens/"))).toBe(true);
  });

  test("a token Play has no record of at all is refused", async () => {
    const thrown = await catchError(() => verify(originalJson(), playAnswering({})));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.status).toBe(400);
  });

  test("a receipt naming no product cannot be probed for a one-time purchase, and says so", async () => {
    const { productId: _omitted, ...receipt } = originalJson();
    const thrown = await catchError(() => verify(receipt, playAnswering({})));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("product id");
  });

  test("a receipt with no purchase token is unreadable", async () => {
    const { purchaseToken: _omitted, ...receipt } = originalJson();
    await expect(verify(receipt, playAnswering({}))).rejects.toBeInstanceOf(PaymentsInvalidReceiptError);
  });

  test("a receipt that is not JSON is unreadable", async () => {
    await expect(verify("not-json", playAnswering({}))).rejects.toBeInstanceOf(PaymentsInvalidReceiptError);
  });

  test("a receipt that is a JSON array is unreadable", async () => {
    await expect(verify([TOKEN], playAnswering({}))).rejects.toBeInstanceOf(PaymentsInvalidReceiptError);
  });

  test("an unreachable Play API is provider_unavailable, so the buyer may retry", async () => {
    // Distinct from a refusal on purpose: a 400 tells a client its purchase is bad, and a 503 tells it to come
    // back. Getting this wrong on a Play outage would tell every buyer their receipt was invalid.
    await expect(verify(originalJson(), playAnswering({ status: 503 }))).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });

  test("the event time is this server's clock, because Play reports none", async () => {
    // A client submission is a read of the current state, so treating it as the freshest fact is right. There is
    // no provider timestamp on a Play purchase to prefer.
    const verified = await verify(originalJson(), playAnswering({ subscription: playSubscription }));
    expect(verified.event.providerEventAt).toEqual(NOW);
  });

  test("no refusal echoes the purchase token", async () => {
    // A purchase token is the whole credential for reading a purchase out of Play. Same rule as a receipt.
    const thrown = await catchError(() => verify(originalJson(), playAnswering({})));
    expect(JSON.stringify(thrown?.payload)).not.toContain(TOKEN);
  });

  test("nothing the client claimed about the purchase reaches the event", async () => {
    // The receipt says `purchaseState: 0` and an order id; the event's status and identity come from Play.
    const verified = await verify(
      originalJson({ productId: "coins_100", purchaseState: 0, orderId: "GPA.forged" }),
      playAnswering({ product: { ...playProduct, purchaseState: 1 } }),
    );
    expect(verified.event.status).toBe("refunded");
    expect(verified.event.providerTransactionId).toBe("GPA.3311-8452-9910-77304");
  });
});

/** The thrown `PithyError`, or undefined. */
async function catchError(run: () => Promise<unknown>): Promise<PaymentsVerificationFailedError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as PaymentsVerificationFailedError;
  }
}
