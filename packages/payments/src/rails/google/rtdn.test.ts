import { describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { pushBody } from "./fixtures/push";
import oneTimePurchased from "./fixtures/rtdn-one-time-purchased.json" with { type: "json" };
import subscriptionRenewed from "./fixtures/rtdn-subscription-renewed.json" with { type: "json" };
import subscriptionRevoked from "./fixtures/rtdn-subscription-revoked.json" with { type: "json" };
import testNotification from "./fixtures/rtdn-test.json" with { type: "json" };
import voidedPurchase from "./fixtures/rtdn-voided-purchase.json" with { type: "json" };
import { parseGoogleNotification } from "./rtdn";

/**
 * The envelope, and the thing the design insists on: what arrives is a **pointer**, not a state. Every
 * assertion below is about which purchase changed, never about what it became — that answer needs the Play
 * Developer API, and the type here has no field that could hold it.
 */

const PACKAGE = "com.acme.app";
const parse = (body: string, packageName = PACKAGE) => parseGoogleNotification(body, { packageName });

describe("parseGoogleNotification", () => {
  test("reads a subscription notification as a pointer at one purchase token", () => {
    const parsed = parse(pushBody(subscriptionRenewed));
    expect(parsed.pointer).toEqual({
      kind: "subscription",
      purchaseToken: subscriptionRenewed.subscriptionNotification.purchaseToken,
      productId: "pro_monthly",
      notificationType: 2,
      statusOverride: null,
      eventAt: new Date(1768435200000),
    });
  });

  test("the pointer carries no status, because the notification does not report one", () => {
    // The design claim, asserted structurally: a renewal and an expiry are the same shape here, and the only
    // thing that tells them apart is what the Play API says about the token.
    const renewed = parse(pushBody(subscriptionRenewed)).pointer;
    expect(Object.keys(renewed ?? {}).sort()).toEqual([
      "eventAt",
      "kind",
      "notificationType",
      "productId",
      "purchaseToken",
      "statusOverride",
    ]);
  });

  test("a revoked subscription carries the one fact the Play API cannot report", () => {
    // Play reports a revoked subscription as EXPIRED, which loses the fact that money went back. The
    // notification type is the only place that survives, so it is the one override the pointer carries.
    expect(parse(pushBody(subscriptionRevoked)).pointer).toMatchObject({
      kind: "subscription",
      notificationType: 12,
      statusOverride: "revoked",
    });
  });

  test("reads a one-time product notification, sku included", () => {
    // The sku is load-bearing here and nowhere else: Play's one-time lookup takes the product id as a path
    // segment, so a pointer without it could not be resolved at all.
    expect(parse(pushBody(oneTimePurchased)).pointer).toEqual({
      kind: "one_time",
      purchaseToken: oneTimePurchased.oneTimeProductNotification.purchaseToken,
      productId: "coins_100",
      notificationType: 1,
      statusOverride: null,
      eventAt: new Date(1768435200000),
    });
  });

  test("a test notification is authentic and points at nothing", () => {
    const parsed = parse(pushBody(testNotification));
    expect(parsed.pointer).toBeNull();
    // Nothing to explain: a test notification is exactly what it looks like.
    expect(parsed.note).toBeNull();
  });

  test("a voided purchase points at nothing and says why, with the order id to repair it by", () => {
    // Play's voided-purchase notification names no product, and Play has no lookup that takes a token alone
    // for a one-time purchase. So this build records it and the reconciliation pass resolves it by order id.
    const parsed = parse(pushBody(voidedPurchase));
    expect(parsed.pointer).toBeNull();
    expect(parsed.note).toContain("GPA.3311-8452-9910-77304");
    expect(parsed.note).toContain("voided");
  });

  test("a notification shape this build does not know points at nothing rather than failing", () => {
    // Google adds notification kinds. Answering non-2xx to one would make Pub/Sub redeliver it forever and read
    // as a broken endpoint, so an unknown kind is recorded and passed over.
    const parsed = parse(
      pushBody({ version: "1.0", packageName: PACKAGE, eventTimeMillis: "1768435200000", futureNotification: {} }),
    );
    expect(parsed.pointer).toBeNull();
    expect(parsed.note).toContain("no notification this build recognizes");
  });

  test("the dedupe key is Pub/Sub's message id, which survives a redelivery", () => {
    const parsed = parse(pushBody(subscriptionRenewed, { messageId: "6714080000000042" }));
    expect(parsed.providerEventId).toBe("6714080000000042");
  });

  test("the stored payload is the decoded notification plus the envelope's own metadata", () => {
    // What makes "why didn't this renew" answerable. The base64 `data` is not kept: it is the same bytes twice.
    const parsed = parse(pushBody(subscriptionRenewed, { messageId: "m1", publishTime: "2026-01-15T00:00:01.000Z" }));
    expect(parsed.payload).toEqual({
      subscription: "projects/acme-42/subscriptions/pithy-payments-rtdn",
      message: { messageId: "m1", publishTime: "2026-01-15T00:00:01.000Z" },
      notification: subscriptionRenewed,
    });
    expect(JSON.stringify(parsed.payload)).not.toContain("data");
  });

  test("refuses a notification for another app", () => {
    // A push token proves Google sent the delivery and says nothing about which app it concerns. Without this,
    // any Play developer who can reach our endpoint can name a SKU that happens to match our catalog.
    const thrown = catchError(() => parse(pushBody(subscriptionRenewed), "com.someone.else"));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("com.someone.else");
    expect(thrown?.payload.message).not.toContain("com.someone.else");
  });

  test("refuses a body that is not JSON", () => {
    expect(() => parse("{not json")).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a body that is not a Pub/Sub push", () => {
    expect(() => parse(JSON.stringify({ hello: "world" }))).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a message whose data is not base64", () => {
    expect(() => parse(JSON.stringify({ message: { data: "not base64!!", messageId: "m1" } }))).toThrow(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses a message whose data is not a developer notification", () => {
    expect(() => parse(pushBody({ hello: "world" }))).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses an event time that is not a number of milliseconds", () => {
    // `eventTimeMillis` is a *string* of millis in Google's schema, and a bad one would silently become an
    // Invalid Date — which the monotonic write rule would then compare against and always lose.
    expect(() => parse(pushBody({ ...subscriptionRenewed, eventTimeMillis: "not-a-time" }))).toThrow(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses a subscription notification with no purchase token", () => {
    expect(() =>
      parse(
        pushBody({
          ...subscriptionRenewed,
          subscriptionNotification: { version: "1.0", notificationType: 2, subscriptionId: "pro_monthly" },
        }),
      ),
    ).toThrow(PaymentsInvalidReceiptError);
  });

  test("no refusal echoes the purchase token", () => {
    // A purchase token is a bearer artifact: it is the whole credential for reading a purchase from Play.
    const thrown = catchError(() => parse(pushBody(subscriptionRenewed), "com.someone.else"));
    expect(JSON.stringify(thrown?.payload)).not.toContain(subscriptionRenewed.subscriptionNotification.purchaseToken);
  });
});

/** The thrown `PithyError`, or undefined. */
function catchError(run: () => unknown): PaymentsVerificationFailedError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as PaymentsVerificationFailedError;
  }
}
