// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { REVOKING_ACTIONS, tallyAdjustments } from "./adjustments";
import { PaddleAdjustment, PaddleTransaction } from "./objects";

/**
 * The sum, and the case a single-adjustment comparison gets wrong.
 *
 * Every fixture here is parsed through the real Zod objects rather than cast, so a field the schema does
 * not carry — `adjustments` on a transaction is the new one — fails here rather than being silently
 * dropped and leaving the sum reading one adjustment forever.
 */

const TXN = "txn_01hv8wptq8987qeep44cyrewp9";

/** A transaction of 9900, with whatever adjustments and totals a case gives it. */
function transaction(
  adjustments: unknown[] | undefined,
  totals: Record<string, unknown> = { grand_total: "9900", currency_code: "USD" },
): PaddleTransaction {
  return PaddleTransaction.parse({
    id: TXN,
    status: "completed",
    customer_id: "ctm_01",
    items: [{ price: { id: "pri_01" } }],
    details: { totals },
    adjustments,
    created_at: "2026-08-12T09:00:00Z",
  });
}

/** One adjustment against it. */
function adjustment(overrides: Record<string, unknown> = {}): PaddleAdjustment {
  return PaddleAdjustment.parse({
    id: "adj_01",
    action: "refund",
    status: "approved",
    transaction_id: TXN,
    totals: { total: "4950" },
    created_at: "2026-08-12T10:00:00Z",
    ...overrides,
  });
}

describe("tallyAdjustments", () => {
  test("two approved partial refunds covering the whole transaction are full", async () => {
    // The defect this exists for. Two `refund` adjustments of 4950 against a 9900 transaction: each on its
    // own is partial, and together they are the customer's entire money back. Comparing one adjustment's
    // own total against the grand total calls both partial, revokes nothing, and leaves a fully refunded
    // customer holding the entitlement.
    const second = adjustment({ id: "adj_02" });
    const tally = tallyAdjustments(second, transaction([adjustment({ id: "adj_01" }), second]));

    expect(tally.revokedMinor).toBe(9900);
    expect(tally.totalMinor).toBe(9900);
    // Anti-vacuity: the sum genuinely counted both, rather than reaching 9900 by reading one twice.
    expect(tally.counted).toBe(2);
    expect(tally.full).toBe(true);
  });

  test("one partial refund is still partial", async () => {
    // The other half of the claim. Making everything full would revoke on every refund, which is worse
    // than the defect it replaces.
    const tally = tallyAdjustments(adjustment(), transaction([adjustment()]));
    expect(tally.revokedMinor).toBe(4950);
    expect(tally.counted).toBe(1);
    expect(tally.full).toBe(false);
  });

  test("an adjustment Paddle's include has not caught up with still counts toward its own total", async () => {
    // `adjustment.created` can reach us before the transaction's include lists it, and Paddle promises no
    // ordering between the two. If the in-hand adjustment were trusted to be in the list, a refund would
    // count as zero on the delivery that carries it.
    const first = adjustment({ id: "adj_01" });
    const second = adjustment({ id: "adj_02" });
    const tally = tallyAdjustments(second, transaction([first]));
    expect(tally.counted).toBe(2);
    expect(tally.revokedMinor).toBe(9900);
    expect(tally.full).toBe(true);
  });

  test("the in-hand copy replaces a staler one of the same id rather than being added twice", async () => {
    // `adjustment.updated` carries a new total for an id the include already holds. Adding both would
    // double-count and revoke on half a refund.
    const stale = adjustment({ id: "adj_01", totals: { total: "1000" } });
    const fresh = adjustment({ id: "adj_01", totals: { total: "4950" } });
    const tally = tallyAdjustments(fresh, transaction([stale]));
    expect(tally.counted).toBe(1);
    expect(tally.revokedMinor).toBe(4950);
    expect(tally.full).toBe(false);
  });

  test("only approved revoking adjustments count", async () => {
    // A credit against a balance is not a revocation, and a pending refund has not happened. Both summed
    // would revoke an entitlement nobody has lost.
    const credit = adjustment({ id: "adj_credit", action: "credit", totals: { total: "4950" } });
    const pending = adjustment({ id: "adj_pending", status: "pending_approval", totals: { total: "4950" } });
    const inHand = adjustment({ id: "adj_real", totals: { total: "4950" } });
    const tally = tallyAdjustments(inHand, transaction([credit, pending, inHand]));
    expect(tally.counted).toBe(1);
    expect(tally.revokedMinor).toBe(4950);
    expect(tally.full).toBe(false);
  });

  test("a chargeback counts alongside a refund, because both take the money back", async () => {
    const back = adjustment({ id: "adj_cb", action: "chargeback", totals: { total: "4950" } });
    const tally = tallyAdjustments(back, transaction([adjustment({ id: "adj_01" }), back]));
    expect(tally.counted).toBe(2);
    expect(tally.full).toBe(true);
    // The vocabulary this depends on, stated rather than assumed.
    expect([...REVOKING_ACTIONS].sort()).toEqual(["chargeback", "refund"]);
  });

  test("an unreadable adjustment amount is null, never zero", async () => {
    // Zero would call a full refund partial. The total would revoke on a guess. Neither is honest.
    const unreadable = adjustment({ id: "adj_bad", totals: { total: "not-a-number" } });
    const tally = tallyAdjustments(unreadable, transaction([adjustment({ id: "adj_01" }), unreadable]));
    expect(tally.revokedMinor).toBeNull();
    expect(tally.counted).toBe(2);
    expect(tally.full).toBe(false);
  });

  test("an unreadable transaction total is not evidence of a full refund", async () => {
    const tally = tallyAdjustments(
      adjustment({ totals: { total: "99999" } }),
      transaction([], { currency_code: "USD" }),
    );
    expect(tally.totalMinor).toBeNull();
    expect(tally.full).toBe(false);
  });

  test("a transaction whose read carried no adjustments still counts the one in hand", async () => {
    // An API key without adjustment read permission gets no `adjustments` array. The tally degrades to the
    // one adjustment it was handed rather than to nothing at all.
    const tally = tallyAdjustments(adjustment({ totals: { total: "9900" } }), transaction(undefined));
    expect(tally.counted).toBe(1);
    expect(tally.full).toBe(true);
  });

  test("the transaction schema narrows the adjustments the sum reads, rather than passing them through", async () => {
    // `PaddleTransaction` is `.loose()`, so an undeclared `adjustments` key would *still arrive* — the sum
    // would work and every case above would pass while the array crossed the trust boundary unvalidated.
    // The gate that can actually fail is therefore refusal: a hostile array is refused only while the
    // field is declared, and the moment the declaration is dropped this passes garbage into the tally.
    expect(() =>
      transaction([{ id: "adj_01", action: "refund", transaction_id: TXN, totals: { total: 4950 } }]),
    ).toThrow();
    expect(() => transaction(["not an adjustment at all"])).toThrow();
    // And the well-formed array survives narrowing, so the refusal is not simply refusing everything.
    expect(transaction([adjustment({ id: "adj_01" })]).adjustments).toHaveLength(1);
  });
});
