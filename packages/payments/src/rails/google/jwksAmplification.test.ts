// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { memoryJwksCache, OIDC_JWKS_MIN_REFRESH_SECONDS } from "@pithy-sh/core/src/http/oidcWebhook";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig, type PaymentsConfigInput } from "../../config/config";
import { registerPaymentsRoutes } from "../../http/routes";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../../secret/registry";
import { type MintedOidcKey, mintOidcKey, pushBody, signOidcToken } from "./fixtures/push";
import type { GoogleHttpFetch } from "./http";
import { GOOGLE_JWKS_URL } from "./oidc";

/**
 * What one anonymous POST to the Google webhook costs us at Google's key endpoint.
 *
 * **The Google webhook is the one route in this package that does unauthenticated work before it can refuse
 * anyone.** An OIDC token is checked against a key resolved by the `kid` in its own unverified header, so the
 * fetch happens *before* the signature does — which means a 49-byte forgery buys a round trip to
 * `https://www.googleapis.com/oauth2/v3/certs`. Without a store that outlives the request, that ratio is 1:1
 * and it is a bandwidth multiplier aimed at somebody else's endpoint: Google rate limits us, `fetchJwks`
 * calls that `core/upstream_failed`, that code is in the webhook guard's pass-through set, and Pub/Sub
 * therefore redelivers the *genuine* notifications into the same uncached path. One anonymous caller, the
 * whole rail down. Core's own `JwksCache` doc names this hazard in as many words.
 *
 * **There are two floods, and holding Google's keys answers only one of them.** A forgery that copies a
 * `kid` Google really publishes is a cache *hit* and collapses onto one fetch. A forgery that invents a
 * `kid` is a *miss*, an unknown `kid` is how rotation announces itself, so a miss is a refresh — and
 * inventing one is not a gram more work than copying one. The first round of this fix shipped the store
 * alone and closed the half an attacker would not bother using. What closes the other half is the store's
 * refresh window (`JwksCache.claimRefresh`): one ask per key endpoint per `OIDC_JWKS_MIN_REFRESH_SECONDS`,
 * for every `kid` together, because a bound per `kid` is no bound against somebody who picks them.
 *
 * So these cases count outbound requests rather than statuses. Every delivery below goes through the real
 * route — `registerPaymentsRoutes` → `requireSignedWebhook` → `resolveRailProvider` → `googleRail` → core —
 * and the rail is rebuilt per request there, exactly as it is in production. That is the point: the store
 * cannot live on the rail, so a count of one across a flood is the only way to see that it lives somewhere
 * that outlasts a request.
 *
 * **And it must not live in a module.** The last case is the other half of #520: two composed apps each fetch
 * their own keys. A module-global cache would answer one, which is how the deleted one came to need an
 * exported `resetGoogleJwksCache` whose only purpose was to undo the previous suite.
 *
 * No delivery here is ever accepted, and that is deliberate rather than a gap. A verified push reaches the
 * `pithy_payments_webhook_events` insert, which needs a D1 this project does not have — and the traffic this
 * file is about is the traffic that never gets that far. `routes.workers.test.ts` owns the accepted path.
 */

const AUDIENCE = "https://acme.example/payments/webhooks/google";
const SERVICE_ACCOUNT = "pithy-rtdn@acme-42.iam.gserviceaccount.com";
const PACKAGE_NAME = "com.acme.app";
const NOW = new Date("2026-01-15T00:00:00.000Z");

const CATALOG: PaymentsConfigInput = {
  billingSubject: "user",
  rails: { google: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      google: { productId: "pro_monthly" },
    },
  },
};

const CREDENTIALS = {
  google: {
    packageName: PACKAGE_NAME,
    serviceAccountEmail: SERVICE_ACCOUNT,
    // Never used: nothing here reaches the Play Developer API, because nothing here verifies.
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
    pubsubAudience: AUDIENCE,
  },
};

/** Google's push signing key — published by the transport below — and one nobody ever published. */
let published: MintedOidcKey;
let impostor: MintedOidcKey;

beforeAll(async () => {
  published = await mintOidcKey();
  // The same `kid`. A forger reads a `kid` off Google's own published key set and puts it on a token they
  // signed themselves — that is what makes the key fetch happen before the signature check refuses them.
  impostor = await mintOidcKey(published.kid);
});

beforeEach(() => {
  stubSecrets(paymentsSecretsRegistry, { [PAYMENTS_PROVIDER_SECRET]: CREDENTIALS });
});

afterEach(() => {
  resetSharedSecrets();
});

/** Every outbound URL the Google rail asked for, in order. The measurement. */
let outbound: string[];

/** A transport that publishes the suite's key at Google's real JWKS URL and records every request. */
function googleTransport(): GoogleHttpFetch {
  return async (url) => {
    outbound.push(url);
    if (url !== GOOGLE_JWKS_URL) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [published.jwk] }) };
  };
}

/** The claims Google puts on a Pub/Sub push token, all valid. */
function claims(overrides: Record<string, unknown> = {}) {
  return {
    aud: AUDIENCE,
    azp: "112233445566778899000",
    email: SERVICE_ACCOUNT,
    email_verified: true,
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    iat: Math.floor(NOW.getTime() / 1000) - 60,
    iss: "https://accounts.google.com",
    sub: "112233445566778899000",
    ...overrides,
  };
}

/**
 * The cheapest forgery of all: signed by a key Google never saw, naming a `kid` nobody has ever published.
 * A new one per call, because `kid` is read out of an unverified header and costs an attacker nothing to
 * change — which is exactly why a bound that only covers a *published* `kid` is not a bound.
 */
async function invented(): Promise<string> {
  return signOidcToken(claims(), impostor, { kid: `invented-${crypto.randomUUID()}` });
}

/**
 * One composed app, as `payments()` composes it: routes registered once, and every request after that shares
 * whatever the registration built.
 */
function makeApp(trust: Parameters<typeof registerPaymentsRoutes>[0]["trust"] = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("emit", async () => {});
    await next();
  });
  const config = PaymentsConfig.parse(CATALOG);
  registerPaymentsRoutes({ config, now: () => NOW, trust })(app);
  return { app, path: `${config.basePath}/webhooks/google` };
}

/** POST one Pub/Sub push carrying `token`, and answer with its status. */
async function deliver(app: Hono<PithyHonoEnv>, path: string, token: string): Promise<number> {
  const response = await app.request(
    path,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: pushBody({ version: "1.0", packageName: PACKAGE_NAME, eventTimeMillis: String(NOW.getTime()) }),
    },
    {},
  );
  return response.status;
}

beforeEach(() => {
  outbound = [];
});

describe("the Google webhook's key store", () => {
  test("a flood of forged deliveries costs one key fetch, not one each", async () => {
    // The amplifier, measured. Every token is signed by a key Google never saw, under the `kid` of a key
    // Google publishes — the cheapest forgery there is, and the one that reaches the fetch.
    const token = await signOidcToken(claims(), impostor);
    const { app, path } = makeApp({ googleTransport: googleTransport() });

    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) statuses.push(await deliver(app, path, token));

    expect(statuses).toEqual(Array.from({ length: 25 }, () => 401));
    expect(outbound.filter((url) => url === GOOGLE_JWKS_URL)).toEqual([GOOGLE_JWKS_URL]);
  });

  test("the store serves the signature check too, not only the refusal after it", async () => {
    // Signed by the key Google really publishes, so every one of these runs the whole verification —
    // fetch, import, `crypto.subtle.verify`, issuer — and is refused on the audience, which is the boundary.
    // A cache that only ever served tokens that failed their signature would prove nothing about the path a
    // genuine delivery takes.
    const token = await signOidcToken(claims({ aud: "https://evil.example/hook" }), published);
    const { app, path } = makeApp({ googleTransport: googleTransport() });

    for (let i = 0; i < 10; i += 1) expect(await deliver(app, path, token)).toBe(401);

    expect(outbound.filter((url) => url === GOOGLE_JWKS_URL)).toHaveLength(1);
  });

  test("two composed apps do not share one — the store is not a module global", async () => {
    const token = await signOidcToken(claims(), impostor);
    const first = makeApp({ googleTransport: googleTransport() });
    const second = makeApp({ googleTransport: googleTransport() });

    await deliver(first.app, first.path, token);
    await deliver(second.app, second.path, token);

    // Two, one each. A module variable would answer one, and the second app would be trusting keys it never
    // asked for — which is the state #520 removed and this file must not let back in.
    expect(outbound.filter((url) => url === GOOGLE_JWKS_URL)).toHaveLength(2);
  });

  test("a flood naming a different invented kid every time costs one key fetch too", async () => {
    // **The measurement the first round did not take.** Every delivery here names a `kid` Google has never
    // published, so every one is a cache miss — and a miss is what used to buy a fetch however full the
    // store was. Forty deliveries, forty `kid`s, one round trip to Google.
    const { app, path } = makeApp({ googleTransport: googleTransport() });

    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push(await deliver(app, path, await invented()));

    // Refused apiece, and refused as the sender's failure: the bound is on what a refusal costs us, never
    // on whether it refuses.
    expect(statuses).toEqual(Array.from({ length: 40 }, () => 401));
    expect(outbound.filter((url) => url === GOOGLE_JWKS_URL)).toEqual([GOOGLE_JWKS_URL]);
  });

  test("that flood is a rate, so a rotation is still picked up a window later", async () => {
    // The other half of the same property. A window that never reopened would be a key pin: Google rotates,
    // the new `kid` is unknown, and nothing would ever look again. One ask per window means a rotation
    // costs at most one window of redeliveries, which is what Pub/Sub is for.
    let clock = NOW;
    const { app, path } = makeApp({
      googleTransport: googleTransport(),
      googleJwksCache: memoryJwksCache({ now: () => clock }),
    });
    // The routes' own clock is pinned at NOW, so the store's is the one moved here — it is the store that
    // holds the window, which is the whole reason a shared store shares the bound.
    await deliver(app, path, await invented());
    await deliver(app, path, await invented());
    expect(outbound.filter((url) => url === GOOGLE_JWKS_URL)).toHaveLength(1);

    clock = new Date(NOW.getTime() + (OIDC_JWKS_MIN_REFRESH_SECONDS + 1) * 1000);
    await deliver(app, path, await invented());
    expect(outbound.filter((url) => url === GOOGLE_JWKS_URL)).toHaveLength(2);
  });

  test("a store the adopter supplies is used instead of the one the routes build", async () => {
    // The seam for a bound harder than one isolate's memory: a `JwksCache` over KV, shared by every isolate.
    // Seeded here, so a hit proves the adopter's store was consulted rather than the built-in one.
    const shared = memoryJwksCache({ now: () => NOW });
    await shared.set(GOOGLE_JWKS_URL, [published.jwk], 3600);
    const token = await signOidcToken(claims(), impostor);
    const { app, path } = makeApp({ googleTransport: googleTransport(), googleJwksCache: shared });

    expect(await deliver(app, path, token)).toBe(401);

    expect(outbound).toEqual([]);
  });
});
