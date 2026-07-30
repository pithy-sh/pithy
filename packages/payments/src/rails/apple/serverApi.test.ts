import { beforeAll, describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import { PaymentsRailNotConfiguredError, PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsAppleCredentials } from "../../secret/registry";
import { type MintedChain, mintAppStoreKey, mintChain, signJws } from "./fixtures/chain";
import didRenew from "./fixtures/did-renew.json" with { type: "json" };
import type { AppleHttpFetch, AppleHttpRequest } from "./http";
import {
  APPLE_API_AUDIENCE,
  APPLE_API_BASES,
  appleSubscriptionStatus,
  fetchAppleSubscriptionStatuses,
  mintAppleApiToken,
  refreshAppleSubscription,
} from "./serverApi";

/**
 * Apple's reconciliation path: the one call in this rail that reaches the network, and the one status Apple
 * reports that a signed transaction cannot.
 *
 * The signing is real on both sides. The App Store Connect token is minted with a genuine P-256 key and
 * verified here against that key's public half, so a broken JWT is a failing test rather than a 401 an adopter
 * discovers. The transaction inside Apple's answer is signed with the minted chain and verified against it,
 * exactly as the webhook path verifies a notification — a refreshed row is no less checked than a pushed one.
 */

const BUNDLE_ID = "com.acme.app";
const KEY_ID = "2X9R4HXF34";
const ISSUER_ID = "57246542-96fe-1a63-e053-0824d011072a";
/** Mid-period for the recorded transaction, which runs 2026-01-01 to 2026-02-01. */
const NOW = new Date("2026-01-15T00:00:00.000Z");
/** The family key every fixture transaction chains back to. */
const FAMILY_ID = "2000000617339002";
/** A paid period that ended yesterday, and the retry window Apple runs past it. The grace cases turn on both. */
const LAPSED = new Date("2026-01-14T00:00:00.000Z");
const GRACE_END = new Date("2026-01-20T00:00:00.000Z");

let chain: MintedChain;
let credentials: PaymentsAppleCredentials;
let signingKey: CryptoKey;

beforeAll(async () => {
  chain = await mintChain();
  const key = await mintAppStoreKey();
  signingKey = key.publicKey;
  credentials = { bundleId: BUNDLE_ID, keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: key.pem };
});

/** One outbound call, so a case can assert what left the Worker as well as what came back. */
interface Recorded {
  url: string;
  init?: AppleHttpRequest;
}

/** A transport answering one body, recording every call. An unstubbed status is a 200. */
function answering(body: unknown, calls: Recorded[] = [], status = 200): AppleHttpFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
}

/** Apple's StatusResponse around one signed transaction, with the group's numeric status. */
async function statusResponse(
  overrides: {
    status?: number;
    transaction?: Record<string, unknown>;
    renewalInfo?: Record<string, unknown> | null;
    bundleId?: string;
    originalTransactionId?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const renewal = overrides.renewalInfo === null ? undefined : (overrides.renewalInfo ?? didRenew.renewalInfo);
  return {
    environment: "Production",
    bundleId: overrides.bundleId ?? BUNDLE_ID,
    data: [
      {
        subscriptionGroupIdentifier: "20845513",
        lastTransactions: [
          {
            originalTransactionId: overrides.originalTransactionId ?? FAMILY_ID,
            status: overrides.status ?? 1,
            signedTransactionInfo: await signJws({ ...didRenew.transaction, ...overrides.transaction }, chain),
            ...(renewal ? { signedRenewalInfo: await signJws(renewal, chain) } : {}),
          },
        ],
      },
    ],
  };
}

/** A stored subscription row, as the projection last wrote it. Only the fields a refresh reads matter. */
function stored(overrides: Partial<PaymentsPurchase> = {}): PaymentsPurchase {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "ada",
    rail: "apple",
    providerTransactionId: "2000000731004811",
    productId: "pro_monthly",
    providerProductId: "com.acme.pro.monthly",
    type: "subscription",
    status: "active",
    environment: "production",
    purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    revokedAt: null,
    originalTransactionId: FAMILY_ID,
    amountMinor: 499,
    currency: "USD",
    providerEventAt: new Date("2026-01-01T00:00:00.000Z"),
    payload: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const options = (transport: AppleHttpFetch) => ({
  credentials,
  now: NOW,
  transport,
  roots: [chain.root],
});

describe("mintAppleApiToken", () => {
  test("mints an ES256 JWT the key's own public half verifies", async () => {
    const token = await mintAppleApiToken(credentials, { now: NOW });
    const [head, body, signature] = token.split(".");
    const bytes = Uint8Array.from(atob((signature as string).replaceAll("-", "+").replaceAll("_", "/")), (character) =>
      character.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      bytes as unknown as ArrayBuffer,
      new TextEncoder().encode(`${head}.${body}`) as unknown as ArrayBuffer,
    );
    expect(valid).toBe(true);
  });

  test("claims the key id, the issuer, Apple's audience, and the bundle", async () => {
    const token = await mintAppleApiToken(credentials, { now: NOW });
    const decode = (segment: string) =>
      JSON.parse(atob(segment.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
    const [head, body] = token.split(".");
    expect(decode(head as string)).toEqual({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
    const claims = decode(body as string);
    // `bid` is what scopes a token to one app. Apple refuses one without it, which is why the bundle id lives
    // in the credential block beside the key rather than in config.
    expect(claims).toMatchObject({ iss: ISSUER_ID, aud: APPLE_API_AUDIENCE, bid: BUNDLE_ID });
    expect(claims.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(claims.exp as number).toBeGreaterThan(claims.iat as number);
  });

  test("expires inside Apple's one-hour ceiling, with room for clock skew", async () => {
    const token = await mintAppleApiToken(credentials, { now: NOW });
    const claims = JSON.parse(
      atob((token.split(".")[1] as string).replaceAll("-", "+").replaceAll("_", "/")),
    ) as Record<string, number>;
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThan(3600);
  });

  test("a key with no PEM armour is a configuration failure, named as one", async () => {
    await expect(mintAppleApiToken({ ...credentials, privateKey: "not a key" }, { now: NOW })).rejects.toBeInstanceOf(
      PaymentsRailNotConfiguredError,
    );
  });

  test("a PEM that is not PKCS#8 says which file to store instead", async () => {
    const caught = await mintAppleApiToken(
      { ...credentials, privateKey: "-----BEGIN EC PRIVATE KEY-----\nMHc=\n-----END EC PRIVATE KEY-----" },
      { now: NOW },
    ).catch((error: unknown) => error);
    expect((caught as PaymentsRailNotConfiguredError).payload.detail).toContain("PKCS#8");
  });

  test("a `.p8` pasted through JSON with literal \\n still imports", async () => {
    // How a key arrives when an operator pastes it into a JSON secret rather than a file.
    const escaped = credentials.privateKey.replaceAll("\n", "\\n");
    await expect(mintAppleApiToken({ ...credentials, privateKey: escaped }, { now: NOW })).resolves.toContain(".");
  });

  test("armoured PEM whose body is not base64 is refused before WebCrypto sees it", async () => {
    const caught = await mintAppleApiToken(
      { ...credentials, privateKey: "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----" },
      { now: NOW },
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(PaymentsRailNotConfiguredError);
  });
});

describe("appleSubscriptionStatus", () => {
  test("maps Apple's five codes into the normalized set", () => {
    expect(appleSubscriptionStatus(1, 1)).toBe("active");
    expect(appleSubscriptionStatus(2, undefined)).toBe("expired");
    expect(appleSubscriptionStatus(5, undefined)).toBe("revoked");
  });

  test("billing retry does not grant and the grace period does — the pair most often swapped", () => {
    // 3 is Apple retrying the card with access already withdrawn; 4 is the grace period, whose whole point is
    // that a failed card does not lock a paying subscriber out mid-period.
    expect(appleSubscriptionStatus(3, 1)).toBe("on_hold");
    expect(appleSubscriptionStatus(4, 1)).toBe("in_grace");
  });

  test("auto-renew off narrows an active subscription to canceled, which still grants", () => {
    expect(appleSubscriptionStatus(1, 0)).toBe("canceled");
  });

  test("auto-renew off does not overwrite grace or billing retry", () => {
    // The more urgent fact wins. Saying `canceled` here would report a failed card as the user's choice, and
    // `canceled` grants where `on_hold` must not.
    expect(appleSubscriptionStatus(3, 0)).toBe("on_hold");
    expect(appleSubscriptionStatus(4, 0)).toBe("in_grace");
  });

  test("a code Apple has not published yet is refused, never guessed", () => {
    // Guessing `active` would grant on a state that might mean the opposite; guessing `expired` would revoke a
    // paying subscriber. Refusing leaves the row as it stood.
    expect(() => appleSubscriptionStatus(6, 1)).toThrow(PaymentsVerificationFailedError);
  });
});

describe("fetchAppleSubscriptionStatuses", () => {
  test("asks the production host for a production purchase, with a bearer token", async () => {
    const calls: Recorded[] = [];
    await fetchAppleSubscriptionStatuses(FAMILY_ID, "production", options(answering(await statusResponse(), calls)));
    expect(calls[0]?.url).toBe(`${APPLE_API_BASES.production}/subscriptions/${FAMILY_ID}`);
    expect(calls[0]?.init?.headers?.authorization).toMatch(/^Bearer ey/);
  });

  test("asks the sandbox host for a sandbox purchase — the two are separate services", async () => {
    const calls: Recorded[] = [];
    await fetchAppleSubscriptionStatuses(FAMILY_ID, "sandbox", options(answering(await statusResponse(), calls)));
    expect(calls[0]?.url.startsWith(APPLE_API_BASES.sandbox)).toBe(true);
  });

  test("reuses a token the caller minted rather than signing one per purchase", async () => {
    const calls: Recorded[] = [];
    await fetchAppleSubscriptionStatuses(FAMILY_ID, "production", {
      ...options(answering(await statusResponse(), calls)),
      token: "batched",
    });
    expect(calls[0]?.init?.headers?.authorization).toBe("Bearer batched");
  });

  test("a 404 is an absent subscription, not a failure", async () => {
    const transport: AppleHttpFetch = async () => ({ ok: false, status: 404, text: async () => "{}" });
    await expect(fetchAppleSubscriptionStatuses(FAMILY_ID, "production", options(transport))).resolves.toBeUndefined();
  });

  test("an answer that is not a StatusResponse is refused without echoing it", async () => {
    const caught = await fetchAppleSubscriptionStatuses(
      FAMILY_ID,
      "production",
      options(answering({ data: "nope" })),
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(PaymentsVerificationFailedError);
    expect((caught as PaymentsVerificationFailedError).payload.detail).not.toContain("nope");
  });
});

describe("refreshAppleSubscription", () => {
  test("verifies the returned transaction and normalizes it", async () => {
    const event = await refreshAppleSubscription(stored(), options(answering(await statusResponse())));
    expect(event).toMatchObject({
      rail: "apple",
      providerTransactionId: "2000000731004811",
      providerProductId: "com.acme.pro.monthly",
      originalTransactionId: FAMILY_ID,
      environment: "production",
      status: "active",
      amountMinor: 499,
      currency: "USD",
    });
  });

  test("dates the event by the clock, so a repair cannot lose to the row it is repairing", async () => {
    // The monotonic write rule discards an event no newer than the stored row. A refresh dated by the
    // transaction Apple signed weeks ago would be discarded every time, which would make the whole pass a no-op.
    const event = await refreshAppleSubscription(stored(), options(answering(await statusResponse())));
    expect(event?.providerEventAt).toEqual(NOW);
  });

  test("reports the group's status, which the transaction alone does not carry", async () => {
    // The reason this call exists: a transaction says when it expires, and says nothing about a billing retry.
    const event = await refreshAppleSubscription(stored(), options(answering(await statusResponse({ status: 3 }))));
    expect(event?.status).toBe("on_hold");
  });

  test("a revocation on the transaction beats the group's status", async () => {
    const event = await refreshAppleSubscription(
      stored(),
      options(answering(await statusResponse({ status: 1, transaction: { revocationDate: NOW.getTime() - 1000 } }))),
    );
    expect(event?.status).toBe("refunded");
    expect(event?.revokedAt).toEqual(new Date(NOW.getTime() - 1000));
  });

  test("a grace period carries access to the end of the grace window", async () => {
    // Status 4 is the whole reason a subscription in billing retry keeps its entitlement, and the window it
    // runs to is on the renewal info — the transaction's own expiry has already passed by the time Apple says 4.
    const event = await refreshAppleSubscription(
      stored(),
      options(
        answering(
          await statusResponse({
            status: 4,
            transaction: { expiresDate: LAPSED.getTime() },
            renewalInfo: { ...didRenew.renewalInfo, gracePeriodExpiresDate: GRACE_END.getTime() },
          }),
        ),
      ),
    );
    expect(event?.status).toBe("in_grace");
    expect(event?.expiresAt).toEqual(GRACE_END);
  });

  test("a status that is not grace ignores the grace window still on the renewal info", async () => {
    // Apple leaves `gracePeriodExpiresDate` on the renewal info after the retry is over. Status 3 is billing
    // retry with access already ended; extending it would grant exactly what `on_hold` says nobody has.
    const event = await refreshAppleSubscription(
      stored(),
      options(
        answering(
          await statusResponse({
            status: 3,
            transaction: { expiresDate: LAPSED.getTime() },
            renewalInfo: { ...didRenew.renewalInfo, gracePeriodExpiresDate: GRACE_END.getTime() },
          }),
        ),
      ),
    );
    expect(event?.status).toBe("on_hold");
    expect(event?.expiresAt).toEqual(LAPSED);
  });

  test("a grace period with no grace date on the renewal info keeps the transaction's expiry", async () => {
    const event = await refreshAppleSubscription(
      stored(),
      options(answering(await statusResponse({ status: 4, transaction: { expiresDate: LAPSED.getTime() } }))),
    );
    expect(event?.status).toBe("in_grace");
    expect(event?.expiresAt).toEqual(LAPSED);
  });

  test("reads auto-renew off out of the renewal info", async () => {
    const event = await refreshAppleSubscription(
      stored(),
      options(answering(await statusResponse({ renewalInfo: { ...didRenew.renewalInfo, autoRenewStatus: 0 } }))),
    );
    expect(event?.status).toBe("canceled");
  });

  test("a group with no renewal info still resolves", async () => {
    const event = await refreshAppleSubscription(
      stored(),
      options(answering(await statusResponse({ renewalInfo: null }))),
    );
    expect(event?.status).toBe("active");
  });

  test("picks the entry matching the family key rather than the first in the group", async () => {
    // A query resolves the whole subscription group, and a group can hold more than one subscription. Taking
    // position zero would occasionally refresh a row with a sibling's state.
    const answer = await statusResponse();
    const group = (answer.data as { lastTransactions: unknown[] }[])[0] as { lastTransactions: unknown[] };
    group.lastTransactions.unshift({
      originalTransactionId: "9000000000000001",
      status: 2,
      signedTransactionInfo: await signJws(
        { ...didRenew.transaction, transactionId: "9000000000000002", productId: "com.acme.other" },
        chain,
      ),
    });
    const event = await refreshAppleSubscription(stored(), options(answering(answer)));
    expect(event?.providerProductId).toBe("com.acme.pro.monthly");
  });

  test("a family the group does not mention leaves the row alone", async () => {
    const event = await refreshAppleSubscription(
      stored(),
      options(answering(await statusResponse({ originalTransactionId: "9000000000000001" }))),
    );
    expect(event).toBeUndefined();
  });

  test("a one-time purchase is not refreshed — nothing about it drifts", async () => {
    const calls: Recorded[] = [];
    const event = await refreshAppleSubscription(
      stored({ type: "non_consumable" }),
      options(answering(await statusResponse(), calls)),
    );
    expect(event).toBeUndefined();
    // And it costs no round-trip, which is what makes a pass over a large catalog affordable.
    expect(calls).toHaveLength(0);
  });

  test("the first row of a family is its own family key", async () => {
    const calls: Recorded[] = [];
    await refreshAppleSubscription(
      stored({ originalTransactionId: null, providerTransactionId: FAMILY_ID }),
      options(answering(await statusResponse(), calls)),
    );
    expect(calls[0]?.url.endsWith(FAMILY_ID)).toBe(true);
  });

  test("a subscription for another app is refused, whoever signed the answer", async () => {
    // A signature proves Apple signed the payload, never that it is about our app.
    await expect(
      refreshAppleSubscription(stored(), options(answering(await statusResponse({ bundleId: "com.other.app" })))),
    ).rejects.toBeInstanceOf(PaymentsVerificationFailedError);
  });

  test("a transaction signed by a chain we do not trust is refused", async () => {
    const other = await mintChain();
    const answer = await statusResponse();
    const group = (answer.data as { lastTransactions: { signedTransactionInfo: string }[] }[])[0] as {
      lastTransactions: { signedTransactionInfo: string }[];
    };
    (group.lastTransactions[0] as { signedTransactionInfo: string }).signedTransactionInfo = await signJws(
      didRenew.transaction,
      other,
    );
    await expect(refreshAppleSubscription(stored(), options(answering(answer)))).rejects.toThrow();
  });
});
