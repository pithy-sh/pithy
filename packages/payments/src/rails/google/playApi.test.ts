import { beforeAll, describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import {
  PaymentsProviderUnavailableError,
  PaymentsRailNotConfiguredError,
  PaymentsVerificationFailedError,
} from "../../error/errors";
import type { PaymentsGoogleCredentials } from "../../secret/registry";
import playProduct from "./fixtures/play-product-purchased.json" with { type: "json" };
import playSubscription from "./fixtures/play-subscription-active.json" with { type: "json" };
import { type MintedServiceAccountKey, mintServiceAccountKey } from "./fixtures/push";
import type { GoogleHttpFetch } from "./http";
import { base64UrlDecode } from "./jwt";
import {
  fetchPlayProduct,
  fetchPlaySubscription,
  GOOGLE_TOKEN_URL,
  mintPlayAccessToken,
  PLAY_API_BASE,
  PLAY_SCOPE,
  playProductEvent,
  playProductStatus,
  playSubscriptionEvent,
  playSubscriptionStatus,
  refreshPlayPurchase,
  resolvePlayPointer,
} from "./playApi";
import type { GoogleNotificationPointer } from "./rtdn";

/**
 * The follow-up call, and the mapping. Two things are worth exercising for real here: the assertion this module
 * signs is verified against the key that signed it, so "we minted a token" means Google would have accepted it;
 * and every state in Play's two vocabularies is pinned to a normalized status, because getting one wrong grants
 * or revokes access for somebody real.
 */

const PACKAGE = "com.acme.app";
const SERVICE_ACCOUNT = "pithy-play@acme-42.iam.gserviceaccount.com";
const NOW = new Date("2026-01-15T00:00:00.000Z");
const TOKEN = "gjdmnbkpaifcmlkgomhnpjbi.AO-J1OwXn3rM5pQe7vT2yLb0dK";
const ACCESS_TOKEN = "ya29.a0ARrdaM-test-access-token";

let key: MintedServiceAccountKey;
let credentials: PaymentsGoogleCredentials;

beforeAll(async () => {
  key = await mintServiceAccountKey();
  credentials = {
    packageName: PACKAGE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    privateKey: key.pem,
    pubsubAudience: "https://acme.example/payments/webhooks/google",
  };
});

/** One recorded request, so a test can assert what went out as well as what came back. */
interface Recorded {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A transport that answers the token endpoint and one purchase URL, recording everything it is asked. */
function transportFor(
  answers: { status?: number; body: unknown }[],
  seen: Recorded[] = [],
): { transport: GoogleHttpFetch; seen: Recorded[] } {
  const queue = [...answers];
  const transport: GoogleHttpFetch = async (url, init) => {
    seen.push({ url, ...init });
    if (url === GOOGLE_TOKEN_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: ACCESS_TOKEN }) };
    }
    const next = queue.shift() ?? { status: 500, body: {} };
    const status = next.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(next.body) };
  };
  return { transport, seen };
}

const options = (transport: GoogleHttpFetch, accessToken?: string) => ({
  credentials,
  now: NOW,
  transport,
  ...(accessToken === undefined ? {} : { accessToken }),
});

describe("mintPlayAccessToken", () => {
  test("signs an assertion Google would accept, and posts the JWT-bearer grant", async () => {
    const seen: Recorded[] = [];
    const { transport } = transportFor([], seen);
    expect(await mintPlayAccessToken(credentials, { now: NOW, transport })).toBe(ACCESS_TOKEN);

    const request = seen[0];
    expect(request?.url).toBe(GOOGLE_TOKEN_URL);
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });

    const form = new URLSearchParams(request?.body ?? "");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    // The assertion is verified with the public half of the key that signed it. A test that only checked the
    // shape would pass against an unsigned string.
    const assertion = form.get("assertion") ?? "";
    const [head, body, mac] = assertion.split(".");
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key.publicKey,
      base64UrlDecode(mac ?? "", "mac") as unknown as ArrayBuffer,
      new TextEncoder().encode(`${head}.${body}`) as unknown as ArrayBuffer,
    );
    expect(verified).toBe(true);

    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(head ?? "", "head")))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(body ?? "", "body")))).toEqual({
      iss: SERVICE_ACCOUNT,
      scope: PLAY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 3600,
    });
  });

  test("a key that is not PKCS#8 is a provisioning refusal, not a store outage", async () => {
    await expect(
      mintPlayAccessToken(
        { ...credentials, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nAQID\n-----END RSA PRIVATE KEY-----" },
        { now: NOW, transport: transportFor([]).transport },
      ),
    ).rejects.toBeInstanceOf(PaymentsRailNotConfiguredError);
  });

  test("a PKCS#8 body that is not a key is the same refusal", async () => {
    await expect(
      mintPlayAccessToken(
        { ...credentials, privateKey: "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----" },
        { now: NOW, transport: transportFor([]).transport },
      ),
    ).rejects.toBeInstanceOf(PaymentsRailNotConfiguredError);
  });

  test("a token endpoint that answers without a token is provider_unavailable", async () => {
    const transport: GoogleHttpFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    await expect(mintPlayAccessToken(credentials, { now: NOW, transport })).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });

  test("no refusal carries the private key", async () => {
    const thrown = await catchError(() =>
      mintPlayAccessToken(
        { ...credentials, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nSUPERSECRET\n-----END RSA PRIVATE KEY-----" },
        { now: NOW, transport: transportFor([]).transport },
      ),
    );
    expect(JSON.stringify(thrown?.payload)).not.toContain("SUPERSECRET");
  });
});

describe("fetchPlaySubscription", () => {
  test("calls the v2 subscription endpoint with a bearer token and parses the answer", async () => {
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    const purchase = await fetchPlaySubscription(TOKEN, options(transport));
    expect(purchase?.subscriptionState).toBe("SUBSCRIPTION_STATE_ACTIVE");

    const lookup = seen[1];
    expect(lookup?.url).toBe(
      `${PLAY_API_BASE}/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/${encodeURIComponent(TOKEN)}`,
    );
    expect(lookup?.headers).toEqual({ authorization: `Bearer ${ACCESS_TOKEN}` });
  });

  test("a 404 is undefined — that is how a one-time purchase identifies itself", async () => {
    const { transport } = transportFor([{ status: 404, body: {} }]);
    expect(await fetchPlaySubscription(TOKEN, options(transport))).toBeUndefined();
  });

  test("a supplied access token means no assertion is signed and no token endpoint is called", async () => {
    // The reconciliation Workflow makes hundreds of these, and minting per call would double every round-trip.
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    await fetchPlaySubscription(TOKEN, options(transport, "supplied"));
    expect(seen.map((request) => request.url)).not.toContain(GOOGLE_TOKEN_URL);
    expect(seen[0]?.headers).toEqual({ authorization: "Bearer supplied" });
  });

  test("an answer that is not a subscription purchase is refused, not treated as absent", async () => {
    const { transport } = transportFor([{ body: { hello: "world" } }]);
    await expect(fetchPlaySubscription(TOKEN, options(transport))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("an unreachable Play API is provider_unavailable, so the caller retries", async () => {
    const { transport } = transportFor([{ status: 503, body: {} }]);
    await expect(fetchPlaySubscription(TOKEN, options(transport))).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });

  test("a purchase token is escaped into the path rather than concatenated", async () => {
    const { transport, seen } = transportFor([{ status: 404, body: {} }]);
    await fetchPlaySubscription("a/b?c#d", options(transport, "t"));
    expect(seen[0]?.url).toContain("a%2Fb%3Fc%23d");
  });
});

describe("fetchPlayProduct", () => {
  test("calls the products endpoint under the declared product id", async () => {
    // The product id is a path segment, which is what makes a client-declared one safe: Play answers 404 when
    // the token does not belong to that product, so a cheap token under an expensive SKU fails at Google.
    const { transport, seen } = transportFor([{ body: playProduct }]);
    const purchase = await fetchPlayProduct("coins_100", TOKEN, options(transport, "t"));
    expect(purchase?.purchaseState).toBe(0);
    expect(seen[0]?.url).toBe(
      `${PLAY_API_BASE}/applications/${PACKAGE}/purchases/products/coins_100/tokens/${encodeURIComponent(TOKEN)}`,
    );
  });

  test("a 404 is undefined — the token does not belong to that product", async () => {
    const { transport } = transportFor([{ status: 404, body: {} }]);
    expect(await fetchPlayProduct("coins_100", TOKEN, options(transport, "t"))).toBeUndefined();
  });
});

describe("playSubscriptionStatus", () => {
  test("maps every state Play publishes", () => {
    expect(
      Object.fromEntries(
        [
          "SUBSCRIPTION_STATE_ACTIVE",
          "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
          "SUBSCRIPTION_STATE_ON_HOLD",
          "SUBSCRIPTION_STATE_PAUSED",
          "SUBSCRIPTION_STATE_CANCELED",
          "SUBSCRIPTION_STATE_EXPIRED",
          "SUBSCRIPTION_STATE_PENDING",
          "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
        ].map((state) => [state, playSubscriptionStatus(state)]),
      ),
    ).toEqual({
      SUBSCRIPTION_STATE_ACTIVE: "active",
      SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "in_grace",
      // Play's two, which no other rail has. On hold is a failed renewal past its retry window; paused is a
      // subscription the user suspended. Neither grants.
      SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
      SUBSCRIPTION_STATE_PAUSED: "paused",
      // Auto-renew off, and the paid period still running. This one still grants.
      SUBSCRIPTION_STATE_CANCELED: "canceled",
      SUBSCRIPTION_STATE_EXPIRED: "expired",
      // Awaiting a deferred payment: not paid, so not entitled, and not over either.
      SUBSCRIPTION_STATE_PENDING: "on_hold",
      // The deferred payment never arrived and never will, so nothing was ever bought. `never_paid`, not
      // `expired` — an expired period is one we were paid for, and a `grants` clause credits on it.
      SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "never_paid",
    });
  });

  test("a state this build does not know is refused, never guessed", () => {
    // Guessing `active` would grant on a state that might mean the opposite; guessing `expired` would revoke a
    // paying subscriber. Refusing leaves the row as it stood and the notification recorded.
    const thrown = catchSync(() => playSubscriptionStatus("SUBSCRIPTION_STATE_SOMETHING_NEW"));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("SUBSCRIPTION_STATE_SOMETHING_NEW");
  });
});

describe("playProductStatus", () => {
  test("maps Play's three one-time states", () => {
    expect(playProductStatus(0)).toBe("active");
    // Play's word is "Canceled" and it means the order was taken back. Mapping it to the normalized `canceled`
    // — which means auto-renew off and still granting — would keep granting a refunded purchase.
    expect(playProductStatus(1)).toBe("refunded");
    expect(playProductStatus(2)).toBe("on_hold");
  });

  test("an unknown state is refused", () => {
    expect(() => playProductStatus(7)).toThrow(PaymentsVerificationFailedError);
  });
});

describe("playSubscriptionEvent", () => {
  const context = { purchaseToken: TOKEN, eventAt: NOW };

  test("normalizes an active subscription", () => {
    expect(playSubscriptionEvent(playSubscription, context)).toEqual({
      event: {
        rail: "google",
        // The order id, not the token: it changes every renewal, so each period is its own purchase row.
        providerTransactionId: "GPA.3311-8452-9910-77301..0",
        providerProductId: "pro_monthly",
        status: "active",
        environment: "production",
        purchasedAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-02-01T00:00:00Z"),
        revokedAt: null,
        // The token is the family key, so a renewal's owner resolves from the purchase that started it.
        originalTransactionId: TOKEN,
        // Play's purchase API reports no price, which is what these columns are nullable for.
        amountMinor: null,
        currency: null,
        providerEventAt: NOW,
        payload: playSubscription,
      },
      providerAccountId: "b7e1c94f2a6d4c0e",
    });
  });

  test("a test purchase is sandbox, whatever the deployment thinks", () => {
    // The most common in-app-purchase security defect there is. Play marks a licence-test subscription with a
    // `testPurchase` object, and the writer refuses it against a production deployment.
    const purchase = { ...playSubscription, testPurchase: {} };
    expect(playSubscriptionEvent(purchase, context).event.environment).toBe("sandbox");
  });

  test("a purchase with no test marker is production", () => {
    expect(playSubscriptionEvent(playSubscription, context).event.environment).toBe("production");
  });

  test("a revoked subscription carries the override and a revocation time", () => {
    // Play reports a revoked subscription as EXPIRED, so without the override a refund would read as a lapse.
    const purchase = { ...playSubscription, subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" };
    const event = playSubscriptionEvent(purchase, { ...context, statusOverride: "revoked" }).event;
    expect(event.status).toBe("revoked");
    expect(event.revokedAt).toEqual(NOW);
  });

  test("a paused subscription with no expiry maps to paused and never expires", () => {
    const purchase = {
      ...playSubscription,
      subscriptionState: "SUBSCRIPTION_STATE_PAUSED",
      pausedStateContext: { autoResumeTime: "2026-03-01T00:00:00Z" },
      lineItems: [{ productId: "pro_monthly" }],
    };
    const event = playSubscriptionEvent(purchase, context).event;
    expect(event.status).toBe("paused");
    expect(event.expiresAt).toBeNull();
  });

  test("a subscription with no order yet is keyed on its token", () => {
    // A deferred-payment purchase has no order. Keying it on the token is right — there is no transaction to key
    // it on, and the first order replaces the row on the same key when it arrives.
    const { latestOrderId: _omitted, ...pending } = playSubscription;
    const event = playSubscriptionEvent({ ...pending, subscriptionState: "SUBSCRIPTION_STATE_PENDING" }, context).event;
    expect(event.providerTransactionId).toBe(TOKEN);
    expect(event.status).toBe("on_hold");
  });

  test("a subscription with no start time falls back to the event time", () => {
    const { startTime: _omitted, ...unstarted } = playSubscription;
    expect(playSubscriptionEvent(unstarted, context).event.purchasedAt).toEqual(NOW);
  });

  test("a subscription with no account identifier resolves no owner hook", () => {
    const { externalAccountIdentifiers: _omitted, ...anonymous } = playSubscription;
    expect(playSubscriptionEvent(anonymous, context).providerAccountId).toBeNull();
  });

  test("an unreadable expiry is refused rather than becoming an Invalid Date", () => {
    // NaN loses every comparison the monotonic write rule makes, so it would silently stop updating the row.
    const purchase = { ...playSubscription, lineItems: [{ productId: "pro_monthly", expiryTime: "soon" }] };
    expect(() => playSubscriptionEvent(purchase, context)).toThrow(PaymentsVerificationFailedError);
  });

  test("the whole Play answer is the stored payload, so the row is replayable", () => {
    expect(playSubscriptionEvent(playSubscription, context).event.payload).toBe(playSubscription);
  });
});

describe("playProductEvent", () => {
  const context = { purchaseToken: TOKEN, eventAt: NOW, productId: "coins_100" };

  test("normalizes a purchased one-time product", () => {
    expect(playProductEvent(playProduct, context)).toEqual({
      event: {
        rail: "google",
        providerTransactionId: "GPA.3311-8452-9910-77304",
        providerProductId: "coins_100",
        status: "active",
        environment: "production",
        purchasedAt: new Date(1768435200000),
        // A one-time purchase never lapses, which is what makes a null expiry beat every dated one when an
        // entitlement is derived.
        expiresAt: null,
        revokedAt: null,
        originalTransactionId: null,
        amountMinor: null,
        currency: null,
        providerEventAt: NOW,
        payload: playProduct,
      },
      providerAccountId: "b7e1c94f2a6d4c0e",
    });
  });

  test("a licence-test purchase is sandbox", () => {
    expect(playProductEvent({ ...playProduct, purchaseType: 0 }, context).event.environment).toBe("sandbox");
  });

  test("a promo and a rewarded purchase are production — they are free, not test", () => {
    for (const purchaseType of [1, 2]) {
      expect(playProductEvent({ ...playProduct, purchaseType }, context).event.environment, `${purchaseType}`).toBe(
        "production",
      );
    }
  });

  test("a canceled order is refunded and dated at the event", () => {
    const event = playProductEvent({ ...playProduct, purchaseState: 1 }, context).event;
    expect(event.status).toBe("refunded");
    expect(event.revokedAt).toEqual(NOW);
  });

  test("a pending purchase with no order is keyed on its token", () => {
    const { orderId: _omitted, ...pending } = playProduct;
    const event = playProductEvent({ ...pending, purchaseState: 2 }, context).event;
    expect(event.providerTransactionId).toBe(TOKEN);
    expect(event.status).toBe("on_hold");
  });

  test("the product id comes from the caller, never from the answer", () => {
    // Play echoes a `productId`, but the one that was asked for is the one the lookup was scoped to — and it is
    // the one Google confirmed by answering at all.
    expect(playProductEvent({ ...playProduct, productId: "something_else" }, context).event.providerProductId).toBe(
      "coins_100",
    );
  });
});

describe("resolvePlayPointer", () => {
  const pointer = (overrides: Partial<GoogleNotificationPointer> = {}): GoogleNotificationPointer => ({
    kind: "subscription",
    purchaseToken: TOKEN,
    productId: "pro_monthly",
    notificationType: 2,
    statusOverride: null,
    eventAt: NOW,
    ...overrides,
  });

  test("a subscription pointer resolves through the subscription endpoint", async () => {
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    const state = await resolvePlayPointer(pointer(), options(transport, "t"));
    expect(state?.event.status).toBe("active");
    expect(seen[0]?.url).toContain("/subscriptionsv2/tokens/");
  });

  test("a one-time pointer resolves through the products endpoint, under its sku", async () => {
    const { transport, seen } = transportFor([{ body: playProduct }]);
    const state = await resolvePlayPointer(
      pointer({ kind: "one_time", productId: "coins_100" }),
      options(transport, "t"),
    );
    expect(state?.event.providerProductId).toBe("coins_100");
    expect(seen[0]?.url).toContain("/products/coins_100/tokens/");
  });

  test("carries a revocation override through to the event", async () => {
    const { transport } = transportFor([{ body: playSubscription }]);
    const state = await resolvePlayPointer(pointer({ statusOverride: "revoked" }), options(transport, "t"));
    expect(state?.event.status).toBe("revoked");
  });

  test("uses the notification's own event time, not the clock", async () => {
    // Providers do not guarantee delivery order, so the monotonic write rule compares provider clocks. Using
    // ours here would order by delivery, which is the one ordering Play does not promise.
    const eventAt = new Date("2026-01-10T00:00:00.000Z");
    const { transport } = transportFor([{ body: playSubscription }]);
    const state = await resolvePlayPointer(pointer({ eventAt }), options(transport, "t"));
    expect(state?.event.providerEventAt).toEqual(eventAt);
  });

  test("a purchase Play has no record of is undefined, not an error", async () => {
    const { transport } = transportFor([{ status: 404, body: {} }]);
    expect(await resolvePlayPointer(pointer(), options(transport, "t"))).toBeUndefined();
  });

  test("an unreachable Play API propagates, so nothing is projected from a guess", async () => {
    const { transport } = transportFor([{ status: 500, body: {} }]);
    await expect(resolvePlayPointer(pointer(), options(transport, "t"))).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });
});

/**
 * The reconciliation path. What the cases pin is that the *row* is enough to address a Play subscription — the
 * purchase token is stored as the family key — and that a one-time row is honestly not addressable at all.
 */
describe("refreshPlayPurchase", () => {
  /** A stored Play subscription row, as the projection last wrote it. */
  function stored(overrides: Partial<PaymentsPurchase> = {}): PaymentsPurchase {
    return {
      id: "33333333-3333-4333-8333-333333333333",
      userId: "ada",
      rail: "google",
      providerTransactionId: "GPA.3300-1234-5678-90123",
      productId: "pro_monthly",
      providerProductId: "pro_monthly",
      type: "subscription",
      status: "active",
      environment: "production",
      purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
      revokedAt: null,
      // Play's family key is the purchase token, which is what makes a stored row addressable at all.
      originalTransactionId: TOKEN,
      amountMinor: null,
      currency: null,
      providerEventAt: new Date("2026-01-01T00:00:00.000Z"),
      payload: {},
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  test("looks the subscription up by the stored purchase token and normalizes it", async () => {
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    const event = await refreshPlayPurchase(stored(), options(transport, ACCESS_TOKEN));
    expect(seen[0]?.url).toContain(encodeURIComponent(TOKEN));
    expect(event).toMatchObject({ rail: "google", providerProductId: "pro_monthly", status: "active" });
  });

  test("dates the event by the clock, so a repair cannot lose to the row it is repairing", async () => {
    const { transport } = transportFor([{ body: playSubscription }]);
    expect((await refreshPlayPurchase(stored(), options(transport, ACCESS_TOKEN)))?.providerEventAt).toEqual(NOW);
  });

  test("reuses the batch access token rather than minting one per purchase", async () => {
    // A pass over hundreds of subscriptions would otherwise sign an assertion and POST for every one of them.
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    await refreshPlayPurchase(stored(), options(transport, ACCESS_TOKEN));
    expect(seen.some((request) => request.url === GOOGLE_TOKEN_URL)).toBe(false);
  });

  test("a subscription Play no longer knows leaves the row exactly as it stood", async () => {
    const { transport } = transportFor([{ status: 404, body: {} }]);
    await expect(refreshPlayPurchase(stored(), options(transport, ACCESS_TOKEN))).resolves.toBeUndefined();
  });

  test("a one-time purchase is not refreshed, and costs no round-trip", async () => {
    // The honest gap: a one-time row is keyed on Play's order id and stores no purchase token, and Play's
    // one-time lookup takes a token. There is no call to make.
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    await expect(
      refreshPlayPurchase(stored({ type: "non_consumable" }), options(transport, ACCESS_TOKEN)),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  test("a subscription never paid for is keyed on its own token", async () => {
    const { transport, seen } = transportFor([{ body: playSubscription }]);
    await refreshPlayPurchase(
      stored({ originalTransactionId: null, providerTransactionId: TOKEN }),
      options(transport, ACCESS_TOKEN),
    );
    expect(seen[0]?.url).toContain(encodeURIComponent(TOKEN));
  });

  test("an unreachable Play API propagates, which is what tells the Workflow to retry", async () => {
    const { transport } = transportFor([{ status: 500, body: {} }]);
    await expect(refreshPlayPurchase(stored(), options(transport, ACCESS_TOKEN))).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });
});

/** The thrown `PithyError`, or undefined. */
async function catchError(run: () => Promise<unknown>): Promise<PaymentsRailNotConfiguredError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as PaymentsRailNotConfiguredError;
  }
}

/** The synchronous twin. */
function catchSync(run: () => unknown): PaymentsVerificationFailedError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as PaymentsVerificationFailedError;
  }
}
