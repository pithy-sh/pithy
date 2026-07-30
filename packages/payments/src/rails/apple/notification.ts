// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { minorUnitsFromScaled } from "../../data/money";
import type { PurchaseEnvironment } from "../../data/purchase";
import type { PurchaseStatus } from "../../data/status";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import type { UnboundProviderEvent, VerifiedNotification } from "../contract";
import { verifyAppleJws } from "./jws";

/**
 * App Store Server Notifications V2 → the normalized provider event.
 *
 * This is where Apple's vocabulary stops. Apple has more than twenty notification types and a dozen
 * subtypes; the projection has eight statuses and does not branch on any store's names. Getting a row of
 * that table wrong revokes or grants access to somebody real, which is why each mapping below carries the
 * reason rather than only the answer.
 *
 * Two decisions shape the rest:
 *
 * **A notification can be authentic and mean nothing about a purchase.** A test notification, a consumption
 * request, a declined refund, a bulk renewal-extension summary — all real, none a state change. And Apple
 * adds types: a type this package has never heard of must not be an error, because answering non-2xx makes
 * Apple retry it forever and reads as a broken endpoint. So `event` is nullable, the row is recorded either
 * way, and the reconciliation pass is what notices if something meaningful was missed.
 *
 * **The bundle id is checked, twice.** A valid Apple signature proves Apple signed the notification, not
 * that it is about our app — Apple signs every developer's notifications with the same chain. Without a
 * bundle check, another developer's transaction verifies here, and any SKU string that happens to match our
 * catalog becomes a free entitlement. Both the envelope's `data.bundleId` and the nested transaction's own
 * `bundleId` are checked, because a notification assembled around somebody else's transaction would pass a
 * check on either one alone.
 */

/** Apple's price scale: `price` is in thousandths of the currency unit, not in minor units. */
export const APPLE_PRICE_SCALE = 1000;

/**
 * The transaction payload, as much of it as the projection uses. `.loose()` keeps the rest: Apple adds
 * fields, the whole payload is stored for reconciliation, and a strict object would reject a notification
 * for carrying something new.
 */
export const AppleTransactionInfo = z
  .object({
    transactionId: z
      .string()
      .min(1)
      .describe("Apple's own id for this transaction — the projection's idempotency anchor."),
    originalTransactionId: z
      .string()
      .min(1)
      .optional()
      .describe("The transaction that started the subscription, chaining renewals back to it. Absent for a one-off."),
    bundleId: z
      .string()
      .min(1)
      .describe(
        "The app the purchase was made in. Checked against our own — a signature alone does not prove the app.",
      ),
    productId: z.string().min(1).describe("The App Store Connect product identifier — the SKU the catalog maps."),
    purchaseDate: z.number().int().describe("When the store recorded the purchase, in milliseconds since the epoch."),
    expiresDate: z
      .number()
      .int()
      .optional()
      .describe("When the paid period ends, for a subscription. Absent for a one-time purchase."),
    revocationDate: z.number().int().optional().describe("When the purchase was refunded or revoked, if it was."),
    signedDate: z.number().int().describe("When Apple signed this transaction — its own clock, not ours."),
    environment: z
      .string()
      .min(1)
      .describe("`Production`, `Sandbox`, or a local-testing value. Anything but Production is treated as sandbox."),
    appAccountToken: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The UUID the app set at purchase time. The only hook back to a Pithy user, so a purchase without one arrives orphaned.",
      ),
    price: z
      .number()
      .int()
      .optional()
      .describe("The price in thousandths of the currency unit — Apple's milliunits, not minor units."),
    currency: z.string().min(1).optional().describe("The ISO currency the price is in."),
  })
  .loose()
  .describe("Apple's JWSTransactionDecodedPayload, as much of it as the projection reads.");

/**
 * The renewal state beside a transaction, as much of it as the projection reads. `.loose()` for the same
 * reason every other Apple schema is: Apple adds fields, and the payload is stored whole.
 *
 * Two fields, and both decide access rather than describe it. Neither is on the transaction, which is the
 * whole reason this payload is read at all: a transaction says when the paid period ended, and only the
 * renewal info says whether a card is being retried past it and until when.
 */
export const AppleRenewalInfo = z
  .object({
    autoRenewStatus: z
      .number()
      .int()
      .optional()
      .describe(
        "Whether the subscription will renew — 1 on, 0 off. Off with an active status is `canceled`, which still grants until the paid period ends.",
      ),
    gracePeriodExpiresDate: z
      .number()
      .int()
      .optional()
      .describe(
        "When the billing-retry grace window ends, in milliseconds. This is what access runs to while Apple retries the card — the transaction's own `expiresDate` has already passed by then.",
      ),
  })
  .loose()
  .describe("Apple's JWSRenewalInfoDecodedPayload, as much of it as the status and the access window read.");

/** The notification envelope. Also `.loose()`, and for the same reason. */
const AppleNotificationPayload = z
  .object({
    notificationType: z
      .string()
      .min(1)
      .describe("What happened, in Apple's vocabulary. Mapped to a normalized status."),
    subtype: z
      .string()
      .min(1)
      .optional()
      .describe("The qualifier that decides several mappings — GRACE_PERIOD, AUTO_RENEW_DISABLED, INITIAL_BUY."),
    notificationUUID: z
      .string()
      .min(1)
      .describe("Apple's id for this delivery. The dedupe key: Apple delivers at-least-once and retries."),
    signedDate: z
      .number()
      .int()
      .describe(
        "When Apple signed the notification. This is the provider event time the monotonic write rule compares.",
      ),
    data: z
      .object({
        bundleId: z.string().min(1).describe("The app the notification is about. Checked against our own."),
        environment: z.string().min(1).describe("The store environment the event happened in."),
        signedTransactionInfo: z
          .string()
          .min(1)
          .optional()
          .describe("The transaction, as its own signed JWS. Absent for a notification that reports no transaction."),
        signedRenewalInfo: z
          .string()
          .min(1)
          .optional()
          .describe("The subscription's renewal state, as its own signed JWS."),
      })
      .loose()
      .optional()
      .describe("The event's data. Absent on the notification types that carry a summary instead."),
  })
  .loose()
  .describe("Apple's responseBodyV2DecodedPayload — one App Store Server Notification V2.");

/** What parsing a notification needs: our bundle id, the roots to trust, and the clock. */
export interface ParseAppleNotificationOptions {
  /** Our own bundle id. A notification for any other app is refused. */
  bundleId: string;
  /** base64 DER of every acceptable root. Defaults to the pinned Apple roots. */
  roots?: readonly string[];
  /** The clock, for certificate validity. */
  now?: Date;
}

/**
 * Apple's store environment, normalized. Anything that is not literally `Production` is sandbox — including
 * Xcode's `LocalTesting`, and including a value Apple has not published yet. Defaulting the other way is the
 * most common in-app-purchase security defect there is, so the safe side is the default side.
 */
export function appleEnvironment(environment: string): PurchaseEnvironment {
  return environment === "Production" ? "production" : "sandbox";
}

/**
 * Apple's notificationType/subtype pair → the normalized status, or null when the notification reports no
 * transaction state.
 *
 * Every branch carries its reason. The two worth reading twice: `AUTO_RENEW_DISABLED` is `canceled` and
 * `canceled` still grants — a user who declines the *next* period keeps the one they paid for, and
 * `expiresAt` is what ends it. And `DID_FAIL_TO_RENEW` means two different things depending on its subtype:
 * with `GRACE_PERIOD` the retry window is running and access continues; bare, it is not, and it does not.
 */
export function appleStatus(notificationType: string, subtype: string | undefined): PurchaseStatus | null {
  switch (notificationType) {
    // A new subscription, a resubscription, a renewal, a redeemed offer, an extended expiry, and a one-time
    // charge are all the same statement: this transaction is paid and current.
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "OFFER_REDEEMED":
    case "RENEWAL_EXTENDED":
    case "ONE_TIME_CHARGE":
      return "active";
    // Apple reverses a refund it granted in error. Leaving the row refunded would strip a paying user.
    case "REFUND_REVERSED":
      return "active";
    // A plan change takes effect at the next renewal, so the current transaction is untouched.
    case "DID_CHANGE_RENEWAL_PREF":
      return "active";
    case "DID_CHANGE_RENEWAL_STATUS":
      return subtype === "AUTO_RENEW_DISABLED" ? "canceled" : "active";
    // Billing failed. `GRACE_PERIOD` says the retry window is open, which is the whole point of grace: a
    // failed card should not lock a subscriber out mid-period. Bare means there is no grace to run. How long
    // the window runs is on the renewal info rather than the transaction — see {@link appleExpiresAt}.
    case "DID_FAIL_TO_RENEW":
      return subtype === "GRACE_PERIOD" ? "in_grace" : "on_hold";
    // Grace is over and the renewal genuinely failed. `on_hold` never grants.
    case "GRACE_PERIOD_EXPIRED":
      return "on_hold";
    case "EXPIRED":
      return "expired";
    case "REFUND":
      return "refunded";
    // Family Sharing access withdrawn, or a purchase revoked.
    case "REVOKE":
      return "revoked";
    default:
      // TEST, CONSUMPTION_REQUEST, REFUND_DECLINED, PRICE_INCREASE, RENEWAL_EXTENSION,
      // EXTERNAL_PURCHASE_TOKEN, METADATA_UPDATE — and every type Apple ships after this package did. All
      // authentic, none a transaction state. Recorded and passed over, never an error.
      return null;
  }
}

/**
 * When access ends: the paid period, extended to the grace window while a card is being retried.
 *
 * Grace exists so a failed renewal does not lock a paying subscriber out, and that only works if the row says
 * so — `in_grace` with the expiry that just passed is read as lapsed by every access check, which revokes the
 * subscriber in the same commit that recorded the grace period.
 *
 * Three rules, each holding a real payload up: the window is read **only** for `in_grace`, because Apple
 * leaves `gracePeriodExpiresDate` on the renewal info after the retry is over and reading it on an `EXPIRED`
 * would extend a subscription that has ended. It is the **later** of the two dates, so a grace date behind the
 * expiry cannot shorten a period already paid for. And **no expiry stays no expiry** — a purchase that does not
 * end is not narrowed by a window.
 */
export function appleExpiresAt(
  status: PurchaseStatus,
  expiresDate: number | undefined,
  gracePeriodExpiresDate: number | undefined,
): Date | null {
  if (expiresDate === undefined) return null;
  const grace = status === "in_grace" ? gracePeriodExpiresDate : undefined;
  return new Date(grace === undefined ? expiresDate : Math.max(expiresDate, grace));
}

/** Verify a nested JWS and parse it against `schema`, naming the field in any refusal. */
async function verifyNested<T extends z.ZodType>(
  jws: string,
  schema: T,
  field: string,
  options: ParseAppleNotificationOptions,
): Promise<z.output<T>> {
  const payload = await verifyAppleJws(jws, { roots: options.roots, now: options.now });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PaymentsInvalidReceiptError({
      detail: `Apple: ${field} rejected — ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ")}.`,
    });
  }
  return parsed.data as z.output<T>;
}

/**
 * Refuse a payload that belongs to another app. `detail` names both ids; the client is told neither.
 *
 * Exported because the client-submission path needs the identical check: a signature proves Apple signed the
 * transaction, never that the transaction is about our app, and one copy of that rule is the only way the two
 * paths cannot diverge.
 */
export function requireAppleBundle(found: string, expected: string, where: string): void {
  if (found === expected) return;
  throw new PaymentsVerificationFailedError({
    message: "That notification is not for this app.",
    action: "Check that the App Store Connect app and this deployment's bundle id are the same.",
    detail: `Apple: ${where} bundle id is "${found}", this app is "${expected}".`,
  });
}

/**
 * Verify and parse one App Store Server Notification V2.
 *
 * Both the outer notification and the nested transaction are verified independently. The outer signature
 * already covers the inner JWS bytes, so verifying the inner one is belt as well as braces — but it costs
 * one more chain check and removes a whole class of assumption about what the outer signature implies.
 */
export async function parseAppleNotification(
  signedPayload: string,
  options: ParseAppleNotificationOptions,
): Promise<VerifiedNotification> {
  const notification = await verifyNested(signedPayload, AppleNotificationPayload, "notification", options);
  if (notification.data) requireAppleBundle(notification.data.bundleId, options.bundleId, "notification");

  const status = appleStatus(notification.notificationType, notification.subtype);
  // The payload is stored whole, nested JWS included, which is what makes the row genuinely replayable.
  const payload = notification as Record<string, unknown>;

  if (status === null)
    return { providerEventId: notification.notificationUUID, payload, event: null, providerAccountId: null };

  const signedTransaction = notification.data?.signedTransactionInfo;
  if (!signedTransaction) {
    // A state-changing type with no transaction is not something Apple sends. Deriving a transaction id from
    // the envelope instead would key the purchase row on the notification, so a redelivery under a new UUID
    // would become a second purchase.
    throw new PaymentsInvalidReceiptError({
      detail: `Apple: ${notification.notificationType} carries no signedTransactionInfo, so there is no transaction to project.`,
    });
  }

  const transaction = await verifyNested(signedTransaction, AppleTransactionInfo, "transaction", options);
  requireAppleBundle(transaction.bundleId, options.bundleId, "transaction");

  // The renewal info is read for one status and one field: `in_grace` runs to the end of the retry window, and
  // that date is beside the transaction rather than on it. Every other status is decided by the transaction
  // alone, and this costs a third chain verification — so it is paid where it changes an answer and nowhere
  // else. A grace notification arriving without it is not something Apple sends; if one ever does, the paid
  // period stands and the reconciliation pass re-asks Apple, which is milder than refusing a notification
  // Apple would then retry forever.
  const renewal =
    status === "in_grace" && notification.data?.signedRenewalInfo !== undefined
      ? await verifyNested(notification.data.signedRenewalInfo, AppleRenewalInfo, "renewal info", options)
      : undefined;

  const event: UnboundProviderEvent = {
    rail: "apple",
    providerTransactionId: transaction.transactionId,
    providerProductId: transaction.productId,
    status,
    environment: appleEnvironment(transaction.environment),
    purchasedAt: new Date(transaction.purchaseDate),
    expiresAt: appleExpiresAt(status, transaction.expiresDate, renewal?.gracePeriodExpiresDate),
    revokedAt: transaction.revocationDate === undefined ? null : new Date(transaction.revocationDate),
    originalTransactionId: transaction.originalTransactionId ?? null,
    amountMinor: minorUnitsFromScaled(transaction.price ?? null, APPLE_PRICE_SCALE, transaction.currency ?? null),
    currency: transaction.currency ?? null,
    // Apple's own clock on the notification, not the transaction's and certainly not ours. The monotonic
    // write rule compares against it, and a receipt time would only record delivery order.
    providerEventAt: new Date(notification.signedDate),
    payload,
  };

  return {
    providerEventId: notification.notificationUUID,
    payload,
    event,
    providerAccountId: transaction.appAccountToken ?? null,
  };
}
