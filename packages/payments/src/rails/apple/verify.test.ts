import { beforeAll, describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { type MintedChain, mintChain, signJws } from "./fixtures/chain";
import didRenew from "./fixtures/did-renew.json" with { type: "json" };
import { verifyAppleTransaction } from "./verify";

const BUNDLE_ID = "com.acme.app";
/** Mid-period for the recorded transaction, which runs 2026-01-01 to 2026-02-01. */
const NOW = new Date("2026-01-15T00:00:00.000Z");

let chain: MintedChain;
let roots: string[];

beforeAll(async () => {
  chain = await mintChain();
  roots = [chain.root];
});

/** A StoreKit 2 signed transaction, the artifact an app hands to `POST /payments/purchases`. */
async function receipt(overrides: Record<string, unknown> = {}): Promise<string> {
  return signJws({ ...didRenew.transaction, ...overrides }, chain);
}

const options = () => ({ bundleId: BUNDLE_ID, roots, now: NOW });

/**
 * The client-submission path. StoreKit 2 hands the app a signed transaction, so verification is a local
 * signature check against Apple's chain — Apple's own documented approach, and no store round-trip. That
 * matters for what the route can promise: the purchaser sees their entitlement immediately, and the webhook
 * that follows produces the identical row.
 *
 * Status has to be derived from the transaction alone here. A notification says what happened; a transaction
 * only says what it is, so the rules are the two facts it carries: a revocation date, and an expiry.
 */
describe("verifyAppleTransaction", () => {
  test("verifies a signed transaction and normalizes it", async () => {
    const verified = await verifyAppleTransaction(await receipt(), options());
    expect(verified.providerAccountId).toBe("3f6c1d20-8a4b-4f77-9c31-b0e5d2a91746");
    expect(verified.event).toMatchObject({
      rail: "apple",
      providerTransactionId: "2000000731004811",
      providerProductId: "com.acme.pro.monthly",
      originalTransactionId: "2000000617339002",
      environment: "production",
      status: "active",
      amountMinor: 499,
      currency: "USD",
    });
    // The transaction's own signed date is the provider event time — there is no notification to take one
    // from, and our receipt time would record delivery order rather than the store's.
    expect(verified.event.providerEventAt).toEqual(new Date(didRenew.transaction.signedDate));
  });

  test("a subscription whose period has ended reads as expired, without any notification arriving", async () => {
    // The case the whole read-time recheck exists for: Apple stops renewing and sends nothing. A client
    // submitting its stale transaction must not be handed an active row.
    const verified = await verifyAppleTransaction(await receipt({ expiresDate: NOW.getTime() - 1000 }), options());
    expect(verified.event.status).toBe("expired");
  });

  test("a subscription still inside its period reads as active", async () => {
    const verified = await verifyAppleTransaction(await receipt({ expiresDate: NOW.getTime() + 1000 }), options());
    expect(verified.event.status).toBe("active");
  });

  test("the instant of expiry is already expired — entitlement is `now < expiresAt`, not `<=`", async () => {
    // A boundary worth pinning rather than discovering. The projection's SQL uses the same strict comparison,
    // so the two paths agree on the one millisecond where it matters.
    const verified = await verifyAppleTransaction(await receipt({ expiresDate: NOW.getTime() }), options());
    expect(verified.event.status).toBe("expired");
  });

  test("a revoked transaction reads as refunded, whatever its expiry says", async () => {
    // Revocation wins: a refunded transaction inside its paid period must not grant.
    const verified = await verifyAppleTransaction(
      await receipt({ revocationDate: NOW.getTime() - 5000, expiresDate: NOW.getTime() + 100_000 }),
      options(),
    );
    expect(verified.event.status).toBe("refunded");
    expect(verified.event.revokedAt).toEqual(new Date(NOW.getTime() - 5000));
  });

  test("a one-time purchase never expires and reads as active", async () => {
    const { expiresDate: _dropped, originalTransactionId: _also, ...oneOff } = didRenew.transaction;
    const verified = await verifyAppleTransaction(await signJws(oneOff, chain), options());
    expect(verified.event.status).toBe("active");
    expect(verified.event.expiresAt).toBeNull();
    expect(verified.event.originalTransactionId).toBeNull();
  });

  test("a sandbox transaction is marked sandbox", async () => {
    const verified = await verifyAppleTransaction(await receipt({ environment: "Sandbox" }), options());
    expect(verified.event.environment).toBe("sandbox");
  });

  test("a transaction with no appAccountToken has no account link — and says so", async () => {
    const { appAccountToken: _dropped, ...anonymous } = didRenew.transaction;
    const verified = await verifyAppleTransaction(await signJws(anonymous, chain), options());
    expect(verified.providerAccountId).toBeNull();
  });

  test("refuses a transaction for another app's bundle id", async () => {
    await expect(verifyAppleTransaction(await receipt({ bundleId: "com.someone.else" }), options())).rejects.toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses a transaction signed by a chain that is not Apple's", async () => {
    const rogue = await mintChain({ label: "rogue" });
    const jws = await signJws(didRenew.transaction, rogue);
    await expect(verifyAppleTransaction(jws, options())).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a payload that is not a transaction", async () => {
    await expect(verifyAppleTransaction(await signJws({ hello: "world" }, chain), options())).rejects.toThrow(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses something that is not a JWS at all", async () => {
    await expect(verifyAppleTransaction("this-is-not-a-jws", options())).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("never echoes the submitted receipt in the client-visible message", async () => {
    // The receipt is a bearer-ish artifact and the message is what a stranger reads. Throw-site context
    // belongs in `detail`, which the HTTP codec strips.
    const rogue = await mintChain({ label: "rogue" });
    const jws = await signJws(didRenew.transaction, rogue);
    let thrown: PaymentsVerificationFailedError | undefined;
    try {
      await verifyAppleTransaction(jws, options());
    } catch (error) {
      thrown = error as PaymentsVerificationFailedError;
    }
    expect(thrown?.payload.message).not.toContain(jws);
    expect(thrown?.payload.detail ?? "").not.toContain(jws);
  });
});
