// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { PurchaseStatus } from "../data/status";
import { PaymentsClawbackFailedError } from "../error/errors";
import type { PurchaseProjection } from "../projection/writer";
import type { GrantOptions } from "./apply";
import { ledgerGrantFor } from "./apply";
import type { PaymentsLedger } from "./ledgerSeam";

/**
 * The refund clawback: taking back what a `grants` clause credited, where — and only where — the catalog says
 * to.
 *
 * **A clawback can fail, and that failure is correct behaviour.** The ledger's `CHECK (balance >= 0)` refuses
 * a debit the balance cannot cover, and a player who spent their coins before the refund arrived is exactly
 * that case. There are only three things to do about it and two are wrong: allow a negative balance, which
 * breaks the invariant the ledger exists to hold; write the difference off silently, which leaves nothing
 * anywhere to read; or accept the refusal and record it. This module does the third.
 *
 * So the shape is: the refund is projected and audited **unconditionally** by the caller, the clawback is
 * attempted **only** where `clawback: true`, and a refusal is returned as an outcome rather than thrown.
 * `fulfillPurchase` turns that outcome into a `payments/clawback_failed` audit event at `critical` — a
 * recorded, queryable, alertable state, which is what issue #79 asks for and what an exception could not be.
 *
 * **Off by default**, and that default is the honest one. Clawing back is the exception: the user may well
 * have spent the currency legitimately, and a store's refund decision is not automatically a fraud finding. A
 * project that sells hard currency and has decided otherwise says so per product, in one word.
 */

/** The statuses that mean this charge came back — the two a clawback answers. */
const REVERSED_STATUSES: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>(["refunded", "revoked"]);

/** The ledger's own code for the refusal a clawback is expected to meet. Anything else is unknown, not short. */
const INSUFFICIENT_FUNDS_CODE = "ledger/insufficient_funds";

/**
 * One attempted reversal. `refused` carries its payload rather than a boolean, because the shortfall has to
 * survive as far as the audit trail with its code and its context intact.
 */
export type ClawbackOutcome =
  | {
      /** The debit applied, or was recognised as one already applied. */
      outcome: "reversed";
      /** The ledger currency debited. */
      currency: string;
      /** How much, as an integer in the currency's minor unit. */
      amount: number;
      /** The idempotency key the ledger recorded it under. */
      ref: string;
    }
  | {
      /** The balance could not cover it. The refund stands; the difference is a fact for a human. */
      outcome: "refused";
      /** The ledger currency the debit was attempted in. */
      currency: string;
      /** How much the reversal would have taken. */
      amount: number;
      /** The idempotency key the debit was attempted under. */
      ref: string;
      /** The refusal, as the payload the audit trail records. */
      error: PaymentsClawbackFailedError;
    };

/**
 * The idempotency key for one reversal. Distinct from the grant's by its verb: sharing the grant's ref would
 * make the debit look like a replayed credit, which the ledger swallows as success — so the reversal would
 * report success and move nothing.
 */
export function clawbackRef(purchaseId: string, currency: string): string {
  return `payments:clawback:${purchaseId}:${currency}`;
}

/**
 * Reverse what a refunded purchase credited, if the catalog opted in.
 *
 * Runs on every delivery of the refund, not only the first: the debit is idempotent on its ref, so a
 * redelivery is a no-op and a delivery that arrived after an earlier attempt failed is the repair.
 */
export async function clawbackGrants(
  ledger: PaymentsLedger,
  projection: PurchaseProjection,
  options: GrantOptions,
): Promise<ClawbackOutcome[]> {
  const { purchase } = projection;
  const product = options.config.products[purchase.productId];
  const grant = ledgerGrantFor(options.config, purchase.productId);
  // `role` first, and for the mirror of the reason `purchaseIsPaid` checks it first: a `state` row records a
  // subscription's standing rather than a charge, so it never credited and there is nothing to take back.
  // Debiting one would take currency the buyer was never given — the same row's `revoked` status is what a
  // refund correctly writes there, so without this line every clawback-enabled Lemon Squeezy product would
  // debit twice for one refund.
  if (purchase.role === "state") return [];
  if (grant === undefined || product?.clawback !== true || !REVERSED_STATUSES.has(purchase.status)) return [];

  const ref = clawbackRef(purchase.id, grant.currency);
  try {
    await ledger.debit(purchase.userId, grant.currency, grant.amount, ref, {
      memo: `payments refund ${purchase.rail} ${purchase.productId}`,
    });
  } catch (cause) {
    // Only the ledger's own solvency refusal is an outcome. A transient D1 fault reaches here unwrapped —
    // `openLedger` classifies aborts by regexing the message — and recording that as "the balance was short"
    // would assert something we do not know. It propagates, and the stable ref settles it on the retry.
    if (!(cause instanceof PithyError) || cause.payload.code !== INSUFFICIENT_FUNDS_CODE) throw cause;
    return [
      {
        outcome: "refused",
        currency: grant.currency,
        amount: grant.amount,
        ref,
        error: new PaymentsClawbackFailedError(
          {
            detail: `Reversing ${grant.amount} ${grant.currency} for ${purchase.userId} after the refund of ${purchase.rail} transaction ${purchase.providerTransactionId} exceeds their available balance.`,
          },
          { cause },
        ),
      },
    ];
  }
  return [{ outcome: "reversed", currency: grant.currency, amount: grant.amount, ref }];
}
