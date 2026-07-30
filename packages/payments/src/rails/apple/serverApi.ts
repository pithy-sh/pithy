import { z } from "zod";
import { minorUnitsFromScaled } from "../../data/money";
import type { PaymentsPurchase, PurchaseEnvironment } from "../../data/purchase";
import type { PurchaseStatus } from "../../data/status";
import { PaymentsRailNotConfiguredError, PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsAppleCredentials } from "../../secret/registry";
import type { UnboundProviderEvent } from "../contract";
import { decodeBase64 } from "./der";
import { type AppleHttpFetch, appleHttpFetch, appleJson } from "./http";
import { verifyAppleJws } from "./jws";
import {
  APPLE_PRICE_SCALE,
  AppleRenewalInfo,
  AppleTransactionInfo,
  appleEnvironment,
  appleExpiresAt,
  requireAppleBundle,
} from "./notification";

/**
 * The App Store Server API — the call that answers "what is this subscription doing now", and the mapping of
 * Apple's status vocabulary into the normalized set.
 *
 * This is the half of Apple's rail nothing else needs. A client submission and a notification both arrive
 * signed, so they verify offline and cost no round-trip. Reconciliation has neither: the whole point of it is
 * the subscription **nothing arrived about**, because Apple stopped renewing and sent nothing, or sent
 * something that never reached us. Asking Apple is the only way to learn that, and this is where it is asked.
 *
 * ## Two facts, and only one of them is in the transaction
 *
 * `GET /inApps/v1/subscriptions/{originalTransactionId}` returns, per subscription group, the last transaction
 * plus a **numeric status** — and the numeric status carries what the signed transaction cannot. A transaction
 * says when it expires; it does not say that Apple is in a billing retry, or that the subscriber is inside a
 * grace period, or how long that grace runs, or that auto-renew was switched off. So the status **and the
 * access window** come from Apple's number and the renewal info beside it, and everything else — the product,
 * the purchase date, the price, the account token — comes from the signed transaction, verified against the
 * same pinned chain every other Apple payload is.
 *
 * ## The two hosts are not interchangeable
 *
 * Sandbox and production are separate services with separate data. A production transaction id asked of the
 * sandbox host is a 404, not an error, so the host is chosen from the **stored row's own environment** rather
 * than from the deployment's or from a probe. That also means a sandbox row in a production database — which
 * the writer refuses to create — could never be refreshed into one.
 *
 * ## What is not here
 *
 * **One-time purchases.** Apple's subscription endpoint is for auto-renewables only, and a consumable or
 * non-consumable does not drift: it is bought once, and the single thing that can change it — a refund —
 * arrives as a `REFUND` notification. There is a transaction-history endpoint that would answer for one, and
 * nothing in this module needs it, so nothing here calls it.
 */

/**
 * The App Store Server API's two bases, one per store environment.
 *
 * Public and stable, so they are pinned rather than configured. The keying is on the *purchase's* environment,
 * which is why this is a record rather than a single constant.
 */
export const APPLE_API_BASES: Readonly<Record<PurchaseEnvironment, string>> = {
  production: "https://api.storekit.itunes.apple.com/inApps/v1",
  sandbox: "https://api.storekit-sandbox.itunes.apple.com/inApps/v1",
};

/** The audience every App Store Connect API token claims. Apple's own literal, not a URL. */
export const APPLE_API_AUDIENCE = "appstoreconnect-v1";

/**
 * How long a minted token claims to be good for. Apple refuses anything over an hour, and a token minted at
 * the ceiling is one clock-skew away from being refused — so this sits comfortably under it.
 */
export const APPLE_TOKEN_LIFETIME_SECONDS = 1800;

/** ECDSA over P-256 with SHA-256 — `ES256`, the only algorithm App Store Connect accepts. */
const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The PEM armour an App Store Connect `.p8` carries. Apple issues PKCS#8 and nothing else. */
const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";

/**
 * Apple's subscription status codes, mapped.
 *
 * Three are worth reading twice. **3 is billing retry and does not grant**: Apple is retrying the card and the
 * subscriber's access has already ended, which is what `on_hold` means. **4 is the grace period and does
 * grant** — that is the point of grace, a failed card should not lock a paying subscriber out mid-period, and
 * the window it grants through is the renewal info's `gracePeriodExpiresDate` rather than the transaction's
 * expiry, which has already passed by the time Apple says 4. And
 * **auto-renew off is `canceled`, which also grants**: declining the *next* period does not forfeit the one
 * already paid for, and `expiresAt` is what ends it.
 */
const SUBSCRIPTION_STATUSES: Readonly<Record<number, PurchaseStatus>> = {
  1: "active",
  2: "expired",
  3: "on_hold",
  4: "in_grace",
  5: "revoked",
};

/** Apple's `autoRenewStatus` for a subscription the user has switched off. */
const AUTO_RENEW_OFF = 0;

/** One entry of a subscription group's `lastTransactions` array. */
const AppleLastTransaction = z
  .object({
    originalTransactionId: z
      .string()
      .min(1)
      .describe("The transaction that started this subscription — how the right entry is picked out of the group."),
    status: z
      .number()
      .int()
      .describe(
        "Apple's numeric subscription status: 1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked. The one fact the signed transaction does not carry.",
      ),
    signedTransactionInfo: z
      .string()
      .min(1)
      .describe("The latest transaction, as its own JWS. Verified against the pinned chain like every other one."),
    signedRenewalInfo: z
      .string()
      .min(1)
      .optional()
      .describe("The renewal state, as its own JWS. Absent for a subscription with no renewal left to describe."),
  })
  .loose()
  .describe("One subscription's latest transaction and its status, as the App Store Server API reports it.");

/**
 * The App Store Server API's answer to a subscription-status query.
 *
 * `data` is one entry per subscription group, and each carries every transaction in the family the queried id
 * belongs to. In practice one id resolves to one group with one transaction; the shape allows more, so the
 * caller matches on the id rather than trusting position.
 */
export const AppleSubscriptionStatuses = z
  .object({
    environment: z
      .string()
      .min(1)
      .describe("`Production` or `Sandbox`, as the answering host reports it. Checked against the row's own."),
    bundleId: z.string().min(1).describe("The app the subscription belongs to. Checked against our own."),
    data: z
      .array(
        z
          .object({
            lastTransactions: z
              .array(AppleLastTransaction)
              .describe("The latest transaction per subscription in this group, with its status."),
          })
          .loose()
          .describe("One subscription group's latest state."),
      )
      .describe("One entry per subscription group the queried transaction belongs to."),
  })
  .loose()
  .describe("Apple's StatusResponse — the current state of a subscription family.");
export type AppleSubscriptionStatuses = z.infer<typeof AppleSubscriptionStatuses>;

/** What an App Store Server API call needs: the credentials, a clock, the transport, and the trust set. */
export interface AppleServerApiOptions {
  /** Apple's credential block. The key signs the token; the bundle id is checked on the answer. */
  credentials: PaymentsAppleCredentials;
  /** The clock. It dates the token, and it becomes the refreshed event's provider event time. */
  now: Date;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: AppleHttpFetch;
  /** Roots accepted in addition to Apple's pinned ones, base64 DER. Additive only, and empty in production. */
  roots?: readonly string[];
  /**
   * A token already minted, so a batch of lookups pays for one.
   *
   * Deliberately a parameter rather than a module-level cache: a bearer credential derived from a secret is
   * exactly what CLAUDE.md forbids caching in a module variable. So a single call mints one and drops it, and
   * the reconciliation Workflow — the caller that makes hundreds — mints one and passes it down.
   */
  token?: string;
}

/**
 * The DER bytes of an App Store Connect `.p8`.
 *
 * A copy of what the Google rail does with its service-account key, and a copy on purpose: a rail reaching
 * into another rail's module for a helper would make the two fail together, and the same choice was already
 * made for the two spellings of the webhook body schema. Twelve lines is the cheaper coupling.
 */
function applePrivateKey(pem: string): Uint8Array {
  // `.p8` contents pasted through a JSON secret arrive with literal backslash-n rather than newlines.
  const text = pem.replaceAll("\\n", "\n");
  if (!text.includes(PKCS8_HEADER)) {
    throw new PaymentsRailNotConfiguredError({
      detail: text.includes("PRIVATE KEY")
        ? "Apple: the App Store Connect key is not PKCS#8. Store the downloaded `.p8` verbatim — it begins `-----BEGIN PRIVATE KEY-----`."
        : "Apple: the App Store Connect key carries no PEM armour. Store the downloaded `.p8` file's contents verbatim, header and footer included.",
    });
  }
  const body = text
    .slice(text.indexOf(PKCS8_HEADER) + PKCS8_HEADER.length)
    .replace(/-----END PRIVATE KEY-----[\s\S]*$/, "")
    .replaceAll(/\s+/g, "");
  try {
    return decodeBase64(body);
  } catch (cause) {
    throw new PaymentsRailNotConfiguredError(
      { detail: "Apple: the App Store Connect key's PEM body is not valid base64." },
      { cause },
    );
  }
}

/** base64url of raw bytes, unpadded — the encoding every JWT segment uses. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** base64url of a JSON value — a JWT header or claim set. */
function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Mint an App Store Connect API token from the `.p8` key.
 *
 * A plain ES256 JWT: Apple issues no OAuth flow for this API, so the assertion *is* the credential. The `bid`
 * claim is what scopes it to one app — a token without it is refused, which is why the bundle id sits in the
 * credential block beside the key rather than in config.
 */
export async function mintAppleApiToken(
  credentials: PaymentsAppleCredentials,
  options: { now: Date },
): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      applePrivateKey(credentials.privateKey) as unknown as ArrayBuffer,
      ES256,
      false,
      ["sign"],
    );
  } catch (cause) {
    if (cause instanceof PaymentsRailNotConfiguredError) throw cause;
    // A key that will not import is a provisioning failure, not a store outage, and it will not fix itself.
    throw new PaymentsRailNotConfiguredError(
      {
        detail:
          "Apple: the App Store Connect private key could not be imported as a P-256 key. Check that the `.p8` was stored whole and belongs to an App Store Connect API key.",
      },
      { cause },
    );
  }

  const issuedAt = Math.floor(options.now.getTime() / 1000);
  const header = base64UrlJson({ alg: "ES256", kid: credentials.keyId, typ: "JWT" });
  const claims = base64UrlJson({
    iss: credentials.issuerId,
    iat: issuedAt,
    exp: issuedAt + APPLE_TOKEN_LIFETIME_SECONDS,
    aud: APPLE_API_AUDIENCE,
    bid: credentials.bundleId,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${claims}`) as unknown as ArrayBuffer,
  );
  // WebCrypto's ECDSA signature is already the raw r‖s pair a JWS wants, not the DER wrapper X.509 uses.
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

/** The token to send: the one the caller minted for the batch, or one minted for this call alone. */
async function bearer(options: AppleServerApiOptions): Promise<string> {
  return options.token ?? (await mintAppleApiToken(options.credentials, { now: options.now }));
}

/** The normalized status for an Apple subscription status code and its renewal flag. */
export function appleSubscriptionStatus(status: number, autoRenewStatus: number | undefined): PurchaseStatus {
  const mapped = SUBSCRIPTION_STATUSES[status];
  if (mapped === undefined) {
    // Apple could add a code, and the only safe answer to one we have never seen is to project nothing.
    // Guessing `active` would grant on a state that might mean the opposite; guessing `expired` would revoke a
    // paying subscriber. Refusing leaves the row exactly as it stood.
    throw new PaymentsVerificationFailedError({
      detail: `Apple: subscription status ${status} is not one this build maps. The purchase was left as it stood.`,
    });
  }
  // Auto-renew off narrows `active` and nothing else. A subscription in grace or in billing retry with renewal
  // switched off is still in grace or in billing retry — that is the more urgent fact and the one that decides
  // access, and overwriting it with `canceled` would say a failed card was the user's choice.
  return mapped === "active" && autoRenewStatus === AUTO_RENEW_OFF ? "canceled" : mapped;
}

/**
 * The current state of a subscription family, or `undefined` when Apple has none under that id.
 *
 * `undefined` is a real answer, not a failure: a transaction id from the other store environment, or one from
 * an app this key does not cover, is a 404. A store that cannot be reached throws instead.
 */
export async function fetchAppleSubscriptionStatuses(
  originalTransactionId: string,
  environment: PurchaseEnvironment,
  options: AppleServerApiOptions,
): Promise<AppleSubscriptionStatuses | undefined> {
  const url = `${APPLE_API_BASES[environment]}/subscriptions/${encodeURIComponent(originalTransactionId)}`;
  const answered = await appleJson(options.transport ?? appleHttpFetch, url, {
    what: "the subscription statuses",
    headers: { authorization: `Bearer ${await bearer(options)}` },
    absentOn404: true,
  });
  if (answered === undefined) return undefined;

  const parsed = AppleSubscriptionStatuses.safeParse(answered);
  if (!parsed.success) {
    // Never echo the body: it carries the signed transaction, which is the artifact a stolen receipt looks like.
    throw new PaymentsVerificationFailedError({
      detail: `Apple: the answer is not a StatusResponse — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ")}.`,
    });
  }
  return parsed.data;
}

/**
 * Re-read one stored subscription at Apple, normalized — the reconciliation path for this rail.
 *
 * Returns `undefined` for a purchase Apple's subscription endpoint cannot speak for: a one-time purchase, or a
 * transaction id the queried environment does not know. Both leave the row untouched, which is right — a
 * subscription we cannot read is not evidence of anything.
 */
export async function refreshAppleSubscription(
  purchase: PaymentsPurchase,
  options: AppleServerApiOptions,
): Promise<UnboundProviderEvent | undefined> {
  // Consumables and non-consumables are out of this endpoint's scope, and out of reconciliation's: they are
  // bought once and the only thing that changes them is a refund, which arrives as its own notification.
  if (purchase.type !== "subscription") return undefined;

  // The family key. A renewal's row carries the id of the transaction that started the subscription; the first
  // row of a family carries none, and is its own family key.
  const familyId = purchase.originalTransactionId ?? purchase.providerTransactionId;
  const statuses = await fetchAppleSubscriptionStatuses(familyId, purchase.environment, options);
  if (statuses === undefined) return undefined;

  requireAppleBundle(statuses.bundleId, options.credentials.bundleId, "subscription status");

  const entries = statuses.data.flatMap((group) => group.lastTransactions);
  // Matched on the id rather than taken by position: a query resolves the whole group, and a group can hold
  // more than one subscription. Taking `[0]` would occasionally refresh a row with a sibling's state.
  const entry = entries.find((candidate) => candidate.originalTransactionId === familyId);
  if (entry === undefined) return undefined;

  const transaction = await verify(entry.signedTransactionInfo, AppleTransactionInfo, "transaction", options);
  requireAppleBundle(transaction.bundleId, options.credentials.bundleId, "transaction");
  const renewal =
    entry.signedRenewalInfo === undefined
      ? undefined
      : await verify(entry.signedRenewalInfo, AppleRenewalInfo, "renewal info", options);

  // A revocation wins over every status code. Apple reports a revoked subscription as status 5, but it also
  // dates the revocation on the transaction, and a refunded purchase inside its paid period must not grant
  // whatever the group says.
  const status =
    transaction.revocationDate === undefined
      ? appleSubscriptionStatus(entry.status, renewal?.autoRenewStatus)
      : "refunded";

  return {
    rail: "apple",
    providerTransactionId: transaction.transactionId,
    providerProductId: transaction.productId,
    status,
    environment: appleEnvironment(transaction.environment),
    purchasedAt: new Date(transaction.purchaseDate),
    // Status 4 says a card is being retried, and the window it is retried through is on the renewal info. The
    // transaction's own `expiresDate` is already in the past by then, so carrying it alone would refresh a row
    // into a lapse — the opposite of what Apple just reported.
    expiresAt: appleExpiresAt(status, transaction.expiresDate, renewal?.gracePeriodExpiresDate),
    revokedAt: transaction.revocationDate === undefined ? null : new Date(transaction.revocationDate),
    originalTransactionId: transaction.originalTransactionId ?? null,
    amountMinor: minorUnitsFromScaled(transaction.price ?? null, APPLE_PRICE_SCALE, transaction.currency ?? null),
    currency: transaction.currency ?? null,
    // The clock, not the transaction's `signedDate`. A refresh is a read of the state *now*, and the status it
    // carries comes from the group rather than from the transaction — so dating it by a transaction Apple
    // signed weeks ago would let the monotonic write rule discard the very repair this call was made for.
    providerEventAt: options.now,
    payload: { transaction, status: entry.status, renewalInfo: renewal ?? null },
  };
}

/** Verify one nested JWS against the pinned chain and parse it, naming the field in any refusal. */
async function verify<T extends z.ZodType>(
  jws: string,
  schema: T,
  field: string,
  options: AppleServerApiOptions,
): Promise<z.output<T>> {
  const payload = await verifyAppleJws(jws, { roots: options.roots, now: options.now });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PaymentsVerificationFailedError({
      detail: `Apple: the ${field} in the subscription status rejected — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ")}.`,
    });
  }
  return parsed.data as z.output<T>;
}
