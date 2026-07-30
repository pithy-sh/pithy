import { z } from "zod";
import type { PurchaseStatus } from "../../data/status";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { base64UrlDecode } from "./jwt";

/**
 * Play's Real-time Developer Notification, and the honest shape of what it tells us.
 *
 * **The payload is a pointer, not a state.** Apple and Stripe deliver the transaction inline; Play delivers a
 * purchase token and a notification type, and nothing about the purchase's current condition. So this module
 * produces a {@link GoogleNotificationPointer} — which purchase changed, and nothing more — and resolving it to
 * a state is the *next* call, into the Play Developer API. That is modelled in the type rather than papered
 * over: the pointer has no status field, so there is no place for a guess to hide.
 *
 * Guessing would be the alternative, and it fails in both directions. `SUBSCRIPTION_RENEWED` looks like
 * "active", but the renewal it announces may already have been refunded by the time we read it; `EXPIRED` looks
 * terminal, but Play sends it for a subscription the user has since restarted. Only the API knows, and it is
 * the same API the reconciliation Workflow reads, so both paths converge on one answer.
 *
 * **One exception, and it is not a guess.** A revoked subscription reads as `EXPIRED` in the API once it is
 * revoked, which loses the fact that money went back. The notification type is the only surviving record of
 * that, so `SUBSCRIPTION_REVOKED` travels as an explicit `statusOverride` — a fact the API cannot report,
 * carried in a field named for what it is.
 *
 * ## The envelope
 *
 * A notification does not arrive from Google Play. It arrives from **Pub/Sub**, as a push whose body wraps a
 * base64 Developer Notification and whose `Authorization` header carries the OIDC token that proves it is
 * Google's (see `oidc.ts`). Pub/Sub's `messageId` is stable across redeliveries of one message, which is what
 * makes it the dedupe key `UNIQUE (rail, providerEventId)` needs.
 */

/** Play's `SUBSCRIPTION_REVOKED`. The one notification type whose meaning the API does not preserve. */
const SUBSCRIPTION_REVOKED = 12;

/** A string of milliseconds since the epoch — how Google writes a timestamp in an RTDN. */
const GoogleEventMillis = z
  .string()
  .regex(/^\d+$/, "A Play event time is a string of milliseconds since the epoch.")
  .describe(
    "When Google recorded the event, as a decimal string of milliseconds. A string, not a number — Play's JSON encodes 64-bit integers that way, and parsing it loosely would yield an Invalid Date the monotonic write rule would silently lose to.",
  );

/** The Pub/Sub push envelope. `.loose()` so a new envelope field never refuses a real notification. */
export const GooglePubSubPush = z
  .object({
    message: z
      .object({
        data: z
          .string()
          .min(1)
          .describe("The Developer Notification, base64-encoded. Standard base64 with padding, as Pub/Sub emits."),
        messageId: z
          .string()
          .min(1)
          .describe(
            "Pub/Sub's own id for this message. Stable across redeliveries, which is what makes it the dedupe key.",
          ),
        publishTime: z.string().min(1).optional().describe("When Pub/Sub published the message, RFC 3339."),
      })
      .loose()
      .describe("The Pub/Sub message carrying one Developer Notification."),
    subscription: z
      .string()
      .min(1)
      .optional()
      .describe("The push subscription's resource name. Recorded for diagnosis; nothing is decided from it."),
  })
  .loose()
  .describe("The body Pub/Sub POSTs to a push endpoint.");
export type GooglePubSubPush = z.infer<typeof GooglePubSubPush>;

/** One Play Developer Notification. Exactly one of the four notification blocks is present. */
export const GoogleDeveloperNotification = z
  .object({
    version: z.string().min(1).describe("The notification schema version Google sent — `1.0` throughout v1."),
    packageName: z
      .string()
      .min(1)
      .describe(
        "The Android application id the event concerns. Checked against our own: a push token proves Google sent the delivery and says nothing about which app it is about.",
      ),
    eventTimeMillis: GoogleEventMillis.describe(
      "When Google recorded the event. This is the provider event time the monotonic write rule compares against.",
    ),
    subscriptionNotification: z
      .object({
        version: z.string().min(1).describe("The block's schema version."),
        notificationType: z
          .number()
          .int()
          .describe(
            "What happened, as Play's own integer. Recorded and reported, but not mapped to a status — the API is what says what the subscription is now.",
          ),
        purchaseToken: z
          .string()
          .min(1)
          .describe("The subscription's purchase token. Stable across renewals, so it is the family's identity."),
        subscriptionId: z.string().min(1).describe("The base subscription product id, as listed in the Play Console."),
      })
      .loose()
      .optional()
      .describe("Present when the event concerns a subscription."),
    oneTimeProductNotification: z
      .object({
        version: z.string().min(1).describe("The block's schema version."),
        notificationType: z.number().int().describe("1 for purchased, 2 for canceled."),
        purchaseToken: z.string().min(1).describe("The purchase token for the one-time order."),
        sku: z
          .string()
          .min(1)
          .describe(
            "The product id. Load-bearing here and nowhere else: Play's one-time lookup takes it as a path segment, so a pointer without it could not be resolved.",
          ),
      })
      .loose()
      .optional()
      .describe("Present when the event concerns a one-time product."),
    voidedPurchaseNotification: z
      .object({
        purchaseToken: z.string().min(1).describe("The voided purchase's token."),
        orderId: z
          .string()
          .min(1)
          .describe("The voided order — which, for a one-time purchase, is the id its purchase row is keyed by."),
        productType: z.number().int().describe("1 for a subscription, 2 for a one-time product."),
        refundType: z.number().int().optional().describe("1 for a full refund, 2 for a partial one."),
      })
      .loose()
      .optional()
      .describe("Present when a purchase was refunded or charged back."),
    testNotification: z
      .object({ version: z.string().min(1).describe("The block's schema version.") })
      .loose()
      .optional()
      .describe("Present for the notification the Play Console's test button sends. Concerns no purchase."),
  })
  .loose()
  .describe("One Play Real-time Developer Notification, decoded out of its Pub/Sub envelope.");
export type GoogleDeveloperNotification = z.infer<typeof GoogleDeveloperNotification>;

/** Which Play lookup resolves a pointer. The two take different endpoints and different path parameters. */
export type GoogleNotificationKind = "subscription" | "one_time";

/**
 * Which purchase a notification is about. Deliberately carries no state — see the module doc.
 */
export interface GoogleNotificationPointer {
  /** Which Play lookup resolves it. */
  kind: GoogleNotificationKind;
  /** The purchase token the lookup is keyed by. */
  purchaseToken: string;
  /** The product id, when the notification names one. Required for a one-time lookup, informational otherwise. */
  productId: string | null;
  /** Play's own notification type. Reported and audited; never mapped to a status. */
  notificationType: number;
  /**
   * The one status the Play API cannot report and the notification can. `revoked` for a revoked subscription,
   * which the API reports as merely expired, and null for everything else.
   */
  statusOverride: PurchaseStatus | null;
  /** Google's own event time. What the monotonic write rule compares against. */
  eventAt: Date;
}

/** A verified, decoded notification: what to record, and what to resolve. */
export interface ParsedGoogleNotification {
  /** Pub/Sub's message id — the dedupe key. */
  providerEventId: string;
  /** What to store on the webhook row: the decoded notification plus the envelope's own metadata. */
  payload: Record<string, unknown>;
  /** The app the notification concerns, already checked against ours. */
  packageName: string;
  /** Google's own event time. */
  eventAt: Date;
  /** Which purchase changed, or null when the notification concerns none. */
  pointer: GoogleNotificationPointer | null;
  /**
   * Why a notification with no pointer had none, when that is worth recording. Null when there is nothing to
   * say — a test notification needs no explanation.
   */
  note: string | null;
  /**
   * The order a voided-purchase notification refunded, or null. Reported rather than only described, because
   * an order id is exactly what a Google purchase's `providerTransactionId` is — so the route can find the
   * row this refund is about even though Play offers no lookup that would.
   */
  voidedOrderId: string | null;
}

/** What parsing needs: our own application id, and nothing else. */
export interface ParseGoogleNotificationOptions {
  /** Our Android application id. A notification for any other app is refused. */
  packageName: string;
}

/**
 * Decode one Pub/Sub push into a pointer.
 *
 * Authenticity is not established here — that is `verifyGoogleOidcToken`, and it runs first. What this adds is
 * the check a token cannot make: Google signs a push token for every Pub/Sub subscription there is, so a valid
 * token says nothing about which app a notification concerns. Without the package check, any Play developer who
 * can reach our endpoint can send us a SKU that happens to match our catalog.
 *
 * @throws {@link PaymentsInvalidReceiptError} when the body cannot be read as a Pub/Sub push carrying a
 *   Developer Notification.
 * @throws {@link PaymentsVerificationFailedError} when it is readable and concerns another app.
 */
export function parseGoogleNotification(
  body: string,
  options: ParseGoogleNotificationOptions,
): ParsedGoogleNotification {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body) as unknown;
  } catch (cause) {
    throw malformed("the push body is not JSON.", cause);
  }

  const push = GooglePubSubPush.safeParse(envelope);
  if (!push.success) throw malformed(`the push body is not a Pub/Sub push — ${issues(push.error)}.`);

  const decoded = new TextDecoder().decode(base64UrlDecode(push.data.message.data, "the push message data"));
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch (cause) {
    throw malformed("the push message data is not JSON.", cause);
  }

  const parsed = GoogleDeveloperNotification.safeParse(raw);
  if (!parsed.success) {
    throw malformed(`the push carries no Play developer notification — ${issues(parsed.error)}.`);
  }
  const notification = parsed.data;

  if (notification.packageName !== options.packageName) {
    throw new PaymentsVerificationFailedError({
      message: "That notification is not for this app.",
      action: "Check that the Play Console app and this deployment's package name are the same.",
      detail: `Google: the notification is for "${notification.packageName}", this app is "${options.packageName}".`,
    });
  }

  const eventAt = new Date(Number(notification.eventTimeMillis));
  const common = {
    providerEventId: push.data.message.messageId,
    // The base64 `data` is deliberately dropped: keeping it would store the same bytes twice, and the decoded
    // form is what a human reads and what a replay needs.
    payload: {
      subscription: push.data.subscription,
      message: { messageId: push.data.message.messageId, publishTime: push.data.message.publishTime },
      notification,
    } as Record<string, unknown>,
    packageName: notification.packageName,
    eventAt,
    // Only the voided branch overrides this; every other notification refunds nothing.
    voidedOrderId: null as string | null,
  };

  if (notification.subscriptionNotification) {
    const block = notification.subscriptionNotification;
    return {
      ...common,
      pointer: {
        kind: "subscription",
        purchaseToken: block.purchaseToken,
        productId: block.subscriptionId,
        notificationType: block.notificationType,
        statusOverride: block.notificationType === SUBSCRIPTION_REVOKED ? "revoked" : null,
        eventAt,
      },
      note: null,
    };
  }

  if (notification.oneTimeProductNotification) {
    const block = notification.oneTimeProductNotification;
    return {
      ...common,
      pointer: {
        kind: "one_time",
        purchaseToken: block.purchaseToken,
        productId: block.sku,
        notificationType: block.notificationType,
        statusOverride: null,
        eventAt,
      },
      note: null,
    };
  }

  if (notification.voidedPurchaseNotification) {
    // No pointer, and there cannot be one: a voided notification names no product, and Play's one-time lookup
    // takes the product id as a path segment, so no call this module can make turns the token back into a
    // state. But it does not need to. The notification is authentic and it says the order was refunded — the
    // same statement Apple's `REFUND` makes — and the product it concerns is in our own row, which is keyed by
    // this very order id. So the order travels out as `voidedOrderId` and the route resolves it.
    const block = notification.voidedPurchaseNotification;
    return {
      ...common,
      pointer: null,
      voidedOrderId: block.orderId,
      note: `google: purchase voided (order ${block.orderId}, productType ${block.productType}, refundType ${block.refundType ?? "unspecified"}).`,
    };
  }

  if (notification.testNotification) return { ...common, pointer: null, note: null };

  // Google adds notification kinds, and a type this build has never heard of must not be an error: answering
  // non-2xx would make Pub/Sub redeliver it forever and read as a broken endpoint. Recorded, and the note is
  // what makes it visible rather than silently dropped.
  return {
    ...common,
    pointer: null,
    note: "google: the notification carries no notification this build recognizes, so there is nothing to resolve.",
  };
}

/** A structural refusal. The body is never echoed: a purchase token is a bearer artifact. */
function malformed(detail: string, cause?: unknown): PaymentsInvalidReceiptError {
  return new PaymentsInvalidReceiptError({ detail: `Google: ${detail}` }, cause === undefined ? undefined : { cause });
}

/** Zod issues as `path:code` pairs — never `message` or `received`, which would echo the payload. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ");
}
