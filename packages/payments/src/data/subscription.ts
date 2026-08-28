// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PurchaseStatus } from "./status";

/**
 * A subscription's standing, what changing it costs, and what asking for the money back produces — the
 * shapes a screen renders on either side of the button the customer presses.
 *
 * **Every shape here was rewritten against real Paddle sandbox responses on 2026-08-28 (#465), and the
 * specification it replaced was written from the documentation.** That distinction is the whole value of
 * this module, so the four things the recordings refuted are stated at the fields they shaped rather
 * than left as a changelog nobody reads:
 *
 * - **Money is signed.** `update_summary.credit.amount` came back `"-380"` on an upgrade and `"-6961"`
 *   on a downgrade, and a downgrade's `subtotal`, `tax` and `total` are all negative. The first design
 *   put `.nonnegative()` on quote money, which throws on every real change a customer makes — a
 *   validation error in front of somebody trying to give us more money. See {@link QuotedMoney}.
 * - **`grand_total` lies.** On the recorded downgrade it is `"0"` while the customer is owed 6581,
 *   which sits in `credit_to_balance`. A quote built from the totals renders "nothing happens today"
 *   and the customer's next statement disagrees. So the renderable figure is `update_summary.result` —
 *   a direction and a magnitude — and it is the only amount this module lets a screen reach.
 *   See {@link SubscriptionSettlement}.
 * - **`update_summary.result` says *what*, and never *when*.** This is the correction of 2026-08-28
 *   (second pass), and it cost the quote a whole third part. A downgrade ships under
 *   `prorated_next_billing_period`, and the recording of that mode answers `immediate_transaction:
 *   null` *and* `result: { action: "credit", amount: "6558" }` at the same time. Read `result` as the
 *   headline and the screen says the customer was credited today, which is money they will look for
 *   and not find; read the absent immediate transaction as the whole answer and the 6558 disappears
 *   from the quote entirely. Both are wrong, and neither is a rounding matter. **What lands is
 *   `result`; when it lands is whether there is an immediate transaction at all.** See
 *   {@link SubscriptionChangeQuote}.
 * - **`next_billed_at` goes null while the status stays `active`.** Scheduling a cancellation blanks it
 *   and leaves `canceled_at: null`, so a subscription that ends in eighteen days is indistinguishable
 *   from one that renews in eighteen days if you read the status. See {@link SubscriptionStanding} and
 *   {@link nextSubscriptionEvent}.
 * - **Nothing settling today is a real outcome.** Under `prorated_next_billing_period` — the mode the
 *   downgrade policy uses — `immediate_transaction` comes back null (recorded, not just documented). A
 *   quote that could not say so would have to invent a zero charge, and "You will be charged $0.00 now"
 *   describes something that is not happening.
 *
 * ## This module computes nothing
 *
 * Exactly as `data/discount.ts` states for discounts: the provider is the authority on what is owed. No
 * amount here is derived from another amount, no date from a duration, and nothing sums the totals to
 * check the provider's arithmetic. A second answer to "what will this cost" is a second number for a
 * customer to hold against their statement, and the one they will believe is the statement.
 *
 * ## What is deliberately absent
 *
 * **A proration mode, and any other billing enum.** The settled policy (2026-08-28) is that the rail
 * picks the mode from the *direction* of the change — an upgrade prorates immediately and charges now, a
 * downgrade prorates into the next billing period — and `on_payment_failure` is always `prevent_change`.
 * Nothing a caller sends chooses either. Modeling the mode here would make it a field, a field is a
 * thing a client can set, and the value a client would eventually set is Paddle's `do_not_bill`: a free
 * upgrade. It is unreachable because there is nowhere to write it.
 *
 * **A price id, and the items of a change.** Paddle's `scheduled_change` carries an `items` array and
 * this module drops it. These shapes are rail-neutral by construction — they sit in `data/`, below the
 * rails, and are what a screen renders whichever store is behind them — and a `pri_…` is Paddle's
 * vocabulary. What the subscription is *for* is the catalog's answer, read beside a standing rather than
 * carried inside one.
 */

/**
 * A currency, as this package stores it: lowercase ISO 4217.
 *
 * **Lowercase is not cosmetic and Paddle does not send it.** Paddle states `"USD"`; `currencyOf` in
 * `rails/paddle/objects.ts` is what lowers it, and `pithy_payments_purchases` holds the lowered form. A
 * quote that carried `"USD"` would compare unequal to the purchase rows for the same money and would
 * sort into a second bucket in any report that groups by currency — a drift that is invisible until a
 * total is wrong. Refused here rather than lowered here, because silently accepting both spellings is
 * how the rail stops translating.
 */
const Currency = z
  .string()
  .regex(/^[a-z]{3}$/, "An ISO 4217 currency code is three lowercase letters.")
  .describe(
    "The ISO 4217 currency, lowercase — the spelling this package stores. A rail lowers the provider's own casing before it gets here.",
  );

/**
 * An amount of money a provider quoted: an integer in the currency's minor unit, and the currency.
 *
 * **The amount is signed, and that is the correction.** Paddle sends amounts as strings in the lowest
 * denomination and it sends negative ones freely — `"-380"` for the credit half of an upgrade, `"-6045"`
 * for a downgrade's subtotal. A `.nonnegative()` here refuses the recorded response of every plan change
 * this package exists to make. Parsing the string is `minorAmount`'s job in the Paddle rail, which
 * already answers `null` rather than a guess for anything that is not a plain integer string; this
 * schema is the other end of that, and refuses the `null`.
 *
 * **A fraction is refused.** `65.82` is what somebody reaches for having read "$65.82" on the screen the
 * quote produced. The wire says `"6582"` and means 6582, and a float here would be a rounding error
 * arriving later, in a currency whose minor unit is not a hundredth. `data/money.ts` holds which
 * currencies those are; nothing in this module needs to know, because nothing here scales.
 *
 * **`rendered` is the sentence, and it never replaces the number** (#465, 2026-08-28). The shape shipped
 * with minor units alone, and nothing downstream could turn 6582 into `$65.82`: five of six planned screens
 * could not state the figure the customer was being asked to confirm, and the adopter dashboard refuses a
 * bare digit string outright rather than render minor units as a price. So the string sits *beside* the
 * integer — a consumer comparing amounts still reads `amountMinor`, and a consumer showing one reads
 * `rendered`. `data/renderMoney.ts` holds how, and holds the measurement that corrected the rule against it.
 */
export const QuotedMoney = z
  .object({
    amountMinor: z
      .number()
      .int()
      .describe(
        "How much, as an integer in the currency's minor unit. **Signed** — a credit and a refund are negative on the wire, and refusing that refuses every downgrade. Never a float: 6582 is $65.82, and 65.82 is a bug.",
      ),
    currency: Currency.describe("The currency the amount is in, lowercase."),
    rendered: z
      .string()
      .min(1)
      .describe(
        "The same amount as a reader sees it — `$65.82` for an English reader, `65,82 US$` for a Spanish one, `¥6,582` where the currency has no subunit. Presentation of `amountMinor` and never a second answer to it: the provider's integer decides how much, and `Intl` decides only how it is spelled.",
      ),
  })
  .describe(
    "An amount a provider quoted: minor units for comparing, one currency, and the figure rendered for the reader it is being shown to. Signed, because the provider's own numbers are.",
  );
export type QuotedMoney = z.output<typeof QuotedMoney>;

/**
 * The three members, declared once because two unions below are built from them.
 *
 * **Sharing them is not tidiness.** {@link SubscriptionSettlement} and
 * {@link DeferredSubscriptionSettlement} differ by exactly one member, and two hand-written lists that
 * differ by one member are two lists that will differ by two the next time somebody adds an outcome —
 * with the newer one reachable today and unreachable on a customer's next invoice.
 */
const SettlesByCharge = z
  .object({
    outcome: z.literal("charge").describe("The customer is billed."),
    amount: QuotedMoney.describe("How much is taken, as a positive magnitude. The direction is `outcome`."),
  })
  .describe("Money leaves the customer — the upgrade case, prorated immediately.");

const SettlesByCredit = z
  .object({
    outcome: z.literal("credit").describe("The customer is owed, and it lands as credit rather than as cash."),
    amount: QuotedMoney.describe(
      "How much the customer is owed, as a positive magnitude. Read with `outcome` — the same number rendered without it is a charge.",
    ),
  })
  .describe(
    'The customer is owed. Recorded as `result.action: "credit"` with the amount in `credit_to_balance`, while `grand_total` says 0.',
  );

const SettlesNothing = z
  .object({
    outcome: z.literal("nothing").describe("Nothing is billed or credited. There is no amount to state."),
  })
  .describe(
    "Nothing settles. What `prorated_next_billing_period` produces today: no immediate transaction, the difference carried to the next invoice.",
  );

/**
 * What settles at one moment — the thing a confirmation screen states, with the day it happens supplied
 * by whichever part of a quote holds it.
 *
 * **A discriminated union rather than an amount with a sign**, because the direction has to be
 * unreadable without being read. `update_summary.result` states `{ action: "credit", amount: "6581" }`:
 * the magnitude is positive and the direction lives in the action. A shape carrying only the number
 * renders a 6581 credit as a 6581 charge, which is the same characters and the opposite meaning, and
 * nothing in a type system would object. Here `amount` cannot be reached without matching `outcome`
 * first.
 *
 * **`nothing` is a member, not a zero.** With `prorated_next_billing_period` there is no immediate
 * transaction at all — recorded null, 2026-08-28 — and the credit lands on the next invoice instead.
 * "Nothing to pay today" and "a charge of zero" are different sentences, and only one of them is true.
 * It carries no amount because there is no amount, and one smuggled in does not survive the parse.
 *
 * **`nothing` says nothing about whether the change is free.** That is the trap this union alone cannot
 * close, and why {@link SubscriptionChangeQuote} has three parts: the recorded deferred downgrade settles
 * `nothing` today *and* owes the customer 6558. Which moment a settlement describes is the field it is
 * read from, never the settlement itself.
 *
 * The alternative that was tried and refuted: reading the immediate transaction's totals. Recorded
 * downgrade, 2026-08-28 — `grand_total: "0"`, `credit_to_balance: "6581"`. The totals are how a screen
 * says nothing happened while 65.81 dollars moved.
 */
export const SubscriptionSettlement = z
  .discriminatedUnion("outcome", [SettlesByCharge, SettlesByCredit, SettlesNothing])
  .describe(
    "What settles at one moment — a charge, a credit, or nothing. The direction is the discriminant so an amount can never be rendered without it.",
  );
export type SubscriptionSettlement = z.output<typeof SubscriptionSettlement>;

/**
 * The same settlement, minus `nothing` — what lands on an invoice that is not today's.
 *
 * **The two members are shared declarations, not a second copy**, so a fourth outcome cannot exist in
 * one union and not the other. What differs is the absence, and the absence is the point.
 *
 * `nothing` is unrepresentable here because the block that holds this is nullable, and null already says
 * it. Two spellings of one fact is how a screen ends up checking the block for presence, finding it, and
 * rendering "$— credit on 15 Sep" — a row about no money, dated. A deferred settlement exists precisely
 * when there is something to defer.
 */
export const DeferredSubscriptionSettlement = z
  .discriminatedUnion("outcome", [SettlesByCharge, SettlesByCredit])
  .describe(
    "What lands on a later invoice: a charge or a credit, never nothing — a null block is how a quote says nothing lands later.",
  );
export type DeferredSubscriptionSettlement = z.output<typeof DeferredSubscriptionSettlement>;

/**
 * What a change costs, as a screen shows it before the customer confirms — the provider's own preview,
 * normalized and nothing more.
 *
 * **Three facts, because a downgrade has three.** They are what happens **today**, what happens on the
 * **next invoice**, and what the subscription pays **from then on**. Collapsing any two is how a customer
 * reads a proration as their new monthly price, or is told about money on a day it does not move.
 *
 * The third part is the correction of 2026-08-28, and the recording that forced it is the downgrade under
 * `prorated_next_billing_period` — **the mode a downgrade ships with**:
 *
 * | Recorded | Value | Part |
 * | --- | --- | --- |
 * | `immediate_transaction` | `null` | `settlesToday: { outcome: "nothing" }` |
 * | `update_summary.result` | `{ action: "credit", amount: "6558" }` | `nextInvoice.settlement` |
 * | `next_billed_at` | `2026-09-15T11:42:21.789736Z` | `nextInvoice.at` |
 * | `recurring_transaction_details.totals.grand_total` | `"653"` | `recurring.amount` |
 *
 * With two parts that response is unwritable. `settlesToday` taken from `result` says "credited today" of
 * a change that takes and gives nothing today; `settlesToday` taken from the missing immediate
 * transaction is honest and drops 65.58 dollars out of the quote. The sentence the customer is owed —
 * *"Nothing today. $65.58 credit on your next invoice, 15 Sep. Then $6.53/month."* — needs all three, and
 * a shape that can hold only two guarantees one of them is a lie or a silence.
 *
 * The upgrade is the other side of the same rule and needs no third part: `immediate_transaction` is
 * present, `result` is a charge of 6582, it settles today, and `nextInvoice` is null.
 *
 * A quote is never stored. It is a provider's answer to "if I did this now", it goes stale the moment
 * the billing period moves, and a persisted one is a price nobody is bound by.
 */
export const SubscriptionChangeQuote = z
  .object({
    settlesToday: SubscriptionSettlement.describe(
      "What is taken or given **today, and only today** — charged, credited, or nothing. `update_summary.result` supplies the direction and the amount; whether there is an `immediate_transaction` at all decides whether it belongs here or on `nextInvoice`. Never from the immediate transaction's own totals, which report a `grand_total` of 0 on a downgrade that owes the customer 6581.",
    ),
    nextInvoice: z
      .object({
        settlement: DeferredSubscriptionSettlement.describe(
          "What lands on that invoice, direction first. The recorded deferred downgrade: a credit of 6558.",
        ),
        at: JsonDate.describe(
          "The day that invoice falls — `next_billed_at`, which is also `next_transaction.billing_period.starts_at`. Required, and deliberately not borrowed from `recurring.startsAt`: that block is nullable, so a screen reaching into it for this date prints an undated credit the first time a change ends the subscription.",
        ),
      })
      .nullable()
      .describe(
        'The part of the change that settles on the **next** invoice rather than now, and the day it does. **Null means nothing from this change lands later** — every immediate proration, which is every upgrade. The amount is `update_summary.result`: what *this change* is worth, which is the only figure the customer is being asked to confirm. It is not `next_transaction.details.totals`, which on the same recording states `total: "-5905"` and `credit_to_balance: "5905"` — the same credit with that invoice\'s own 653 already netted off it. A screen shows the credit and the new monthly rate side by side, so netting 653 into the credit subtracts it twice; and 5905 is a figure only the invoice can explain, arriving on a screen about a plan change. 6558 and 653 are stated separately because they are separate, and nothing here derives either from the other.',
      ),
    recurring: z
      .object({
        amount: QuotedMoney.describe("What each period costs once the change has taken effect, tax included."),
        startsAt: JsonDate.describe(
          "When that amount first bills — the end of the period being prorated. Required alongside the amount: a new price with no date is a bill arriving on a day nobody was told about.",
        ),
      })
      .nullable()
      .describe(
        "What the subscription pays each period afterwards, and from when. **Null means nothing renews after this change** — the subscription is ending — which is a sentence a screen writes. It is not the place to put a figure the provider declined to state; a rail with no recurring answer has a shape change to report, not a null to invent.",
      ),
  })
  .describe(
    "A provider's preview of a subscription change: what settles today, what settles on the next invoice, and what the subscription pays afterwards. Three separate facts, because a deferred downgrade has three. Rendered, confirmed, discarded — never stored.",
  );
export type SubscriptionChangeQuote = z.output<typeof SubscriptionChangeQuote>;

/**
 * What a scheduled change will do. Paddle's three, and the set is closed for the reason every other
 * enum in this package is: an action this build has never seen is a shape change worth failing on, not
 * a value to render as itself.
 */
export const ScheduledSubscriptionChangeAction = z
  .enum(["cancel", "pause", "resume"])
  .describe(
    "What the pending change does when it lands: end the subscription, suspend it, or bring it back. Nothing else is schedulable.",
  );
export type ScheduledSubscriptionChangeAction = z.output<typeof ScheduledSubscriptionChangeAction>;

/**
 * A change the provider will apply later — the thing that makes an `active` subscription's future
 * different from its present.
 *
 * **This is the object that distinguishes "renews on the 15th" from "ends on the 15th",** and after the
 * recordings it is clear nothing else does: with a cancellation scheduled, Paddle reports
 * `status: "active"`, `canceled_at: null` and `next_billed_at: null`. Two of those three say the
 * subscription is fine and the third says nothing at all. Only this object says what is coming.
 *
 * `resumesAt` sits beside `effectiveAt` rather than replacing it because they are different instants on
 * a pause: the pause begins at `effective_at` and the subscription comes back at `resume_at`, and Paddle
 * leaves the second null for an open-ended one. `data/pause.ts` holds the longer argument about that
 * null — on a pause it means *indefinitely*, never *we did not look*.
 */
export const ScheduledSubscriptionChange = z
  .object({
    action: ScheduledSubscriptionChangeAction.describe("What will happen."),
    effectiveAt: JsonDate.describe(
      "When it happens. Required: a pending change with no date is an announcement a screen cannot make, and on a scheduled cancel this date is the one the customer is owed — it is where 'renews on' has to come from once `nextBilledAt` has gone null.",
    ),
    resumesAt: JsonDate.nullable().describe(
      "When a paused subscription comes back, when the provider named a date. Null on a pause means indefinitely; null on a cancel or a resume means the field does not apply. Never computed from a duration — see `data/pause.ts`.",
    ),
  })
  .describe("A change the provider will apply at a stated future moment, on a subscription that is fine until then.");
export type ScheduledSubscriptionChange = z.output<typeof ScheduledSubscriptionChange>;

/**
 * Where a subscription stands — the read that ships beside the writes.
 *
 * A capability that can cancel a subscription and not report the cancellation has shipped the half that
 * creates the support ticket. The two sentences this exists to make writable are "Team, renews 15 Sep"
 * and "Team until 15 Sep, then ends", and until #465 they were the same shape: `status` is `active` in
 * both, `canceled_at` is null in both, and the only difference is the scheduled change. Read the status
 * alone and a customer who canceled is told they will be billed again.
 *
 * **Every field is stated, none is optional.** Null means the provider answered that there is none;
 * absent would mean nobody looked, and the two are not the same claim about somebody's money. So a
 * partial object does not parse into a standing.
 *
 * The money is not here. What the subscription costs is `SubscriptionPricing` in `data/discount.ts`,
 * which already answers it together with any discount and when that discount lapses — and a second
 * price on a second object is two numbers to keep in step. `currency` is here so a screen can format
 * that price without a second lookup, and it is nullable for the same reason it is there: some stores do
 * not state one on the subscription itself, and a whole standing must not fail to load over it.
 */
export const SubscriptionStanding = z
  .object({
    status: PurchaseStatus.describe(
      "The normalized status — this package's vocabulary, never a store's. Paddle's `trialing` and `past_due` are already mapped by the rail. **It does not tell you whether the subscription is ending:** a scheduled cancel leaves it `active`, so read `scheduledChange` too.",
    ),
    currency: Currency.nullable().describe(
      "The currency this subscription bills in, lowercase, or null when the store did not state one. Here to format the price that `SubscriptionPricing` carries, not to carry a price itself.",
    ),
    currentPeriodEndsAt: JsonDate.nullable().describe(
      "When the period already paid for runs out — the day access lapses if nothing renews it. Null while a subscription is trialing or paused, which are the states with no billing period.",
    ),
    nextBilledAt: JsonDate.nullable().describe(
      "When the next charge falls due, or null when none is going to. **Null does not mean canceled and it does not mean broken:** Paddle blanks it the moment a cancellation is scheduled and leaves the status `active`. Recorded 2026-08-28. A screen reads it through `nextSubscriptionEvent` rather than printing it beside the word 'renews'.",
    ),
    scheduledChange: ScheduledSubscriptionChange.nullable().describe(
      "The change waiting to land, or null when nothing is. The only field that distinguishes a subscription that ends this period from one that renews.",
    ),
  })
  .describe(
    "Where a subscription stands, for the person who holds it: its status, its dates, and whatever is scheduled to happen to it.",
  );
export type SubscriptionStanding = z.output<typeof SubscriptionStanding>;

/**
 * The next thing that happens to a subscription, and when — the answer a screen prints beside a date.
 *
 * `at` is null on exactly one kind, so a caller that has narrowed to any other has a date without
 * checking for one.
 */
export type SubscriptionNextEvent =
  | {
      /** What happens next. */
      readonly kind: "renews" | "ends" | "pauses" | "resumes";
      /** When it happens. */
      readonly at: Date;
    }
  | {
      /** Nothing is scheduled and nothing is due. The provider has not said what comes next. */
      readonly kind: "unknown";
      /** There is no date, because there is no event. */
      readonly at: null;
    };

/**
 * Which sentence a scheduled change becomes. `satisfies Record<…>` rather than a `switch`, so a fourth
 * schedulable action does not compile until somebody decides what a screen says about it — a `switch`
 * with no case for it would fall through to "renews", which is the wrong sentence written confidently.
 */
const SCHEDULED_CHANGE_EVENT = {
  cancel: "ends",
  pause: "pauses",
  resume: "resumes",
} as const satisfies Record<ScheduledSubscriptionChangeAction, "ends" | "pauses" | "resumes">;

/**
 * What happens to this subscription next.
 *
 * **The scheduled change wins, and that ordering is the point of the function.** Paddle blanks
 * `next_billed_at` when a cancellation is scheduled, so a screen reading it first would say nothing at
 * all about a subscription that ends in eighteen days; a screen reading the status first would say it
 * renews. The date the customer is owed is `scheduled_change.effective_at`, and it is the only place it
 * exists (recorded 2026-08-28).
 *
 * `unknown` rather than a fallback, for a subscription with nothing scheduled and nothing due. An
 * expired subscription and one whose provider went quiet both land here, and neither of them renews. A
 * screen that prints a date it was not given is how a customer learns a wrong one.
 */
export function nextSubscriptionEvent(standing: SubscriptionStanding): SubscriptionNextEvent {
  const change = standing.scheduledChange;
  if (change !== null) return { kind: SCHEDULED_CHANGE_EVENT[change.action], at: change.effectiveAt };
  if (standing.nextBilledAt !== null) return { kind: "renews", at: standing.nextBilledAt };
  return { kind: "unknown", at: null };
}

/**
 * When a cancellation takes effect, in the customer's terms.
 *
 * **Named for what the customer gets, not for what Paddle calls it.** Paddle's values are `immediately`
 * and `next_billing_period`, and the second is the one an adopter reads too quickly: it does not mean
 * "cancel next month", it means "stop renewing, and keep what has been paid for until it runs out".
 * `at_period_end` says that. The rail translates; a value in Paddle's spelling does not parse here, so a
 * rail that stopped translating fails loudly rather than sending a string Paddle happens to accept.
 *
 * **The settled policy is `at_period_end` for a cancellation and for a downgrade to free** (2026-08-28):
 * the tier holds to the end of the period the customer paid for. `now` exists because support sometimes
 * genuinely has to end a subscription today, and because a policy that cannot be departed from in the
 * one case that needs it gets departed from by a direct provider call nothing audits.
 */
export const SubscriptionCancelTiming = z
  .enum(["now", "at_period_end"])
  .describe(
    "When a cancellation takes effect: `now` ends access immediately, `at_period_end` stops the renewal and lets the paid period run out. The customer's terms — the rail translates them into the store's.",
  );
export type SubscriptionCancelTiming = z.output<typeof SubscriptionCancelTiming>;

/**
 * ## The refund half, and why it is in this module
 *
 * A refund is the money side of a cancellation. It is resolved from the same subscription the four verbs
 * above act on, rendered on the same screen beside a standing, and — the reason it is not a module of its
 * own — it is written *against* the settlement vocabulary declared here. {@link SubscriptionSettlement}
 * says money moved. {@link RefundRequest} says it has not, and may never. Putting the two shapes a screen
 * must never confuse in two files is how one of them gets rendered with the other's sentence.
 *
 * **Nothing here says money moved, and nothing here can be made to.** There is no amount in any of these
 * shapes. That is deliberate: a figure would be read as what the customer is getting back, and at the
 * moment these are produced nobody has decided that yet.
 */

/**
 * Where a refund request stands at the store — and **none of these five values means the customer has
 * their money.**
 *
 * A refund is a request. Paddle holds most live ones at `pending_approval` until a person at Paddle
 * reviews them (sandbox approves on its own, roughly ten minutes later), so the request returning is not
 * the refund happening. Even `approved` is only what the store said at the instant it was asked: money
 * reaching a card is the store's later business, it arrives as an `adjustment.updated` webhook, and the
 * projection is what acts on it. Nothing on this side revokes anything.
 *
 * **`unknown` is here, and it is the one place this package reports a value it does not understand.**
 * Everywhere else — `subscriptionStatus`, `ScheduledSubscriptionChangeAction`, `settlementOf` — a value
 * this build has never seen is a shape change worth failing on. That rule assumes failing costs nothing
 * but the read. Here the read follows a write that cannot be taken back: the adjustment exists, and
 * throwing would discard the only handle anybody has on money already in flight. So an unmapped status is
 * reported as `unknown` rather than as itself — a screen cannot render it as a decision, an operator has
 * the adjustment id, and the fact that the store said something new is visible instead of swallowed.
 */
export const RefundRequestStatus = z
  .enum(["awaiting_review", "approved", "rejected", "reversed", "unknown"])
  .describe(
    "Where a refund request stands at the store. **None of these means the money has moved** — `approved` is the store's decision, not its settlement, and the webhook that reports the settlement is what revokes anything.",
  );
export type RefundRequestStatus = z.output<typeof RefundRequestStatus>;

/**
 * A refund this call raised. The adjustment exists at the store and is awaiting whatever the store does
 * next.
 */
const RefundRaised = z
  .object({
    outcome: z.literal("requested").describe("This call raised the adjustment."),
    purchaseId: z
      .string()
      .min(1)
      .describe("Which payment it is against — the purchase row's own id, never the store's transaction id."),
    adjustmentId: z
      .string()
      .min(1)
      .describe("The store's own id for the request. The only handle an operator has on money in flight."),
    status: RefundRequestStatus.describe("What the store said about it at the moment it was raised."),
  })
  .describe("A refund request this call raised. It is a request: nothing here says the customer has been paid.");

/**
 * A refund that was already standing before this call, so nothing was sent for it.
 *
 * **The no-op, per payment**, and it is the same rule the other four verbs follow: a client that lost a
 * response and sent the same instruction again is not in conflict with anything, and a second delivery of
 * one intent must not become a second refund. Paddle refuses a stacked adjustment anyway — *"You can't
 * create an adjustment for a transaction that has a refund that's pending approval"* — and being told so
 * by the store, mid-set, after other adjustments have already been raised, is the worst place to learn it.
 * So it is decided here, before anything is sent, and reported rather than thrown.
 *
 * Its own member rather than a flag on {@link RefundRaised}, because "this call did it" and "it was
 * already done" are different answers to *who acted*, and a boolean beside an outcome is exactly what a
 * discriminated union exists to stop being ignored.
 */
const RefundAlreadyStanding = z
  .object({
    outcome: z.literal("already_requested").describe("A refund was already standing at the store. Nothing was sent."),
    purchaseId: z.string().min(1).describe("Which payment it is against — the purchase row's own id."),
    adjustmentId: z.string().min(1).describe("The store's id for the refund that was already there."),
    status: RefundRequestStatus.describe("Where that standing refund is — awaiting review, or already approved."),
  })
  .describe(
    "A payment that already had a refund against it. Reported, not refused: it is the state the caller asked for.",
  );

/**
 * A refund the store refused, **after at least one other in the same set had already been raised.**
 *
 * Unreachable before the first write, and that is the whole point of the member. Everything knowable in
 * advance — a transaction the store will not refund, a set too large to send in one request — refuses the
 * request outright and sends nothing. Once an adjustment exists, a throw would tell the caller the refund
 * failed while money is on its way back to them, which is the silent partial this shape exists to make
 * impossible. So after the first write, everything is reported.
 *
 * It carries no store sentence. The reason is written for an operator and rides in the audit trail and in
 * a refusal's `detail`; a customer's screen is told which payment, and that it did not go through.
 */
const RefundNotRaised = z
  .object({
    outcome: z.literal("failed").describe("The store refused this one, after another in the same set was raised."),
    purchaseId: z.string().min(1).describe("Which payment it is against — the purchase row's own id."),
    reason: z
      .string()
      .min(1)
      .describe(
        "Why, in an operator's words. Throw-site context: it belongs in a trail and in a log, never on a wire.",
      ),
  })
  .describe(
    "One payment the store would not refund, in a set where others were. Reported so a partial cannot be silent.",
  );

/** What became of one payment. Three outcomes, and every payment asked about has exactly one. */
export const RefundRequestOutcome = z
  .discriminatedUnion("outcome", [RefundRaised, RefundAlreadyStanding, RefundNotRaised])
  .describe(
    "What became of one payment: a refund was raised, one was already standing, or the store refused it. The discriminant is what stops a report being read as a success.",
  );
export type RefundRequestOutcome = z.output<typeof RefundRequestOutcome>;

/**
 * What came of asking for a subscription's payments back — **one outcome per payment asked about, always.**
 *
 * ## Refunds attach to transactions, so the seam takes a set
 *
 * There is no such thing as refunding a subscription. Every store raises a refund against a *transaction*,
 * and a subscription is a family of them. The case is ordinary rather than exotic: a customer who joined on
 * Solo at 6.00, upgraded to Team on day 10 for a 65.82 proration, and cancels on day 13 has paid twice, and
 * an adopter's refund policy owes them both. One adjustment per transaction, one report covering all of them.
 *
 * ## All-or-nothing before the first write; a complete report after it
 *
 * The obvious ask is all-or-nothing over the whole set, and **it cannot be built**: no store offers a batch
 * adjustment and none offers a delete, so once the first adjustment is at `pending_approval` there is
 * nothing that un-raises it. Pretending otherwise would mean choosing which lie to tell when the third of
 * four fails.
 *
 * So the guarantee is split at the one line that is real — has this call written anything yet:
 *
 * - **Before the first write, all-or-nothing.** Every payment is checked at the store first. Anything that
 *   makes one unrefundable refuses the *whole request*, sends nothing, and throws
 *   `payments/subscription_change_refused`. A set too large to issue inside one request refuses the same
 *   way, for the same reason: a call that runs out of budget half way through is a partial by another name.
 * - **After the first write, nothing throws.** The remaining failures become {@link RefundNotRaised}
 *   entries. The caller is told exactly which payments came back and which did not, because the alternative
 *   — an error over a state where money is already moving — is the silent partial success this whole shape
 *   is designed against.
 *
 * **What makes a partial impossible to miss is that this report is total.** One entry per payment asked
 * about, in a deterministic order, so a caller counting entries and a caller counting payments get the same
 * number. There is no shape of this answer that omits a payment.
 *
 * ## Nothing here revokes anything
 *
 * Not the entitlement, not the purchase row, not a projection. A refund that is approved arrives as a
 * webhook, and `rails/paddle/adjustments.ts` and the projection writer already act on it — they are the
 * only things that do. Revoking on the *request* would take a paying customer's access away over a refund
 * Paddle then rejects, and the customer would have neither the money nor the product.
 */
export const RefundRequest = z
  .object({
    outcomes: z
      .array(RefundRequestOutcome)
      .describe(
        "One entry per payment asked about, in the order asked — never a subset. A report shorter than the set is what a silent partial looks like, so the shape does not permit one.",
      ),
  })
  .describe(
    "What came of asking for a subscription's payments back: one outcome per payment, none of which says the money has moved.",
  );
export type RefundRequest = z.output<typeof RefundRequest>;
