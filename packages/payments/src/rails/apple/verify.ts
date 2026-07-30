// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { minorUnitsFromScaled } from "../../data/money";
import type { PurchaseStatus } from "../../data/status";
import { PaymentsInvalidReceiptError } from "../../error/errors";
import type { UnboundProviderEvent, VerifiedPurchase } from "../contract";
import { verifyAppleJws } from "./jws";
import { APPLE_PRICE_SCALE, AppleTransactionInfo, appleEnvironment, requireAppleBundle } from "./notification";

/**
 * The client-submission path: a StoreKit 2 signed transaction, verified locally.
 *
 * **There is no store round-trip here, and that is Apple's own design.** StoreKit 2 hands the app a JWS that
 * Apple signed; verifying it against Apple's certificate chain is exactly as strong as asking the App Store
 * Server API, and it is what Apple documents. So this route can be fast and offline, which is what it is
 * for: the buying user sees their entitlement the moment they buy, without waiting for a webhook that is
 * authoritative but not prompt.
 *
 * Nothing about correctness rests on this path. The webhook produces the identical row through the same
 * idempotent writer, so a dropped submission costs nothing and a replayed one changes nothing.
 *
 * Status has to be derived differently from the webhook path. A notification says what *happened*; a
 * transaction only says what it *is*, so there are two facts to read and an order to read them in:
 *
 * 1. **A revocation date wins.** A refunded transaction inside its paid period must not grant, and the
 *    revocation is the later fact.
 * 2. **Otherwise the expiry decides.** A subscription past its `expiresDate` is expired even though no
 *    notification ever said so — which is the case the read-time recheck exists for. Apple stops renewing
 *    and sends nothing; a client resubmitting its stale transaction must not be handed an active row.
 *
 * Everything else is active. A transaction Apple signed, that was not revoked and has not lapsed, is paid.
 */

/** What verification needs: our bundle id, the roots to trust, and the clock the expiry is judged against. */
export interface VerifyAppleTransactionOptions {
  /** Our own bundle id. A transaction from any other app is refused, whoever signed it. */
  bundleId: string;
  /** base64 DER of every acceptable root. Defaults to the pinned Apple roots. */
  roots?: readonly string[];
  /** The clock. Also what `expiresDate` is compared against, so a lapse is deterministic in tests. */
  now: Date;
}

/** Verify a StoreKit 2 signed transaction and normalize it. The caller binds the authenticated purchaser. */
export async function verifyAppleTransaction(
  receipt: string,
  options: VerifyAppleTransactionOptions,
): Promise<VerifiedPurchase> {
  const payload = await verifyAppleJws(receipt, { roots: options.roots, now: options.now });
  const parsed = AppleTransactionInfo.safeParse(payload);
  if (!parsed.success) {
    // Never echo the receipt: it is caller-supplied and it is what a stolen one would look like in a log.
    throw new PaymentsInvalidReceiptError({
      detail: `Apple: the submitted transaction is not a StoreKit transaction — ${issues(parsed.error)}.`,
    });
  }
  const transaction = parsed.data;
  requireAppleBundle(transaction.bundleId, options.bundleId, "transaction");

  const event: UnboundProviderEvent = {
    rail: "apple",
    providerTransactionId: transaction.transactionId,
    providerProductId: transaction.productId,
    status: transactionStatus(transaction, options.now),
    environment: appleEnvironment(transaction.environment),
    purchasedAt: new Date(transaction.purchaseDate),
    expiresAt: transaction.expiresDate === undefined ? null : new Date(transaction.expiresDate),
    revokedAt: transaction.revocationDate === undefined ? null : new Date(transaction.revocationDate),
    originalTransactionId: transaction.originalTransactionId ?? null,
    amountMinor: minorUnitsFromScaled(transaction.price ?? null, APPLE_PRICE_SCALE, transaction.currency ?? null),
    currency: transaction.currency ?? null,
    // Apple's clock on the transaction itself. There is no notification here to take an event time from, and
    // ours would order by delivery, which is the one ordering providers do not guarantee.
    providerEventAt: new Date(transaction.signedDate),
    payload: transaction as Record<string, unknown>,
  };

  return { event, providerAccountId: transaction.appAccountToken ?? null };
}

/** The status a transaction implies on its own: revoked, then lapsed, then paid. */
function transactionStatus(transaction: z.output<typeof AppleTransactionInfo>, now: Date): PurchaseStatus {
  if (transaction.revocationDate !== undefined) return "refunded";
  if (transaction.expiresDate !== undefined && transaction.expiresDate <= now.getTime()) return "expired";
  return "active";
}

/** Zod issues as `path:code` pairs — never `message` or `received`, which would echo the receipt. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ");
}
