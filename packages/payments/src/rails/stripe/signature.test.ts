// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { STRIPE_TEST_WEBHOOK_SECRET, stripeSignatureHeader } from "./fixtures/events";
import {
  parseStripeSignatureHeader,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from "./signature";

const NOW = new Date("2026-01-15T00:00:00.000Z");
const BODY = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });

/** Verify with the suite's secret unless a case says otherwise. Resolves on success, throws on refusal. */
const verify = (body: string, header: string | null, secret = STRIPE_TEST_WEBHOOK_SECRET, now = NOW) =>
  verifyStripeSignature(body, header, secret, { now });

/** The `PithyError` code a refusal carries, or the string a non-PithyError throw was. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("parseStripeSignatureHeader", () => {
  test("reads the timestamp and every v1 signature", () => {
    expect(parseStripeSignatureHeader("t=1768435200,v1=aa,v1=bb")).toEqual({
      timestamp: 1768435200,
      signatures: ["aa", "bb"],
    });
  });

  test("ignores schemes it does not know, including v0", () => {
    // Stripe sends `v0` for thin Connect events, and may add a scheme after this package shipped. Neither is a
    // reason to refuse a delivery whose `v1` is good — but a header carrying only those has proved nothing.
    expect(parseStripeSignatureHeader("t=1,v0=cc,v1=aa,v2=dd")?.signatures).toEqual(["aa"]);
    expect(parseStripeSignatureHeader("t=1,v0=cc")).toBeUndefined();
  });

  test("tolerates whitespace around the separators", () => {
    expect(parseStripeSignatureHeader("t=1768435200, v1=aa")).toEqual({ timestamp: 1768435200, signatures: ["aa"] });
  });

  test("is undefined for anything that is not a signature header", () => {
    // Undefined rather than a throw: the caller turns every shape of unreadable header into one refusal, so the
    // parser has no reason to distinguish them and no reason to describe them to a sender.
    expect(parseStripeSignatureHeader("")).toBeUndefined();
    expect(parseStripeSignatureHeader("v1=aa")).toBeUndefined();
    expect(parseStripeSignatureHeader("t=notanumber,v1=aa")).toBeUndefined();
    expect(parseStripeSignatureHeader("t=,v1=aa")).toBeUndefined();
    expect(parseStripeSignatureHeader("t=1768435200")).toBeUndefined();
    expect(parseStripeSignatureHeader("garbage")).toBeUndefined();
  });

  test("refuses a negative or fractional timestamp", () => {
    expect(parseStripeSignatureHeader("t=-1,v1=aa")).toBeUndefined();
    expect(parseStripeSignatureHeader("t=1.5,v1=aa")).toBeUndefined();
  });
});

describe("verifyStripeSignature", () => {
  test("a signature Stripe would have produced passes", async () => {
    await expect(verify(BODY, await stripeSignatureHeader(BODY, NOW))).resolves.toBeUndefined();
  });

  test("a tampered body is refused", async () => {
    // The signature is genuine; the bytes are not the ones it covers. This is the case the whole mechanism is
    // for — an attacker who can reach the endpoint but cannot forge an HMAC.
    const header = await stripeSignatureHeader(BODY, NOW);
    const tampered = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted" });
    expect((await refusal(verify(tampered, header))).payload.code).toBe("payments/verification_failed");
  });

  test("a signature from another secret is refused", async () => {
    const header = await stripeSignatureHeader(BODY, NOW, { secret: "whsec_someoneElsesEndpointSecret" });
    expect((await refusal(verify(BODY, header))).payload.code).toBe("payments/verification_failed");
  });

  test("a delivery older than the tolerance is refused — the replay window is real", async () => {
    // A signed delivery stays valid forever without this check, so an attacker who captured one could replay it
    // indefinitely: the same renewal notification, re-delivered after the subscription lapsed.
    const stale = new Date(NOW.getTime() - (STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000);
    const header = await stripeSignatureHeader(BODY, NOW, { timestamp: stale });
    expect((await refusal(verify(BODY, header))).payload.detail).toContain("tolerance");
  });

  test("a delivery from the future is refused too", async () => {
    // Not symmetric with the stale case in what it means — a future timestamp is a clock, not a replay — but the
    // window is checked in both directions, because a signature is only good for the moment it claims.
    const ahead = new Date(NOW.getTime() + (STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000);
    const header = await stripeSignatureHeader(BODY, NOW, { timestamp: ahead });
    expect((await refusal(verify(BODY, header))).payload.detail).toContain("tolerance");
  });

  test("a delivery at the edge of the window passes, in both directions", async () => {
    for (const offset of [-STRIPE_SIGNATURE_TOLERANCE_SECONDS, STRIPE_SIGNATURE_TOLERANCE_SECONDS]) {
      const timestamp = new Date(NOW.getTime() + offset * 1000);
      await expect(verify(BODY, await stripeSignatureHeader(BODY, NOW, { timestamp }))).resolves.toBeUndefined();
    }
  });

  test("a valid signature re-dated to escape the window is refused", async () => {
    // The timestamp is inside the signed payload, so moving it invalidates the signature. That is what makes the
    // window unbypassable rather than advisory.
    const header = await stripeSignatureHeader(BODY, NOW);
    const redated = header.replace(/^t=\d+/, `t=${Math.floor(NOW.getTime() / 1000)}`.replace(/\d$/, "9"));
    expect((await refusal(verify(BODY, redated))).payload.code).toBe("payments/verification_failed");
  });

  test("a header with an unknown scheme only is refused", async () => {
    const header = await stripeSignatureHeader(BODY, NOW, { scheme: "v0" });
    expect((await refusal(verify(BODY, header))).payload.detail).toContain("Stripe-Signature");
  });

  test("an absent header is refused", async () => {
    expect((await refusal(verify(BODY, null))).payload.detail).toContain("Stripe-Signature");
  });

  test("a signature that is not hex, or is the wrong length, is refused", async () => {
    for (const value of ["zz".repeat(32), "aa", "ab".repeat(64)]) {
      const header = `t=${Math.floor(NOW.getTime() / 1000)},v1=${value}`;
      expect((await refusal(verify(BODY, header))).payload.code).toBe("payments/verification_failed");
    }
  });

  test("one good signature among several passes — that is what a secret rotation looks like", async () => {
    // Stripe lists a v1 per active secret while an endpoint's secret is being rolled. Refusing because the first
    // one does not match would drop every delivery for the length of the rotation.
    const header = await stripeSignatureHeader(BODY, NOW, { extra: ["ab".repeat(32)] });
    await expect(verify(BODY, header)).resolves.toBeUndefined();
  });

  test("no refusal carries the secret, the body, or the signature", async () => {
    // `detail` reaches an operator's log. A webhook secret in one is a credential in a log, and the body is a
    // customer's purchase.
    const header = await stripeSignatureHeader(BODY, NOW, { secret: "whsec_someoneElsesEndpointSecret" });
    const { payload } = await refusal(verify(BODY, header));
    const rendered = JSON.stringify(payload);
    expect(rendered).not.toContain(STRIPE_TEST_WEBHOOK_SECRET);
    expect(rendered).not.toContain(BODY);
    expect(rendered).not.toContain(header.split("v1=")[1]);
  });

  test("every refusal is payments/verification_failed, which the webhook guard turns into a 401", async () => {
    expect((await refusal(verify(BODY, "garbage"))).payload.status).toBe(400);
  });

  test("names the header it reads, so a route and a test cannot drift on the spelling", () => {
    expect(STRIPE_SIGNATURE_HEADER).toBe("stripe-signature");
    expect(STRIPE_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });
});
