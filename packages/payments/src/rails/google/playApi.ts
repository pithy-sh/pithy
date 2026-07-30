import { z } from "zod";
import type { PaymentsPurchase, PurchaseEnvironment } from "../../data/purchase";
import type { PurchaseStatus } from "../../data/status";
import {
  PaymentsProviderUnavailableError,
  PaymentsRailNotConfiguredError,
  PaymentsVerificationFailedError,
} from "../../error/errors";
import type { PaymentsGoogleCredentials } from "../../secret/registry";
import type { UnboundProviderEvent } from "../contract";
import { type GoogleHttpFetch, googleHttpFetch, googleJson } from "./http";
import { base64UrlEncode, pemPrivateKey } from "./jwt";
import type { GoogleNotificationPointer } from "./rtdn";

/**
 * The Play Developer API — the call that turns a purchase token into a state, and the mapping of Play's
 * vocabulary into the normalized status set.
 *
 * This is the half of Google's rail that has no Apple equivalent. A StoreKit transaction *is* the state, signed;
 * a Play purchase token is a pointer, so every Google projection costs a network round-trip. Two, in fact — the
 * API is OAuth-protected, so a service-account assertion buys an access token first.
 *
 * ## Two statuses Play has and the other rails do not
 *
 * `on_hold` and `paused` are Play's own. **On hold** is a subscription whose billing retry window has run out:
 * Google keeps trying for up to 30 days and access is withdrawn throughout, which is why `on_hold` never
 * grants. **Paused** is a subscription the *user* suspended, with an `autoResumeTime` set; they will come back,
 * and until they do they are not entitled. Neither has an Apple analogue, and both would be lost by a status
 * set built from Apple's notifications alone.
 *
 * ## What Play does not report, and what follows
 *
 * **No price.** Neither `purchases.subscriptionsv2.get` nor `purchases.products.get` returns an amount or a
 * currency, so `amountMinor` and `currency` are null on every Google purchase. That is what those columns are
 * nullable for. Revenue figures for the Play rail come from Google's own reporting, not from here.
 *
 * **No last-modified time.** So the caller supplies the event time: the notification's `eventTimeMillis` on the
 * webhook path, and the clock on a client submission. Both are honest — a submission is a read of the current
 * state, so treating it as the freshest fact is right — and both feed the monotonic write rule, which is why
 * neither may be invented here.
 *
 * ## The environment check
 *
 * A test purchase is a real Play purchase made by a licence-tested account, and it must never grant a
 * production entitlement. Play marks one differently in each shape: `testPurchase` is present on a
 * subscription, `purchaseType: 0` on a one-time product. Both are read, and anything unmarked is production —
 * which is safe because Play only ever omits the marker on a real purchase.
 */

/** Google's OAuth token endpoint. The audience of the service-account assertion as well as its destination. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The Play Developer API's base. Public, so it is pinned here rather than configured. */
export const PLAY_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";

/** The one OAuth scope payments asks for. Read-and-acknowledge on purchases, nothing else in the console. */
export const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** RSASSA-PKCS1-v1_5 with SHA-256 — `RS256`, the algorithm a Google service-account assertion is signed with. */
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** How long an assertion claims to be good for. Google's ceiling is an hour and there is no reason to ask less. */
const ASSERTION_LIFETIME_SECONDS = 3600;

/** Play's `purchaseType` for a licence-test purchase. The one-time equivalent of `testPurchase`. */
const PLAY_PURCHASE_TYPE_TEST = 0;

/**
 * Play's subscription states, mapped.
 *
 * Two are worth reading twice. **`CANCELED` still grants**: the user turned auto-renew off and keeps the period
 * they paid for, which `expiresAt` ends — mapping it to anything non-granting would strip access from somebody
 * who is still paid up. And **`PENDING` does not**: a deferred-payment purchase (cash, direct debit) has not
 * been paid yet, so it is treated as `on_hold` — not `expired`, because it may still become active.
 *
 * `PENDING_PURCHASE_CANCELED` is `never_paid`: the deferred payment never arrived and never will. Deliberately
 * not `canceled`, which grants; not `refunded`, because no money moved; and **not `expired`**, because an
 * expired period is one we were paid for and a `grants` clause credits on it.
 */
const SUBSCRIPTION_STATES: Readonly<Record<string, PurchaseStatus>> = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "in_grace",
  SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING: "on_hold",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "never_paid",
};

/**
 * Play's one-time purchase states, mapped.
 *
 * `1` is Play's `Canceled`, and it is the trap in this table. It must **not** become the normalized `canceled`,
 * which means "auto-renew off, still granting" — Play means the order was taken back. It is mapped to
 * `refunded`, which is the normalized member for "taken back", does not grant, and is the state an opt-in
 * clawback acts on. Play cannot distinguish a refunded order from a deferred purchase that was cancelled before
 * payment, so a clawback on the latter finds nothing to debit and is refused into a recorded state — which is
 * the designed behaviour for a failed clawback rather than a defect.
 *
 * `2` is `Pending`: awaiting a deferred payment, so it does not grant, and `on_hold` is the member that says so
 * without claiming the purchase is over.
 */
const PRODUCT_STATES: Readonly<Record<number, PurchaseStatus>> = { 0: "active", 1: "refunded", 2: "on_hold" };

/** Google's OAuth token response, narrowed to the one field that matters. */
const GoogleAccessToken = z
  .object({
    access_token: z.string().min(1).describe("The bearer token the Play Developer API is called with."),
    expires_in: z.number().int().optional().describe("How long it lasts, in seconds. Informational here."),
    token_type: z.string().min(1).optional().describe("Always `Bearer` in practice."),
  })
  .loose()
  .describe("Google's OAuth 2.0 token response to a service-account assertion.");

/** One line item on a subscription — the product, and when its paid period ends. */
const PlaySubscriptionLineItem = z
  .object({
    productId: z
      .string()
      .min(1)
      .describe("The subscription product id as listed in the Play Console — the SKU the catalog maps."),
    expiryTime: z
      .string()
      .min(1)
      .optional()
      .describe("When the paid period ends, RFC 3339. Absent on a paused or never-paid subscription."),
    autoRenewingPlan: z
      .object({
        autoRenewEnabled: z.boolean().optional().describe("Whether the plan will renew. Reported, never mapped."),
      })
      .loose()
      .optional()
      .describe("The auto-renewing plan's own state, when the line item is one."),
  })
  .loose()
  .describe("One line item of a Play subscription purchase.");

/**
 * `purchases.subscriptionsv2.get`, as much of it as the projection reads. `.loose()` keeps the rest: Play adds
 * fields, the whole response is stored for reconciliation, and a strict object would refuse a real purchase for
 * carrying something new.
 */
export const PlaySubscriptionPurchase = z
  .object({
    subscriptionState: z
      .string()
      .min(1)
      .describe("Play's own state for the subscription. Mapped to a normalized status; an unknown one is refused."),
    latestOrderId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The most recent order. This is the transaction identity — it changes every renewal, which is what makes each period its own purchase row.",
      ),
    startTime: z.string().min(1).optional().describe("When the subscription began, RFC 3339."),
    linkedPurchaseToken: z
      .string()
      .min(1)
      .optional()
      .describe("The token this purchase replaced, on an upgrade or a resubscribe."),
    acknowledgementState: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Whether the app has acknowledged the purchase. Recorded, never mapped: an unacknowledged purchase is still paid, and acknowledging is the app's job through Play Billing.",
      ),
    testPurchase: z
      .object({})
      .loose()
      .optional()
      .describe(
        "Present only for a licence-test purchase. Its presence is the whole environment decision for a subscription.",
      ),
    pausedStateContext: z
      .object({
        autoResumeTime: z.string().min(1).optional().describe("When a paused subscription resumes, RFC 3339."),
      })
      .loose()
      .optional()
      .describe("Present while the subscription is paused."),
    externalAccountIdentifiers: z
      .object({
        obfuscatedExternalAccountId: z
          .string()
          .min(1)
          .optional()
          .describe("The identifier the app set at purchase time — the only hook back to a Pithy user."),
        obfuscatedExternalProfileId: z
          .string()
          .min(1)
          .optional()
          .describe("The profile identifier, if the app set one."),
      })
      .loose()
      .optional()
      .describe("The identifiers the app attached to the purchase."),
    lineItems: z
      .array(PlaySubscriptionLineItem)
      .min(1)
      .describe("What the subscription includes. The first line item is the product this purchase is projected as."),
  })
  .loose()
  .describe("Play's SubscriptionPurchaseV2, as much of it as the projection reads.");
export type PlaySubscriptionPurchase = z.infer<typeof PlaySubscriptionPurchase>;

/** `purchases.products.get`, as much of it as the projection reads. `.loose()` for the same reason. */
export const PlayProductPurchase = z
  .object({
    purchaseState: z
      .number()
      .int()
      .describe("0 purchased, 1 canceled, 2 pending. Mapped to a normalized status; an unknown one is refused."),
    purchaseTimeMillis: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .describe("When the purchase was made, as a decimal string of milliseconds since the epoch."),
    orderId: z
      .string()
      .min(1)
      .optional()
      .describe("The order. This is the transaction identity for a one-time purchase. Absent until it is paid."),
    purchaseType: z
      .number()
      .int()
      .optional()
      .describe(
        "0 test, 1 promo, 2 rewarded — and absent for an ordinary paid purchase. Only 0 makes it a sandbox purchase.",
      ),
    acknowledgementState: z
      .number()
      .int()
      .optional()
      .describe("0 unacknowledged, 1 acknowledged. Recorded, never mapped — the app owns acknowledging."),
    consumptionState: z.number().int().optional().describe("0 yet to be consumed, 1 consumed. Recorded only."),
    quantity: z.number().int().optional().describe("How many were bought. One unless the product allows more."),
    obfuscatedExternalAccountId: z
      .string()
      .min(1)
      .optional()
      .describe("The identifier the app set at purchase time — the only hook back to a Pithy user."),
    regionCode: z.string().min(1).optional().describe("Where the purchase was made. Recorded only."),
  })
  .loose()
  .describe("Play's ProductPurchase, as much of it as the projection reads.");
export type PlayProductPurchase = z.infer<typeof PlayProductPurchase>;

/** What a Play lookup needs: the credentials, a clock, and the transport. */
export interface PlayApiOptions {
  /** Google's credential block. The package name is part of every URL; the key signs the assertion. */
  credentials: PaymentsGoogleCredentials;
  /** The clock. Injected so an assertion's `iat` is deterministic in tests. */
  now: Date;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: GoogleHttpFetch;
  /**
   * An access token already minted, so a batch of lookups pays for one.
   *
   * Deliberately a parameter rather than a module-level cache: an access token is a bearer credential derived
   * from a secret, and CLAUDE.md is explicit that a resolved secret is never cached in a module variable. So a
   * single webhook mints one and drops it, and the reconciliation Workflow — which is the caller that makes
   * hundreds of calls — mints one and passes it down.
   */
  accessToken?: string;
}

/** What one lookup resolved: the normalized transaction, and the store account to link it by. */
export interface PlayPurchaseState {
  /** The transaction, normalized. The route binds the owner onto it. */
  event: UnboundProviderEvent;
  /** The identifier the app attached at purchase time, or null. */
  providerAccountId: string | null;
}

/**
 * Mint an access token for the Play Developer API from the service-account key.
 *
 * The JWT-bearer grant: we sign an assertion saying who we are and what we want, Google hands back a token. No
 * refresh token, no user consent, nothing stored — which is why the credential bundle holds a private key
 * rather than an OAuth client.
 */
export async function mintPlayAccessToken(
  credentials: PaymentsGoogleCredentials,
  options: { now: Date; transport?: GoogleHttpFetch },
): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemPrivateKey(credentials.privateKey) as unknown as ArrayBuffer,
      RS256,
      false,
      ["sign"],
    );
  } catch (cause) {
    if (cause instanceof PaymentsRailNotConfiguredError) throw cause;
    // A key that will not import is a provisioning failure, not a store outage, and it will not fix itself.
    throw new PaymentsRailNotConfiguredError(
      { detail: "Google: the service-account private key could not be imported as a PKCS#8 RSA key." },
      { cause },
    );
  }

  const issuedAt = Math.floor(options.now.getTime() / 1000);
  const encoder = new TextEncoder();
  const head = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        iss: credentials.serviceAccountEmail,
        scope: PLAY_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(RS256.name, key, encoder.encode(`${head}.${body}`) as unknown as ArrayBuffer),
  );
  const assertion = `${head}.${body}.${base64UrlEncode(signature)}`;

  const answered = await googleJson(options.transport ?? googleHttpFetch, GOOGLE_TOKEN_URL, {
    what: "an access token for the Play Developer API",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  const parsed = GoogleAccessToken.safeParse(answered);
  if (!parsed.success) {
    throw new PaymentsProviderUnavailableError({
      detail: "Google: the token endpoint answered without an access token.",
    });
  }
  return parsed.data.access_token;
}

/** The access token for one lookup: the caller's, or a freshly minted one. */
async function bearer(options: PlayApiOptions): Promise<string> {
  return options.accessToken ?? (await mintPlayAccessToken(options.credentials, options));
}

/**
 * The current state of a subscription purchase token, or `undefined` when Play has no subscription under it.
 *
 * `undefined` is how a one-time purchase identifies itself: Play has no "what kind of purchase is this" call, so
 * the subscription endpoint's 404 is the answer. That is why this is the probe and the product lookup is the
 * fallback — the subscription call takes a token alone, while the product call needs a product id we would
 * otherwise have to take on a client's word.
 */
export async function fetchPlaySubscription(
  purchaseToken: string,
  options: PlayApiOptions,
): Promise<PlaySubscriptionPurchase | undefined> {
  const url = `${PLAY_API_BASE}/applications/${encodeURIComponent(options.credentials.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const answered = await googleJson(options.transport ?? googleHttpFetch, url, {
    what: "the subscription purchase",
    headers: { authorization: `Bearer ${await bearer(options)}` },
    absentOn404: true,
  });
  if (answered === undefined) return undefined;
  return parseOrRefuse(PlaySubscriptionPurchase, answered, "SubscriptionPurchaseV2");
}

/**
 * The current state of a one-time purchase token under one product id, or `undefined` when Play has none.
 *
 * The product id is part of the URL, which is what makes a client-declared one safe to use: Play answers 404
 * when the token does not belong to that product, so presenting a cheap token under an expensive SKU fails at
 * Google rather than being believed here.
 */
export async function fetchPlayProduct(
  productId: string,
  purchaseToken: string,
  options: PlayApiOptions,
): Promise<PlayProductPurchase | undefined> {
  const url = `${PLAY_API_BASE}/applications/${encodeURIComponent(options.credentials.packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const answered = await googleJson(options.transport ?? googleHttpFetch, url, {
    what: "the one-time purchase",
    headers: { authorization: `Bearer ${await bearer(options)}` },
    absentOn404: true,
  });
  if (answered === undefined) return undefined;
  return parseOrRefuse(PlayProductPurchase, answered, "ProductPurchase");
}

/** The normalized status for a Play subscription state. An unmapped state is refused, never granted. */
export function playSubscriptionStatus(state: string): PurchaseStatus {
  const status = SUBSCRIPTION_STATES[state];
  if (status === undefined) {
    // Play could add a state, and the only safe answer to one we have never seen is to project nothing. Guessing
    // `active` would grant on a state that might mean the opposite; guessing `expired` would revoke a paying
    // subscriber. Refusing leaves the row untouched and the notification recorded for reconciliation.
    throw new PaymentsVerificationFailedError({
      detail: `Google: subscription state "${state}" is not one this build maps. The purchase was left as it stood.`,
    });
  }
  return status;
}

/** The normalized status for a Play one-time purchase state. An unmapped state is refused, never granted. */
export function playProductStatus(purchaseState: number): PurchaseStatus {
  const status = PRODUCT_STATES[purchaseState];
  if (status === undefined) {
    throw new PaymentsVerificationFailedError({
      detail: `Google: purchase state ${purchaseState} is not one this build maps. The purchase was left as it stood.`,
    });
  }
  return status;
}

/** What both mappings need from their caller: the token, the event time, and any override. */
export interface PlayEventContext {
  /** The purchase token, which is the subscription family's identity and the lookup's key. */
  purchaseToken: string;
  /** The provider event time — the notification's, or the clock on a client submission. Never invented here. */
  eventAt: Date;
  /**
   * A status the notification knows and the API does not. Only ever `revoked`, from
   * `SUBSCRIPTION_REVOKED` — see `rtdn.ts`.
   */
  statusOverride?: PurchaseStatus | null;
}

/** One Play subscription purchase, normalized. */
export function playSubscriptionEvent(
  purchase: PlaySubscriptionPurchase,
  context: PlayEventContext,
): PlayPurchaseState {
  // The first line item. Play's multi-line subscriptions bundle add-ons under one token, which would be several
  // purchases rather than one, and that is not something v1 sells — so the first is the product, and a bundle
  // would need a design rather than a loop.
  const item = purchase.lineItems[0] as z.infer<typeof PlaySubscriptionLineItem>;
  const status = context.statusOverride ?? playSubscriptionStatus(purchase.subscriptionState);
  const expiresAt = item.expiryTime === undefined ? null : timestamp(item.expiryTime, "the expiry time");

  const event: UnboundProviderEvent = {
    rail: "google",
    // The order id, not the token: it changes every renewal, so each period is its own row and a `grants` clause
    // fires once per period. A subscription that has never been paid has no order yet, and keying it on the
    // token is right — there is no transaction to key it on, and the first order will replace it.
    providerTransactionId: purchase.latestOrderId ?? context.purchaseToken,
    providerProductId: item.productId,
    status,
    environment: subscriptionEnvironment(purchase),
    // Play reports no start time on a purchase that has not been paid for. The event time is then the closest
    // honest answer, and `purchasedAt` is not what any access decision rests on.
    purchasedAt: purchase.startTime === undefined ? context.eventAt : timestamp(purchase.startTime, "the start time"),
    expiresAt,
    // Play does not date a revocation. The notification's own time is when we learned of it, which is the only
    // timestamp either side actually has.
    revokedAt: status === "revoked" || status === "refunded" ? context.eventAt : null,
    // The token is the family key: every renewal of one subscription carries the same one, which is what lets a
    // renewal's owner be resolved from the purchase that started it.
    originalTransactionId: context.purchaseToken,
    // Play's purchase API reports no price. See the module doc: these columns are nullable for exactly this.
    amountMinor: null,
    currency: null,
    providerEventAt: context.eventAt,
    payload: purchase as Record<string, unknown>,
  };

  return { event, providerAccountId: purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null };
}

/** One Play one-time purchase, normalized. */
export function playProductEvent(
  purchase: PlayProductPurchase,
  context: PlayEventContext & { productId: string },
): PlayPurchaseState {
  const status = context.statusOverride ?? playProductStatus(purchase.purchaseState);

  const event: UnboundProviderEvent = {
    rail: "google",
    // A one-time purchase has exactly one order, so the order id is its identity. A pending purchase has none
    // yet; the token stands in until it does, and the upsert replaces the row on the same key when it arrives.
    providerTransactionId: purchase.orderId ?? context.purchaseToken,
    providerProductId: context.productId,
    status,
    environment: purchase.purchaseType === PLAY_PURCHASE_TYPE_TEST ? "sandbox" : "production",
    purchasedAt:
      purchase.purchaseTimeMillis === undefined ? context.eventAt : new Date(Number(purchase.purchaseTimeMillis)),
    // A one-time purchase never lapses. That is the whole difference between a non-consumable and a
    // subscription, and it is why a null expiry beats every dated one when an entitlement is derived.
    expiresAt: null,
    revokedAt: status === "revoked" || status === "refunded" ? context.eventAt : null,
    // Nothing chains a one-time purchase to anything else.
    originalTransactionId: null,
    amountMinor: null,
    currency: null,
    providerEventAt: context.eventAt,
    payload: purchase as Record<string, unknown>,
  };

  return { event, providerAccountId: purchase.obfuscatedExternalAccountId ?? null };
}

/**
 * Resolve one notification pointer to a state, or `undefined` when Play has no purchase under that token.
 *
 * The pointer says which lookup to make, so there is no probing on this path — the notification already told us
 * whether it concerns a subscription or a one-time product.
 */
export async function resolvePlayPointer(
  pointer: GoogleNotificationPointer,
  options: PlayApiOptions,
): Promise<PlayPurchaseState | undefined> {
  const context = {
    purchaseToken: pointer.purchaseToken,
    eventAt: pointer.eventAt,
    statusOverride: pointer.statusOverride,
  };

  if (pointer.kind === "subscription") {
    const purchase = await fetchPlaySubscription(pointer.purchaseToken, options);
    return purchase === undefined ? undefined : playSubscriptionEvent(purchase, context);
  }

  // A one-time notification always names its sku, so there is nothing to fall back on and nothing to guess.
  if (pointer.productId === null) return undefined;
  const purchase = await fetchPlayProduct(pointer.productId, pointer.purchaseToken, options);
  return purchase === undefined ? undefined : playProductEvent(purchase, { ...context, productId: pointer.productId });
}

/**
 * Re-read one stored purchase at Play, normalized — the reconciliation path for this rail.
 *
 * **Subscriptions only, and the reason is what the row keeps.** A Play purchase is addressed by its *purchase
 * token*, and only a subscription row stores one: `originalTransactionId` is the token, because the token is
 * the family key every renewal shares. A one-time row is keyed on Play's order id and stores no token at all,
 * and `purchases.products.get` takes a token — so there is no call this function could make for one. That is a
 * real gap rather than a shortcut: a refunded one-time Play purchase reaches this deployment as a
 * voided-purchase notification, which is recorded with its order id and its reason, and repairing it needs the
 * token recovered from somewhere the row does not have it.
 *
 * A subscription that has never been paid has no order id yet and is keyed on its own token, so
 * `originalTransactionId` is null and `providerTransactionId` is the token. Both spellings resolve.
 */
export async function refreshPlayPurchase(
  purchase: PaymentsPurchase,
  options: PlayApiOptions,
): Promise<UnboundProviderEvent | undefined> {
  if (purchase.type !== "subscription") return undefined;

  const purchaseToken = purchase.originalTransactionId ?? purchase.providerTransactionId;
  const found = await fetchPlaySubscription(purchaseToken, options);
  if (found === undefined) return undefined;

  // The clock, not a Play timestamp — Play dates neither the state nor the read, and a refresh is the freshest
  // fact anyone has. Dating it older would let the monotonic write rule discard the repair.
  return playSubscriptionEvent(found, { purchaseToken, eventAt: options.now }).event;
}

/** A subscription's environment. `testPurchase` present is the whole decision; absent means a real purchase. */
function subscriptionEnvironment(purchase: PlaySubscriptionPurchase): PurchaseEnvironment {
  return purchase.testPurchase === undefined ? "production" : "sandbox";
}

/** One RFC 3339 timestamp from Play. An unreadable one is refused rather than becoming an Invalid Date. */
function timestamp(value: string, what: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // An Invalid Date would encode as NaN and lose every comparison the monotonic write rule makes.
    throw new PaymentsVerificationFailedError({ detail: `Google: ${what} "${value}" is not a timestamp.` });
  }
  return parsed;
}

/** Parse a Play response, or refuse it. Never echoes the body: the response quotes the purchase token. */
function parseOrRefuse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PaymentsVerificationFailedError({
      detail: `Google: the answer is not a ${what} — ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ")}.`,
    });
  }
  return parsed.data as z.output<T>;
}
