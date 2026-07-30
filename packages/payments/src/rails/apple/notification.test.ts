import { beforeAll, describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { type MintedChain, mintChain, type NotificationFixture, signJws, signNotification } from "./fixtures/chain";
import didFailToRenewGrace from "./fixtures/did-fail-to-renew-grace.json" with { type: "json" };
import didRenew from "./fixtures/did-renew.json" with { type: "json" };
import oneTimeCharge from "./fixtures/one-time-charge.json" with { type: "json" };
import refund from "./fixtures/refund.json" with { type: "json" };
import subscribedSandbox from "./fixtures/subscribed-initial-buy-sandbox.json" with { type: "json" };
import testNotification from "./fixtures/test.json" with { type: "json" };
import { appleEnvironment, appleStatus, parseAppleNotification } from "./notification";

const BUNDLE_ID = "com.acme.app";

let chain: MintedChain;
let roots: string[];

beforeAll(async () => {
  chain = await mintChain();
  roots = [chain.root];
});

/** Parse a recorded fixture, re-signed with the minted chain. */
async function parse(fixture: NotificationFixture, bundleId = BUNDLE_ID) {
  return parseAppleNotification(await signNotification(fixture, chain), {
    bundleId,
    roots,
    now: new Date("2026-02-01T00:00:00.000Z"),
  });
}

/**
 * The mapping is where a rail's vocabulary stops. Apple has twenty-odd notification types and a dozen
 * subtypes; the projection has eight statuses. Every branch below is a lifecycle event a paying subscriber
 * will hit, and getting one wrong revokes or grants access to somebody real.
 */
describe("appleStatus", () => {
  test("a purchase and a renewal are both simply active", () => {
    expect(appleStatus("SUBSCRIBED", "INITIAL_BUY")).toBe("active");
    expect(appleStatus("SUBSCRIBED", "RESUBSCRIBE")).toBe("active");
    expect(appleStatus("DID_RENEW", undefined)).toBe("active");
    expect(appleStatus("DID_RENEW", "BILLING_RECOVERY")).toBe("active");
    expect(appleStatus("ONE_TIME_CHARGE", undefined)).toBe("active");
    expect(appleStatus("OFFER_REDEEMED", undefined)).toBe("active");
    expect(appleStatus("RENEWAL_EXTENDED", undefined)).toBe("active");
  });

  test("turning auto-renew off is `canceled`, which still grants until the period ends", () => {
    // The member most often got wrong. A user who declines the *next* period keeps the one they paid for.
    expect(appleStatus("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED")).toBe("canceled");
  });

  test("turning auto-renew back on is active again", () => {
    expect(appleStatus("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED")).toBe("active");
  });

  test("a plan change leaves the transaction active — the switch happens at renewal", () => {
    expect(appleStatus("DID_CHANGE_RENEWAL_PREF", "UPGRADE")).toBe("active");
    expect(appleStatus("DID_CHANGE_RENEWAL_PREF", "DOWNGRADE")).toBe("active");
  });

  test("a failed renewal inside the grace window is `in_grace`, and past it is `on_hold`", () => {
    // Apple sends DID_FAIL_TO_RENEW with GRACE_PERIOD while grace is running and bare while it is not.
    expect(appleStatus("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toBe("in_grace");
    expect(appleStatus("DID_FAIL_TO_RENEW", undefined)).toBe("on_hold");
    expect(appleStatus("GRACE_PERIOD_EXPIRED", undefined)).toBe("on_hold");
  });

  test("every expiry subtype is `expired`", () => {
    for (const subtype of [undefined, "VOLUNTARY", "BILLING_RETRY", "PRICE_INCREASE", "PRODUCT_NOT_FOR_SALE"]) {
      expect(appleStatus("EXPIRED", subtype)).toBe("expired");
    }
  });

  test("a refund is `refunded` and a Family Sharing revocation is `revoked`", () => {
    expect(appleStatus("REFUND", undefined)).toBe("refunded");
    expect(appleStatus("REVOKE", undefined)).toBe("revoked");
  });

  test("a reversed refund puts the transaction back to active", () => {
    // Apple reverses a refund when it was granted in error. Leaving it refunded would strip a paying user.
    expect(appleStatus("REFUND_REVERSED", undefined)).toBe("active");
  });

  test("notifications that report no transaction state map to null", () => {
    // Null is a first-class outcome, not a failure: the notification is authentic and recorded, and there
    // is simply nothing about a purchase to project.
    for (const type of [
      "TEST",
      "CONSUMPTION_REQUEST",
      "REFUND_DECLINED",
      "PRICE_INCREASE",
      "RENEWAL_EXTENSION",
      "EXTERNAL_PURCHASE_TOKEN",
      "METADATA_UPDATE",
    ]) {
      expect(appleStatus(type, undefined)).toBeNull();
    }
  });

  test("a type Apple has not shipped yet maps to null rather than throwing", () => {
    // Apple adds types. Throwing would make Apple retry a notification forever and read as a broken
    // endpoint; recording it and moving on leaves the row for the reconciliation pass.
    expect(appleStatus("SOMETHING_NEW", "AND_A_SUBTYPE")).toBeNull();
  });
});

describe("appleEnvironment", () => {
  test("maps Apple's two names onto ours", () => {
    expect(appleEnvironment("Production")).toBe("production");
    expect(appleEnvironment("Sandbox")).toBe("sandbox");
  });

  test("Xcode's local testing environment is sandbox, never production", () => {
    // StoreKit's local testing signs with a local certificate and reports LocalTesting. Anything that is
    // not literally Production must land on the side that cannot grant a real entitlement.
    expect(appleEnvironment("LocalTesting")).toBe("sandbox");
    expect(appleEnvironment("Xcode")).toBe("sandbox");
    expect(appleEnvironment("")).toBe("sandbox");
  });
});

describe("parseAppleNotification", () => {
  test("a renewal becomes an active subscription event, carrying Apple's own event time", async () => {
    const parsed = await parse(didRenew);
    expect(parsed.providerEventId).toBe("b8f1a7d6-3c92-4d51-9e0b-7a2f5c1d4e33");
    expect(parsed.providerAccountId).toBe("3f6c1d20-8a4b-4f77-9c31-b0e5d2a91746");
    expect(parsed.event).toMatchObject({
      rail: "apple",
      providerTransactionId: "2000000731004811",
      providerProductId: "com.acme.pro.monthly",
      originalTransactionId: "2000000617339002",
      status: "active",
      environment: "production",
    });
    // Apple's `signedDate` on the notification, not our receipt time. The monotonic rule compares against
    // it, so it has to be the provider's clock or ordering means nothing.
    expect(parsed.event?.providerEventAt).toEqual(new Date(1767225600000));
    expect(parsed.event?.purchasedAt).toEqual(new Date(1767225600000));
    expect(parsed.event?.expiresAt).toEqual(new Date(1769904000000));
    expect(parsed.event?.revokedAt).toBeNull();
  });

  test("$4.99 arrives as 4990 milliunits and is stored as 499 cents", async () => {
    const parsed = await parse(didRenew);
    expect(parsed.event?.amountMinor).toBe(499);
    expect(parsed.event?.currency).toBe("USD");
  });

  test("a yen price keeps its whole units — 500000 milliunits is ¥500, not 50000", async () => {
    const parsed = await parse(oneTimeCharge);
    expect(parsed.event?.amountMinor).toBe(500);
    expect(parsed.event?.currency).toBe("JPY");
  });

  test("the raw payload is kept whole, so a notification is answerable later", async () => {
    const parsed = await parse(didRenew);
    expect(parsed.payload.notificationType).toBe("DID_RENEW");
    // The nested JWS survives, which is what makes the stored row genuinely replayable.
    expect(typeof (parsed.payload.data as { signedTransactionInfo?: unknown }).signedTransactionInfo).toBe("string");
  });

  test("a sandbox notification is marked sandbox — it can never grant in production", async () => {
    const parsed = await parse(subscribedSandbox);
    expect(parsed.event?.environment).toBe("sandbox");
    expect(parsed.event?.status).toBe("active");
  });

  test("a grace-period failure keeps the purchase in_grace, to the end of the grace window", async () => {
    // The whole point of grace, and the date it turns on. The paid period ended at `expiresDate`; Apple puts
    // the retry window's end on the renewal info beside the transaction. Carrying only `expiresDate` records a
    // grace period and clears the entitlement in the same commit, which locks out a subscriber who is paying.
    const parsed = await parse(didFailToRenewGrace);
    expect(parsed.event?.status).toBe("in_grace");
    expect(parsed.event?.expiresAt).toEqual(new Date(1770422400000));
  });

  test("the grace window only ever extends the paid period, never cuts it short", async () => {
    // Apple dates grace after the expiry. A payload claiming otherwise must not shorten access already paid for.
    const parsed = await parse({
      ...didFailToRenewGrace,
      renewalInfo: { ...didFailToRenewGrace.renewalInfo, gracePeriodExpiresDate: 1769000000000 },
    });
    expect(parsed.event?.expiresAt).toEqual(new Date(1769904000000));
  });

  test("a grace notification with no renewal info keeps the transaction's own expiry", async () => {
    // Apple always sends the renewal info with a subscription notification. If one ever arrives without it,
    // the transaction's expiry stands and the reconciliation pass re-asks Apple — refusing the notification
    // would make Apple retry it forever, and inventing a window would grant access nobody described.
    const { renewalInfo: _dropped, ...withoutRenewal } = didFailToRenewGrace;
    const parsed = await parse(withoutRenewal);
    expect(parsed.event?.status).toBe("in_grace");
    expect(parsed.event?.expiresAt).toEqual(new Date(1769904000000));
  });

  test("a status that is not in_grace ignores a grace window on the renewal info", async () => {
    // A stale `gracePeriodExpiresDate` rides along on the renewal info after the retry is over. Reading it on
    // an `EXPIRED` or a `REFUND` would extend a purchase that has ended.
    const parsed = await parse({
      ...didFailToRenewGrace,
      notification: { ...didFailToRenewGrace.notification, notificationType: "EXPIRED", subtype: undefined },
    });
    expect(parsed.event?.status).toBe("expired");
    expect(parsed.event?.expiresAt).toEqual(new Date(1769904000000));
  });

  test("refuses a grace notification whose renewal info is signed by another chain", async () => {
    // The renewal info decides how long access runs, so it is verified against the pinned chain like every
    // other Apple payload. An unverified one would be a date an attacker chooses.
    const rogue = await mintChain({ label: "rogue" });
    const notification = {
      ...didFailToRenewGrace.notification,
      data: {
        ...didFailToRenewGrace.notification.data,
        signedTransactionInfo: await signJws(didFailToRenewGrace.transaction, chain),
        signedRenewalInfo: await signJws(didFailToRenewGrace.renewalInfo, rogue),
      },
    };
    const jws = await signJws(notification, chain);
    await expect(
      parseAppleNotification(jws, { bundleId: BUNDLE_ID, roots, now: new Date("2026-02-01T00:00:00.000Z") }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("a refund carries its revocation date through", async () => {
    const parsed = await parse(refund);
    expect(parsed.event?.status).toBe("refunded");
    expect(parsed.event?.revokedAt).toEqual(new Date(1770076800000));
  });

  test("a one-time charge has no expiry and no original transaction", async () => {
    const parsed = await parse(oneTimeCharge);
    expect(parsed.event?.expiresAt).toBeNull();
    expect(parsed.event?.originalTransactionId).toBeNull();
  });

  test("a TEST notification is authentic, recorded, and changes nothing", async () => {
    const parsed = await parse(testNotification);
    expect(parsed.providerEventId).toBe("8e1d6b73-4f20-4c89-a05e-3b7c9d1f2a64");
    expect(parsed.event).toBeNull();
    expect(parsed.payload.notificationType).toBe("TEST");
  });

  test("refuses a notification for another app's bundle id", async () => {
    // A valid Apple signature only proves Apple signed it. Without this check, a transaction from any other
    // developer's app verifies here, and any SKU collision with our catalog becomes a free entitlement.
    await expect(parse(didRenew, "com.someone.else")).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a notification whose transaction is for another app, even when the envelope matches", async () => {
    // The nested transaction carries its own bundleId. Checking only the envelope's would miss a
    // notification assembled with somebody else's transaction inside it.
    const crossed: NotificationFixture = {
      ...didRenew,
      transaction: { ...didRenew.transaction, bundleId: "com.someone.else" },
    };
    await expect(parse(crossed)).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a notification signed by a chain that is not Apple's", async () => {
    const rogue = await mintChain({ label: "rogue" });
    const jws = await signNotification(didRenew, rogue);
    await expect(
      parseAppleNotification(jws, { bundleId: BUNDLE_ID, roots, now: new Date("2026-02-01T00:00:00.000Z") }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a notification whose nested transaction is signed by another chain", async () => {
    // The outer signature covers the inner JWS bytes, so this cannot happen without the outer key. The inner
    // JWS is verified anyway: two signatures cost two verifications and remove a class of assumption.
    const rogue = await mintChain({ label: "rogue" });
    const notification = {
      ...didRenew.notification,
      data: { ...didRenew.notification.data, signedTransactionInfo: await signJws(didRenew.transaction, rogue) },
    };
    const jws = await signJws(notification, chain);
    await expect(
      parseAppleNotification(jws, { bundleId: BUNDLE_ID, roots, now: new Date("2026-02-01T00:00:00.000Z") }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a notification with no notificationUUID — there would be nothing to dedupe on", async () => {
    const { notificationUUID: _dropped, ...rest } = didRenew.notification;
    await expect(parse({ ...didRenew, notification: rest })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a state-changing notification that carries no transaction", async () => {
    // DID_RENEW without signedTransactionInfo is not something Apple sends, and inventing a transaction id
    // from the envelope would key a purchase row on the notification instead of the transaction.
    await expect(parse({ notification: didRenew.notification })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a payload that is not an ASSN V2 notification at all", async () => {
    const jws = await signJws({ hello: "world" }, chain);
    await expect(
      parseAppleNotification(jws, { bundleId: BUNDLE_ID, roots, now: new Date("2026-02-01T00:00:00.000Z") }),
    ).rejects.toThrow(PaymentsInvalidReceiptError);
  });
});
