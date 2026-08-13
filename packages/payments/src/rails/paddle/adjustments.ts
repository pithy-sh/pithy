// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { minorAmount, type PaddleAdjustment, type PaddleTransaction } from "./objects";

/**
 * What a transaction has had taken back off it — every approved adjustment, not just the one in hand.
 *
 * ## Why one adjustment's own total is not the answer
 *
 * Paddle raises an adjustment per refund, not per transaction. A seller refunding 99.00 in two goes
 * raises **two** approved `refund` adjustments of 49.50, and neither one on its own reaches the
 * transaction's grand total. A comparison against a single adjustment therefore calls both of them
 * partial, revokes nothing, and leaves a fully refunded customer holding what they bought.
 *
 * So the comparison is against the **sum**, and the sum comes from Paddle: `GET /transactions/{id}` with
 * `include=adjustments` returns every adjustment raised against it. See `read.ts`.
 *
 * ## Why the adjustment in hand is merged in by id rather than trusted to be in the list
 *
 * The delivery that carries an `adjustment.created` can reach us before that adjustment is visible on the
 * transaction's own include, and Paddle makes no ordering promise between the two. Merging by id is
 * therefore both safe and necessary: present in the list, the in-hand copy replaces a staler one; absent,
 * it is added, and the very refund being processed still counts toward its own total.
 *
 * ## Why an unreadable amount is null and never zero
 *
 * A figure this build cannot parse is not evidence of a small refund. Summing it as zero would call a full
 * refund partial; summing it as the total would revoke an entitlement on a guess. Null, and the caller
 * says so in a note an operator can act on.
 */

/**
 * The adjustment actions that revoke an entitlement when approved, and the ones that do not.
 *
 * `chargeback_warning` and its **reverse** are both here as stated rows rather than as an omission — the
 * live `action` enum carries `chargeback_warning_reverse`, which the issue's table does not name. A
 * warning is a notice that a dispute has been opened, not a decision, so neither moves anything. A
 * `credit` against a balance is not a revocation either.
 */
export const REVOKING_ACTIONS: ReadonlySet<string> = new Set(["refund", "chargeback"]);

/** The adjustment actions that restore what a revocation took. */
export const RESTORING_ACTIONS: ReadonlySet<string> = new Set(["chargeback_reverse"]);

/** What every approved revoking adjustment against one transaction comes to, and what that means. */
export interface AdjustmentTally {
  /**
   * Every approved revoking adjustment against the transaction, summed, in the currency's lowest
   * denomination — or null when any one of them carries an amount this build could not read.
   */
  revokedMinor: number | null;
  /** The transaction's own grand total, or null when this build could not read one. */
  totalMinor: number | null;
  /** How many adjustments the sum counted. Two is the case a single-adjustment comparison gets wrong. */
  counted: number;
  /**
   * Whether what has been taken back covers the whole transaction.
   *
   * False whenever either figure is null, deliberately: a full refund is a claim, and an unreadable amount
   * is not evidence for it.
   */
  full: boolean;
}

/** Sum every approved revoking adjustment against this transaction, the one in hand included. */
export function tallyAdjustments(adjustment: PaddleAdjustment, transaction: PaddleTransaction): AdjustmentTally {
  // Merged by id: the in-hand copy is the fresher of the two, and it counts whether or not Paddle's
  // include has caught up with it yet.
  const byId = new Map<string, PaddleAdjustment>();
  for (const other of transaction.adjustments ?? []) byId.set(other.id, other);
  byId.set(adjustment.id, adjustment);

  let revokedMinor: number | null = 0;
  let counted = 0;
  for (const one of byId.values()) {
    if (one.status !== "approved" || !REVOKING_ACTIONS.has(one.action)) continue;
    counted += 1;
    const amount = minorAmount(one.totals?.total);
    if (amount === null) {
      revokedMinor = null;
      continue;
    }
    if (revokedMinor !== null) revokedMinor += amount;
  }

  const totalMinor = minorAmount(transaction.details?.totals?.grand_total);
  return {
    revokedMinor,
    totalMinor,
    counted,
    full: totalMinor !== null && revokedMinor !== null && revokedMinor >= totalMinor,
  };
}
