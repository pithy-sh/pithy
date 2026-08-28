// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { undescribed } from "@pithy-sh/core/src/schema/describedness";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { minorAmount } from "../rails/paddle/objects";
import { renderMoney } from "./renderMoney";
import {
  DeferredSubscriptionSettlement,
  nextSubscriptionEvent,
  QuotedMoney,
  RefundRequest,
  RefundRequestOutcome,
  RefundRequestStatus,
  ScheduledSubscriptionChange,
  SubscriptionCancelTiming,
  SubscriptionChangeQuote,
  SubscriptionSettlement,
  SubscriptionStanding,
} from "./subscription";

/**
 * The Paddle sandbox, recorded on 2026-08-28 against Solo (`pri_01kzvyz9e21z9vbhd7xqq3csyh`, $6/mo) and
 * Team (`pri_01kzvyz9khsdy36z10wb8bgmq4`, $110/mo). Every string is verbatim, including the sign and
 * including the microseconds, because the point of the fixture is that this package never got to choose
 * them. Numbers appear nowhere below except where {@link minorAmount} produced them.
 */
const RECORDED = {
  /** A) preview of an upgrade Solo → Team with `proration_billing_mode: prorated_immediately`. */
  upgrade: {
    update_summary: {
      credit: { amount: "-380", currency_code: "USD" },
      charge: { amount: "6962", currency_code: "USD" },
      result: { action: "charge", amount: "6582", currency_code: "USD" },
    },
    immediate_totals: {
      subtotal: "6045",
      tax: "537",
      discount: "0",
      total: "6582",
      grand_total: "6582",
      credit: "0",
      credit_to_balance: "0",
      balance: "6582",
      currency_code: "USD",
      exchange_rate: "1",
      fee: null,
      earnings: null,
    },
    immediate_billing_period: { starts_at: "2026-08-28T11:13:32.939Z", ends_at: "2026-09-15T11:42:21.789736Z" },
    recurring_totals: { subtotal: "11000", tax: "976", grand_total: "11976", currency_code: "USD" },
  },
  /** B) preview of a downgrade Team → Solo, also `prorated_immediately`. The one that broke the design. */
  downgrade: {
    update_summary: {
      credit: { amount: "-6961", currency_code: "USD" },
      charge: { amount: "380", currency_code: "USD" },
      result: { action: "credit", amount: "6581", currency_code: "USD" },
    },
    immediate_totals: {
      subtotal: "-6045",
      tax: "-536",
      total: "-6581",
      // The lie. Zero, while the customer is owed 6581 — which sits in `credit_to_balance`.
      grand_total: "0",
      grand_total_tax: "0",
      credit: "0",
      credit_to_balance: "6581",
      balance: "0",
      currency_code: "USD",
      exchange_rate: "1",
      fee: null,
      earnings: null,
    },
    recurring_totals: { subtotal: "600", tax: "53", grand_total: "653", currency_code: "USD" },
  },
  /**
   * B′) the same downgrade under `prorated_next_billing_period` — **the mode a downgrade actually ships
   * with**, and the recording that broke the two-part quote. Nothing settles today, a credit of 6558 is
   * owed, and it lands on the invoice of 15 September. Three facts.
   */
  downgradeDeferred: {
    immediate_transaction: null,
    update_summary: {
      credit: { amount: "-6936" },
      charge: { amount: "378" },
      result: { action: "credit", amount: "6558", currency_code: "USD" },
    },
    recurring_totals: {
      subtotal: "600",
      tax: "53",
      total: "653",
      grand_total: "653",
      credit_to_balance: "0",
      currency_code: "USD",
    },
    // The second credit figure: this is 6558 with the next period's own 653 already netted off it.
    next_transaction_totals: {
      subtotal: "-5424",
      tax: "-481",
      total: "-5905",
      grand_total: "0",
      credit_to_balance: "5905",
      currency_code: "USD",
    },
    next_transaction_billing_period: {
      starts_at: "2026-09-15T11:42:21.789736Z",
      ends_at: "2026-10-15T11:42:21.789736Z",
    },
    status: "active",
    next_billed_at: "2026-09-15T11:42:21.789736Z",
  },
  /** C) the subscription after `cancel({ effective_from: "next_billing_period" })`. */
  canceling: {
    status: "active",
    canceled_at: null,
    next_billed_at: null,
    scheduled_change: {
      action: "cancel",
      effective_at: "2026-09-15T11:42:21.789736Z",
      resume_at: null,
      items: null,
    },
  },
  /** D) the same subscription after `update(subscription, { scheduled_change: null })` — the withdrawal. */
  withdrawn: {
    status: "active",
    scheduled_change: null,
    items: [{ price_id: "pri_01kzvyz9khsdy36z10wb8bgmq4", quantity: 1 }],
  },
} as const;

/** When the period both recordings share ends. The instant a screen prints as "15 Sep". */
const PERIOD_END = "2026-09-15T11:42:21.789736Z";

/**
 * A quoted amount built the way the rail builds one: Paddle's own string, Paddle's own currency, and the
 * figure rendered from them.
 *
 * The rendering goes through `renderMoney` rather than being pasted, so a fixture below cannot state a
 * price the renderer would not produce — which is the one way a shape test could pass while the sentence
 * on the screen is wrong. `renderMoney`'s own correctness is `renderMoney.test.ts`'s subject, not this
 * file's; here it is a source of a plausible string.
 */
function quoted(wire: string, currencyCode: string): unknown {
  const currency = currencyCode.toLowerCase();
  const amountMinor = minorAmount(wire);
  return { amountMinor, currency, rendered: renderMoney(amountMinor ?? 0, currency, "en") };
}

describe("QuotedMoney", () => {
  test("a negative amount round-trips — the sign is data, not an error", () => {
    // `update_summary.credit.amount` is "-380" on an upgrade and "-6961" on a downgrade, and a
    // downgrade's subtotal, tax and total are all negative. A `.nonnegative()` here — which the
    // specification written from the docs had — throws on every real change a customer makes.
    for (const wire of ["-380", "-6961", "-6045"]) {
      const parsed = QuotedMoney.parse(quoted(wire, "USD"));
      expect(parsed.amountMinor).toBe(Number(wire));
      expect(parsed.amountMinor).toBeLessThan(0);
      expect(QuotedMoney.parse(parsed)).toEqual(parsed);
    }
  });

  test("zero is money too, and so is the largest amount Paddle can state", () => {
    expect(QuotedMoney.parse({ amountMinor: 0, currency: "usd", rendered: "$0.00" }).amountMinor).toBe(0);
    expect(
      QuotedMoney.parse({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "jpy", rendered: "¥9,007,199,254,740,991" })
        .amountMinor,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("a non-integer is refused — money in minor units has no fraction", () => {
    // 65.82 is what somebody reaches for having read "$65.82". The wire says "6582" and means 6582.
    for (const bad of [65.82, 0.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => QuotedMoney.parse({ amountMinor: bad, currency: "usd", rendered: "$65.82" })).toThrow();
    }
  });

  test("a malformed currency is refused, and Paddle's own uppercase is malformed here", () => {
    // Paddle sends "USD"; every other rail in this package stores lowercase, and `currencyOf` is what
    // does the lowering. A quote carrying "USD" would compare unequal to a purchase row's "usd" and
    // sort into its own bucket in any report that groups by currency.
    for (const bad of ["USD", "Usd", "us", "usdd", "", "us1", " usd"]) {
      expect(() => QuotedMoney.parse({ amountMinor: 1, currency: bad, rendered: "$0.01" })).toThrow();
    }
    expect(QuotedMoney.parse({ amountMinor: 1, currency: "usd", rendered: "$0.01" }).currency).toBe("usd");
  });

  test("all three parts are required — an amount without a currency is not money", () => {
    expect(() => QuotedMoney.parse({ amountMinor: 6582, rendered: "$65.82" })).toThrow();
    expect(() => QuotedMoney.parse({ currency: "usd", rendered: "$65.82" })).toThrow();
  });

  test("the rendered figure is required, and a blank one does not count as rendered", () => {
    // The defect this field exists for (#465): a shape carrying only minor units leaves every screen
    // downstream unable to state the amount a customer is being asked to confirm. An empty string is the
    // same screen with a gap where the price goes, so it is refused rather than accepted as "rendered".
    expect(() => QuotedMoney.parse({ amountMinor: 6582, currency: "usd" })).toThrow();
    expect(() => QuotedMoney.parse({ amountMinor: 6582, currency: "usd", rendered: "" })).toThrow();
    expect(QuotedMoney.parse({ amountMinor: 6582, currency: "usd", rendered: "$65.82" }).rendered).toBe("$65.82");
  });

  test("the rendered figure never replaces the number a consumer compares", () => {
    // Both, always: `amountMinor` is what sorts and compares, `rendered` is what a person reads. A shape
    // that dropped either would push the other's job onto a client that cannot do it.
    const money = QuotedMoney.parse({ amountMinor: 6582, currency: "jpy", rendered: "¥6,582" });
    expect(money.amountMinor).toBe(6582);
    expect(money.rendered).toBe("¥6,582");
    expect(QuotedMoney.parse(money)).toEqual(money);
  });
});

describe("SubscriptionSettlement", () => {
  test("nothing settling today is a representable outcome, and it carries no amount", () => {
    // Fact 5: with `prorated_next_billing_period` — the mode the downgrade policy uses —
    // `immediate_transaction` comes back null, which recording B′ below shows rather than assumes. A
    // quote that could not say this would have to invent a zero, and a zero charge renders as "You will
    // be charged $0.00 now", which is not what happens.
    const settled = SubscriptionSettlement.parse({ outcome: "nothing" });
    expect(settled.outcome).toBe("nothing");
    expect(settled).not.toHaveProperty("amount");
  });

  test("an amount smuggled onto the nothing outcome does not survive the parse", () => {
    const settled = SubscriptionSettlement.parse({
      outcome: "nothing",
      amount: { amountMinor: 0, currency: "usd", rendered: "$0.00" },
    });
    expect(settled).toEqual({ outcome: "nothing" });
  });

  test("a charge and a credit both require an amount — a direction alone renders nothing", () => {
    expect(() => SubscriptionSettlement.parse({ outcome: "charge" })).toThrow();
    expect(() => SubscriptionSettlement.parse({ outcome: "credit" })).toThrow();
  });

  test("the outcomes are the three, and Paddle's own vocabulary is not among them", () => {
    for (const bad of ["refund", "none", "charge_immediately", "do_not_bill"]) {
      expect(() =>
        SubscriptionSettlement.parse({ outcome: bad, amount: { amountMinor: 1, currency: "usd", rendered: "$0.01" } }),
      ).toThrow();
    }
  });
});

describe("DeferredSubscriptionSettlement", () => {
  test("it is the two directions, and `nothing` is not one of them", () => {
    // The nullable `nextInvoice` block already says that nothing lands later. A `nothing` inside it
    // would be a second spelling of that, and a screen checking one and not the other prints an empty
    // row on the customer's next invoice: "$— credit on 15 Sep".
    expect(
      DeferredSubscriptionSettlement.parse({
        outcome: "credit",
        amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" },
      }),
    ).toEqual({ outcome: "credit", amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } });
    expect(
      DeferredSubscriptionSettlement.parse({
        outcome: "charge",
        amount: { amountMinor: 1, currency: "usd", rendered: "$0.01" },
      }),
    ).toEqual({ outcome: "charge", amount: { amountMinor: 1, currency: "usd", rendered: "$0.01" } });
    expect(() => DeferredSubscriptionSettlement.parse({ outcome: "nothing" })).toThrow();
  });

  test("a deferred settlement still cannot carry a bare amount", () => {
    expect(() => DeferredSubscriptionSettlement.parse({ outcome: "credit" })).toThrow();
    expect(() =>
      DeferredSubscriptionSettlement.parse({ amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } }),
    ).toThrow();
  });
});

describe("SubscriptionChangeQuote", () => {
  test("recording A reads as a charge of 6582, then 11976 from the period end", () => {
    const summary = RECORDED.upgrade.update_summary.result;
    const quote = SubscriptionChangeQuote.parse({
      settlesToday: {
        outcome: summary.action,
        amount: quoted(summary.amount, summary.currency_code),
      },
      // An upgrade settles in full today. Nothing from the change lands on the next invoice, and null
      // is how the quote says so — the recurring block below is the whole of what comes after.
      nextInvoice: null,
      recurring: {
        amount: quoted(RECORDED.upgrade.recurring_totals.grand_total, RECORDED.upgrade.recurring_totals.currency_code),
        startsAt: RECORDED.upgrade.immediate_billing_period.ends_at,
      },
    });

    expect(quote.settlesToday).toEqual({
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" },
    });
    expect(quote.nextInvoice).toBeNull();
    expect(quote.recurring?.amount).toEqual({ amountMinor: 11976, currency: "usd", rendered: "$119.76" });
    // Microseconds truncate to milliseconds, which is what a Date holds. A screen prints a day.
    expect(quote.recurring?.startsAt.toISOString()).toBe("2026-09-15T11:42:21.789Z");
  });

  test("recording B reads as a CREDIT of 6581 — not as the grand_total of 0 sitting beside it", () => {
    // Fact 2, and the reason the headline is `update_summary.result` rather than the totals. The
    // immediate transaction's `grand_total` on this downgrade is "0" while the customer is owed 6581,
    // because the money went to `credit_to_balance`. A quote built from the totals says "nothing
    // happens"; the customer's next statement disagrees.
    expect(minorAmount(RECORDED.downgrade.immediate_totals.grand_total)).toBe(0);

    const summary = RECORDED.downgrade.update_summary.result;
    const quote = SubscriptionChangeQuote.parse({
      settlesToday: {
        outcome: summary.action,
        amount: quoted(summary.amount, summary.currency_code),
      },
      // `prorated_immediately`: the credit lands on the balance today, so there is nothing deferred.
      nextInvoice: null,
      recurring: {
        amount: quoted(
          RECORDED.downgrade.recurring_totals.grand_total,
          RECORDED.downgrade.recurring_totals.currency_code,
        ),
        startsAt: PERIOD_END,
      },
    });

    expect(quote.settlesToday.outcome).toBe("credit");
    expect(quote.settlesToday).toEqual({
      outcome: "credit",
      amount: { amountMinor: 6581, currency: "usd", rendered: "$65.81" },
    });
    // The direction lives in `outcome`, so the amount is never rendered without it. Reading the amount
    // alone is a type error, not a mis-rendered credit.
    if (quote.settlesToday.outcome === "nothing") throw new Error("unreachable: this quote settles");
    expect(quote.settlesToday.amount.amountMinor).toBe(6581);
    expect(quote.recurring?.amount.amountMinor).toBe(653);
  });

  /**
   * Recording B′, mapped the way the rail maps it: the *presence* of an immediate transaction decides
   * **when** `update_summary.result` lands, and `result` itself decides **what** it is. Null immediate
   * transaction, so the result is deferred and today settles nothing.
   */
  const deferredDowngrade = () => {
    const recorded = RECORDED.downgradeDeferred;
    expect(recorded.immediate_transaction).toBeNull();
    const summary = recorded.update_summary.result;
    return SubscriptionChangeQuote.parse({
      settlesToday: { outcome: "nothing" },
      nextInvoice: {
        settlement: {
          outcome: summary.action,
          amount: quoted(summary.amount, summary.currency_code),
        },
        at: recorded.next_transaction_billing_period.starts_at,
      },
      recurring: {
        amount: quoted(recorded.recurring_totals.grand_total, recorded.recurring_totals.currency_code),
        startsAt: recorded.next_billed_at,
      },
    });
  };

  test("recording B′ holds all three facts a deferred downgrade has", () => {
    // The sentence the two-part quote could not write: "Nothing today. $65.58 credit on your next
    // invoice, 15 Sep. Then $6.53/month." Three facts, three parts, none of them derived from another.
    const quote = deferredDowngrade();

    expect(quote.settlesToday).toEqual({ outcome: "nothing" });
    expect(quote.nextInvoice?.settlement).toEqual({
      outcome: "credit",
      amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" },
    });
    expect(quote.nextInvoice?.at.toISOString()).toBe("2026-09-15T11:42:21.789Z");
    expect(quote.recurring?.amount).toEqual({ amountMinor: 653, currency: "usd", rendered: "$6.53" });
    expect(quote.recurring?.startsAt.toISOString()).toBe("2026-09-15T11:42:21.789Z");
  });

  test("the deferred credit cannot be misread as a charge today", () => {
    // Both halves of the defect, asserted as the two ways a screen could get it wrong. Reading
    // `update_summary.result` into `settlesToday` says "credited today" of a change that settles
    // nothing today; reading `immediate_transaction` — null — drops the 6558 out of the quote.
    const quote = deferredDowngrade();

    expect(quote.settlesToday.outcome).not.toBe("charge");
    expect(quote.settlesToday.outcome).not.toBe("credit");
    expect(quote.settlesToday).not.toHaveProperty("amount");
    // Narrowing proves it in the type as well as in the value: today's part carries no amount to
    // render, so no headline can be built out of one.
    if (quote.settlesToday.outcome !== "nothing") throw new Error("unreachable: this change settles nothing today");
    // And the money did not vanish with it.
    expect(quote.nextInvoice).not.toBeNull();
    if (quote.nextInvoice === null) throw new Error("unreachable: the credit lands on the next invoice");
    expect(quote.nextInvoice.settlement.outcome).toBe("credit");
    expect(quote.nextInvoice.settlement.amount.amountMinor).toBe(6558);
  });

  test("the figure carried is the change's own worth, not the next invoice's net of it", () => {
    // The recording states two credits. `update_summary.result` says 6558 — what this change is worth,
    // the only figure the customer is being asked to confirm. `next_transaction.totals` says
    // total "-5905" / credit_to_balance "5905" — the same credit with the next period's own 653
    // already netted off it. The quote states 6558 and 653 separately, so a screen showing both never
    // subtracts the same 653 twice; 5905 is a figure only the invoice can explain, and it is not here.
    const quote = deferredDowngrade();
    const netted = minorAmount(RECORDED.downgradeDeferred.next_transaction_totals.credit_to_balance);
    const recurring = minorAmount(RECORDED.downgradeDeferred.recurring_totals.grand_total);
    if (netted === null || recurring === null) throw new Error("unreachable: both are plain integer strings");

    expect(quote.nextInvoice?.settlement.amount.amountMinor).toBe(6558);
    expect(quote.nextInvoice?.settlement.amount.amountMinor).not.toBe(netted);
    expect(JSON.stringify(quote)).not.toContain(String(netted));
    // Stated so the relationship is on the record rather than inferred by the next reader — and
    // nothing in the module computes it. Both figures came off the wire.
    expect(netted).toBe(6558 - recurring);
  });

  test("nothing settling and nothing owed is a whole quote — two nulls, no invented zero", () => {
    // A change with no money in it at all: the tier moves, nothing is taken, nothing is owed back, and
    // the price stays what it was. Every part still answers, and none of them answers with a zero.
    const quote = SubscriptionChangeQuote.parse({
      settlesToday: { outcome: "nothing" },
      nextInvoice: null,
      recurring: { amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" }, startsAt: PERIOD_END },
    });

    expect(quote.settlesToday).toEqual({ outcome: "nothing" });
    expect(quote.nextInvoice).toBeNull();
    expect(quote.recurring?.amount.amountMinor).toBe(653);
  });

  test("a change that ends the subscription has no recurring amount, and null says so", () => {
    const quote = SubscriptionChangeQuote.parse({
      settlesToday: { outcome: "nothing" },
      nextInvoice: null,
      recurring: null,
    });
    expect(quote.recurring).toBeNull();
    expect(quote.nextInvoice).toBeNull();
  });

  test("a recurring block is whole or absent — an amount with no date is refused", () => {
    const amount = { amountMinor: 653, currency: "usd", rendered: "$6.53" };
    expect(() =>
      SubscriptionChangeQuote.parse({ settlesToday: { outcome: "nothing" }, nextInvoice: null, recurring: { amount } }),
    ).toThrow();
    expect(() =>
      SubscriptionChangeQuote.parse({
        settlesToday: { outcome: "nothing" },
        nextInvoice: null,
        recurring: { startsAt: PERIOD_END },
      }),
    ).toThrow();
  });

  test("a next-invoice block is whole or null — a credit with no date is refused, and so is a date alone", () => {
    // "You will be credited $65.58" with no day on it is the sentence this refuses. The date is not
    // borrowed from `recurring.startsAt` either: that block is nullable, so a screen reaching into it
    // for this date prints a credit with no date the first time a change ends the subscription.
    const settlement = { outcome: "credit", amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } };
    expect(() =>
      SubscriptionChangeQuote.parse({
        settlesToday: { outcome: "nothing" },
        nextInvoice: { settlement },
        recurring: null,
      }),
    ).toThrow();
    expect(() =>
      SubscriptionChangeQuote.parse({
        settlesToday: { outcome: "nothing" },
        nextInvoice: { at: PERIOD_END },
        recurring: null,
      }),
    ).toThrow();
  });

  test("a next invoice that settles nothing is not representable — null is how a quote says that", () => {
    expect(() =>
      SubscriptionChangeQuote.parse({
        settlesToday: { outcome: "nothing" },
        nextInvoice: { settlement: { outcome: "nothing" }, at: PERIOD_END },
        recurring: null,
      }),
    ).toThrow();
  });

  test("every part is stated — a quote missing one of the three is not a quote", () => {
    expect(() => SubscriptionChangeQuote.parse({ nextInvoice: null, recurring: null })).toThrow();
    expect(() =>
      SubscriptionChangeQuote.parse({
        settlesToday: { outcome: "charge", amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" } },
        nextInvoice: null,
      }),
    ).toThrow();
    // An absent `nextInvoice` is not a null one: null says the provider answered that nothing lands
    // later, absent says nobody looked — and the second is how the 6558 went missing.
    expect(() =>
      SubscriptionChangeQuote.parse({
        settlesToday: { outcome: "nothing" },
        recurring: { amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" }, startsAt: PERIOD_END },
      }),
    ).toThrow();
  });

  test("a parsed quote encodes back to the wire it came from, deferred part and all", () => {
    const wire = {
      settlesToday: { outcome: "charge" as const, amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" } },
      nextInvoice: null,
      recurring: {
        amount: { amountMinor: 11976, currency: "usd", rendered: "$119.76" },
        startsAt: "2026-09-15T11:42:21.789Z",
      },
    };
    expect(z.encode(SubscriptionChangeQuote, SubscriptionChangeQuote.parse(wire))).toEqual(wire);

    const deferred = {
      settlesToday: { outcome: "nothing" as const },
      nextInvoice: {
        settlement: { outcome: "credit" as const, amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } },
        at: "2026-09-15T11:42:21.789Z",
      },
      recurring: {
        amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" },
        startsAt: "2026-09-15T11:42:21.789Z",
      },
    };
    expect(z.encode(SubscriptionChangeQuote, SubscriptionChangeQuote.parse(deferred))).toEqual(deferred);
  });
});

describe("ScheduledSubscriptionChange", () => {
  test("recording C's scheduled cancel parses, resume date and all", () => {
    const change = ScheduledSubscriptionChange.parse({
      action: RECORDED.canceling.scheduled_change.action,
      effectiveAt: RECORDED.canceling.scheduled_change.effective_at,
      resumesAt: RECORDED.canceling.scheduled_change.resume_at,
    });
    expect(change.action).toBe("cancel");
    expect(change.effectiveAt.toISOString()).toBe("2026-09-15T11:42:21.789Z");
    expect(change.resumesAt).toBeNull();
  });

  test("a scheduled pause may name the date it comes back", () => {
    const change = ScheduledSubscriptionChange.parse({
      action: "pause",
      effectiveAt: PERIOD_END,
      resumesAt: "2026-12-01T00:00:00.000Z",
    });
    expect(change.action).toBe("pause");
    expect(change.resumesAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  test("the actions are the three Paddle schedules, and nothing else", () => {
    for (const bad of ["cancel_now", "downgrade", "renew", "canceled", ""]) {
      expect(() =>
        ScheduledSubscriptionChange.parse({ action: bad, effectiveAt: PERIOD_END, resumesAt: null }),
      ).toThrow();
    }
  });

  test("a scheduled change with no effective date is refused — the date is the whole message", () => {
    expect(() => ScheduledSubscriptionChange.parse({ action: "cancel", resumesAt: null })).toThrow();
    expect(() => ScheduledSubscriptionChange.parse({ action: "cancel", effectiveAt: null, resumesAt: null })).toThrow();
    expect(() =>
      ScheduledSubscriptionChange.parse({ action: "cancel", effectiveAt: "the fifteenth", resumesAt: null }),
    ).toThrow();
  });
});

describe("SubscriptionStanding", () => {
  /** Recording C: still `active`, `next_billed_at` gone, a cancel waiting at the period end. */
  const canceling = SubscriptionStanding.parse({
    status: "active",
    currency: "usd",
    currentPeriodEndsAt: PERIOD_END,
    nextBilledAt: RECORDED.canceling.next_billed_at,
    scheduledChange: {
      action: RECORDED.canceling.scheduled_change.action,
      effectiveAt: RECORDED.canceling.scheduled_change.effective_at,
      resumesAt: RECORDED.canceling.scheduled_change.resume_at,
    },
  });

  /** Recording D: the withdrawal. Nothing scheduled, and the renewal date is back. */
  const ordinary = SubscriptionStanding.parse({
    status: RECORDED.withdrawn.status,
    currency: "usd",
    currentPeriodEndsAt: PERIOD_END,
    nextBilledAt: PERIOD_END,
    scheduledChange: RECORDED.withdrawn.scheduled_change,
  });

  test("a pending cancel parses with a null nextBilledAt while the status stays active", () => {
    // Fact 3, and it is the trap: Paddle blanks `next_billed_at` the moment a cancellation is
    // scheduled and leaves `status: "active"` and `canceled_at: null`. A required `nextBilledAt`
    // throws here, and a status check alone reports a canceling subscription as an ordinary one.
    expect(canceling.status).toBe("active");
    expect(canceling.nextBilledAt).toBeNull();
    expect(canceling.scheduledChange?.action).toBe("cancel");
    expect(canceling.scheduledChange?.effectiveAt.toISOString()).toBe("2026-09-15T11:42:21.789Z");
  });

  test("it is distinguishable from an ordinary active subscription, which the status is not", () => {
    expect(ordinary.status).toBe(canceling.status);
    expect(ordinary.scheduledChange).toBeNull();
    expect(canceling.scheduledChange).not.toBeNull();
    expect(ordinary.nextBilledAt).not.toBeNull();
    expect(canceling).not.toEqual(ordinary);
  });

  test("the two sentences a screen has to write come out different", () => {
    expect(nextSubscriptionEvent(ordinary)).toEqual({ kind: "renews", at: new Date("2026-09-15T11:42:21.789Z") });
    expect(nextSubscriptionEvent(canceling)).toEqual({ kind: "ends", at: new Date("2026-09-15T11:42:21.789Z") });
  });

  test("a scheduled pause and a scheduled resume are their own sentences, not endings", () => {
    const paused = SubscriptionStanding.parse({
      status: "active",
      currency: "usd",
      currentPeriodEndsAt: PERIOD_END,
      nextBilledAt: null,
      scheduledChange: { action: "pause", effectiveAt: PERIOD_END, resumesAt: "2026-12-01T00:00:00.000Z" },
    });
    const resuming = SubscriptionStanding.parse({
      status: "paused",
      currency: "usd",
      currentPeriodEndsAt: null,
      nextBilledAt: null,
      scheduledChange: { action: "resume", effectiveAt: "2026-12-01T00:00:00.000Z", resumesAt: null },
    });
    expect(nextSubscriptionEvent(paused).kind).toBe("pauses");
    expect(nextSubscriptionEvent(resuming).kind).toBe("resumes");
  });

  test("the scheduled change outranks a renewal date that is still set", () => {
    // Paddle happens to blank `next_billed_at` when a cancel is scheduled, so the recorded case above
    // cannot tell which field is read first. Not every store will, and a fifth rail that leaves the
    // date in place would turn "ends 15 Sep" into "renews 15 Sep" — the same date, the opposite
    // promise, and a customer who canceled being told they will be billed again.
    const ending = SubscriptionStanding.parse({
      status: "active",
      currency: "usd",
      currentPeriodEndsAt: PERIOD_END,
      nextBilledAt: PERIOD_END,
      scheduledChange: { action: "cancel", effectiveAt: PERIOD_END, resumesAt: null },
    });
    expect(nextSubscriptionEvent(ending).kind).toBe("ends");
  });

  test("nothing scheduled and nothing billed next is unknown, never a silent renewal", () => {
    const lapsed = SubscriptionStanding.parse({
      status: "expired",
      currency: "usd",
      currentPeriodEndsAt: PERIOD_END,
      nextBilledAt: null,
      scheduledChange: null,
    });
    expect(nextSubscriptionEvent(lapsed)).toEqual({ kind: "unknown", at: null });
  });

  test("a trialing or paused subscription may have no current period, and still reads", () => {
    const trialing = SubscriptionStanding.parse({
      status: "active",
      currency: null,
      currentPeriodEndsAt: null,
      nextBilledAt: PERIOD_END,
      scheduledChange: null,
    });
    expect(trialing.currentPeriodEndsAt).toBeNull();
    expect(trialing.currency).toBeNull();
    expect(nextSubscriptionEvent(trialing).kind).toBe("renews");
  });

  test("the status is the package's normalized set, never Paddle's", () => {
    for (const bad of ["past_due", "trialing", "canceling", "ACTIVE"]) {
      expect(() =>
        SubscriptionStanding.parse({
          status: bad,
          currency: "usd",
          currentPeriodEndsAt: null,
          nextBilledAt: null,
          scheduledChange: null,
        }),
      ).toThrow();
    }
  });

  test("every field is stated — an omitted nextBilledAt is not the same claim as a null one", () => {
    // Null means the provider said there is no next bill. Absent means nobody looked. The second is
    // not a standing, so it does not parse into one.
    expect(() =>
      SubscriptionStanding.parse({
        status: "active",
        currency: "usd",
        currentPeriodEndsAt: null,
        scheduledChange: null,
      }),
    ).toThrow();
  });
});

describe("SubscriptionCancelTiming", () => {
  test("the two timings are the customer's, not Paddle's", () => {
    expect(SubscriptionCancelTiming.options).toEqual(["now", "at_period_end"]);
    expect(SubscriptionCancelTiming.parse("now")).toBe("now");
    expect(SubscriptionCancelTiming.parse("at_period_end")).toBe("at_period_end");
  });

  test("Paddle's own spellings do not parse, so a rail must translate rather than pass through", () => {
    for (const bad of ["immediately", "next_billing_period", "period_end", "end_of_period"]) {
      expect(() => SubscriptionCancelTiming.parse(bad)).toThrow();
    }
  });
});

describe("RefundRequestStatus", () => {
  test("no value in it says the customer has been paid", () => {
    // The whole point of the enum. `approved` is the store's decision, not its settlement, and the
    // settlement arrives as a webhook. A member spelled `refunded` or `paid` would be read as one.
    for (const value of RefundRequestStatus.options) {
      expect(value, `${value} reads as money having moved`).not.toMatch(/refunded|paid|complete|settled/);
    }
    expect(RefundRequestStatus.options).toEqual(["awaiting_review", "approved", "rejected", "reversed", "unknown"]);
  });

  test("`unknown` is a member, so a store saying something new cannot cost an adjustment id", () => {
    // The one place this package reports a value it does not understand. Everywhere else an unmapped
    // value is a shape change worth failing on — a rule that assumes failing costs only the read. Here
    // the read follows a write that cannot be taken back.
    expect(RefundRequestStatus.safeParse("unknown").success).toBe(true);
    // And it is still a closed set: a store's own spelling does not pass through as itself.
    expect(RefundRequestStatus.safeParse("pending_approval").success).toBe(false);
  });
});

describe("RefundRequestOutcome", () => {
  test("a raised refund carries the store's handle and its state, and no amount", () => {
    const raised = RefundRequestOutcome.parse({
      outcome: "requested",
      purchaseId: "11111111-1111-4111-8111-111111111111",
      adjustmentId: "adj_01m02kntv7bhw3sxdy5kyj93a1",
      status: "awaiting_review",
    });
    expect(Object.keys(raised).sort()).toEqual(["adjustmentId", "outcome", "purchaseId", "status"]);
  });

  test("no member carries an amount, in either direction", () => {
    // A figure here would be read as what the customer is getting back, which is the one thing nobody
    // has decided at the moment this is produced.
    for (const member of [
      {
        outcome: "requested",
        purchaseId: "p",
        adjustmentId: "adj_1",
        status: "approved",
        amountMinor: 600,
      },
      { outcome: "failed", purchaseId: "p", reason: "no", amountMinor: 600 },
    ]) {
      const parsed = RefundRequestOutcome.parse(member);
      expect(Object.keys(parsed), JSON.stringify(member)).not.toContain("amountMinor");
    }
  });

  test("a failure carries no adjustment id, and a request carries no reason", () => {
    // The two members say different things and the shapes say so too. A `failed` with an adjustment id
    // would be a refusal that names a refund, which is the sentence nobody can act on.
    const failed = RefundRequestOutcome.parse({ outcome: "failed", purchaseId: "p", reason: "Paddle would not." });
    expect(Object.keys(failed)).not.toContain("adjustmentId");
    const raised = RefundRequestOutcome.parse({
      outcome: "requested",
      purchaseId: "p",
      adjustmentId: "adj_1",
      status: "approved",
    });
    expect(Object.keys(raised)).not.toContain("reason");
  });

  test("`already_requested` is its own member, not a flag on a raised one", () => {
    // "This call did it" and "it was already done" are different answers to *who acted*, and a boolean
    // beside an outcome is exactly what a discriminated union exists to stop being ignored.
    const already = RefundRequestOutcome.parse({
      outcome: "already_requested",
      purchaseId: "p",
      adjustmentId: "adj_1",
      status: "awaiting_review",
    });
    expect(already.outcome).toBe("already_requested");
    expect(Object.keys(already)).not.toContain("raised");
  });

  test("an outcome this build does not know does not parse", () => {
    expect(RefundRequestOutcome.safeParse({ outcome: "refunded", purchaseId: "p" }).success).toBe(false);
  });

  test("an outcome with no payment attached does not parse", () => {
    // Every entry names the payment it is about, because a report that could hold an anonymous entry is
    // a report a reader cannot reconcile against their own payment list.
    expect(
      RefundRequestOutcome.safeParse({ outcome: "requested", adjustmentId: "adj_1", status: "approved" }).success,
    ).toBe(false);
  });
});

describe("RefundRequest", () => {
  test("holds one outcome per payment, mixed outcomes included", () => {
    // The recorded shape of a partial: one raised, one already standing, one refused. All three in one
    // answer, because the alternative is an error that hides the refund already in flight.
    const report = RefundRequest.parse({
      outcomes: [
        { outcome: "requested", purchaseId: "a", adjustmentId: "adj_a", status: "awaiting_review" },
        { outcome: "already_requested", purchaseId: "b", adjustmentId: "adj_b", status: "approved" },
        { outcome: "failed", purchaseId: "c", reason: "Paddle would not." },
      ],
    });
    expect(report.outcomes).toHaveLength(3);
    expect(report.outcomes.map((outcome) => outcome.outcome)).toEqual(["requested", "already_requested", "failed"]);
  });

  test("nothing in a report claims money moved", () => {
    // Read as a whole rather than field by field, because the defect this guards is a word appearing in
    // a shape nobody thought to check.
    const report = RefundRequest.parse({
      outcomes: [{ outcome: "requested", purchaseId: "a", adjustmentId: "adj_a", status: "approved" }],
    });
    expect(JSON.stringify(report)).not.toMatch(/refunded|paid|settled/);
  });
});

describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("every schema in this module documents itself and every field", () => {
    // The package-wide sweep in `schema-descriptions.test.ts` covers this too. It is repeated here
    // because a module is added long before anyone runs the whole package, and a describe() left off
    // at authoring time is cheapest to find at authoring time.
    let fields = 0;
    for (const [name, schema] of Object.entries({
      DeferredSubscriptionSettlement,
      QuotedMoney,
      RefundRequest,
      RefundRequestOutcome,
      RefundRequestStatus,
      ScheduledSubscriptionChange,
      SubscriptionCancelTiming,
      SubscriptionChangeQuote,
      SubscriptionSettlement,
      SubscriptionStanding,
    })) {
      const walk = undescribed(schema, name);
      expect(walk.missing, walk.missing.join("\n")).toEqual([]);
      fields += walk.fields;
    }
    // A walk that looked at nothing and a walk that found nothing are the same green run otherwise.
    expect(fields).toBeGreaterThanOrEqual(20);
  });
});
