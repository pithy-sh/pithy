// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { PaymentsPurchase } from "../../data/purchase";
import { renderMoney } from "../../data/renderMoney";
import {
  type DeferredSubscriptionSettlement,
  type SubscriptionChangeQuote as Quote,
  type QuotedMoney,
  SubscriptionChangeQuote,
  type SubscriptionRecurringParts,
  type SubscriptionSettlementParts,
  SubscriptionStanding,
} from "../../data/subscription";
import { PaymentsProviderUnavailableError, PaymentsSubscriptionChangeRefusedError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { SubscriptionCancelInput, SubscriptionChangeInput } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";
import {
  currencyOf,
  minorAmount,
  PaddleSubscription,
  PaddleSubscriptionPreview,
  type PaddleTotals,
  type PaddleUpdateSummary,
  subscriptionPendingChange,
  subscriptionStatus,
} from "./objects";

/**
 * Changing a Paddle subscription from the server: read it, quote a move, make one, end it, un-end it.
 *
 * Written against real sandbox responses recorded on 2026-08-28 (#465), not against the documentation.
 * Four of the rules below exist because a recording contradicted a design written from the docs, and each
 * is stated where it is enforced rather than in a changelog.
 *
 * ## The three verbs Paddle needs, one of which this rail had never sent
 *
 * | What | Paddle |
 * | --- | --- |
 * | Read | `GET /subscriptions/{id}` |
 * | Quote a change | `PATCH /subscriptions/{id}/preview` |
 * | Make one, or withdraw a schedule | `PATCH /subscriptions/{id}` |
 * | Cancel | `POST /subscriptions/{id}/cancel` |
 *
 * **Nothing in this rail had ever issued a PATCH.** Every call before #465 was a GET or a POST, and
 * `paddleJson` defaults a request carrying a body to POST — so a preview built the obvious way is sent as
 * `POST /subscriptions/{id}/preview`, which Paddle does not route. The failure arrives as an ordinary 4xx,
 * which this rail maps to `payments/rail_not_configured`, and an operator is sent to check an API key that
 * is perfectly fine. `method` is passed explicitly on every call here for that reason, and the tests assert
 * the verb rather than the outcome.
 *
 * ## What this module will not do
 *
 * **It computes no money.** Every figure in a quote is a string Paddle sent, parsed by {@link minorAmount}
 * and never scaled, summed, or checked. `data/subscription.ts` holds the longer argument; the short one is
 * that a second answer to "what will this cost" is a second number for a customer to hold against their
 * statement, and the statement is the one they will believe.
 *
 * **It does render one, and that is a different verb** (#465, 2026-08-28). Paddle's `subscriptions.preview`
 * returns no formatted total at any depth — `formatted_totals` exists only on the pricing-preview endpoint,
 * "for convenience" — so a quote leaves here as minor units or as nothing a screen can print. Every amount
 * therefore carries `rendered` beside it, placed by `data/renderMoney.ts` in the locale the route resolved.
 * The integer is Paddle's and is untouched; only its spelling is decided here.
 *
 * **It returns nothing projectable.** Every method answers a `SubscriptionStanding` or a
 * `SubscriptionChangeQuote` and never an `UnboundProviderEvent`. The webhook owns `pithy_payments_purchases`;
 * a rail that handed a route an event to write would be a second producer of a row the projection already
 * owns, and the two would race on `providerEventAt` — the exact ordering defect that field exists to prevent.
 *
 * **It reads no client-supplied billing enum, because there is none to read.** The proration mode is chosen
 * from the direction of the change (see {@link prorationModeFor}) and `on_payment_failure` is always
 * `prevent_change`. Paddle's `do_not_bill` is a free upgrade, and it is unreachable here because there is
 * nowhere for a caller to write it.
 */

/** What every call here needs: the credentials, which Paddle account, and the transport. */
export interface PaddleSubscriptionOptions {
  /** The rail's credentials. The API key is read at the point of need and never cached. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to reach. */
  environment: PaddleEnvironment;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/**
 * What happens to a change that cannot be collected: nothing.
 *
 * `prevent_change` is Paddle's own default and it is sent anyway, on every write, so the invariant lives in
 * this file rather than in Paddle's release notes. The alternative values let a subscription move to a plan
 * whose first payment failed, which is an upgrade granted and unpaid — and it is not configurable here for
 * the reason no billing enum is: a parameter is a thing a caller eventually sets.
 */
const ON_PAYMENT_FAILURE = "prevent_change";

/** The two proration behaviors this rail routes between. Never a caller's choice. */
type ProrationMode = "prorated_immediately" | "prorated_next_billing_period";

/**
 * A price as this rail compares two of them: what one unit costs, in what currency, on what cycle.
 *
 * The *list* unit price, deliberately — the same figure on both sides. A subscription carrying a discount
 * still moves up or down by its list price, and comparing a discounted rate against an undiscounted one is
 * how a downgrade reads as an upgrade for as long as the discount runs.
 */
interface PricePoint {
  /** The Paddle price — `pri_…`. */
  priceId: string;
  /** What one unit costs, in the currency's minor unit. */
  amountMinor: number;
  /** The currency, lowercase. Two prices in different currencies are not comparable. */
  currency: string;
  /** The billing cycle as one comparable string — `month:1` — or null when Paddle stated none. */
  cycle: string | null;
}

/** A price's unit cost, as Paddle states one. */
const PaddleUnitPrice = z
  .object({
    amount: z
      .string()
      .describe("What one unit costs, as an integer string in the currency's lowest denomination. Never scaled here."),
    currency_code: z.string().nullish().describe("The currency, uppercase ISO 4217, as Paddle sends it."),
  })
  .loose()
  .describe("What one unit of a price costs. Compared against another price's, and never arithmetic'd.");

/**
 * How often a price bills.
 *
 * Read only to answer one question — whether a change alters the billing frequency — because Paddle permits
 * only immediate proration modes when it does. See {@link prorationModeFor}.
 */
const PaddleBillingCycle = z
  .object({
    interval: z.string().describe("`day`, `week`, `month`, or `year`."),
    frequency: z.number().describe("How many of that interval one billing period spans."),
  })
  .loose()
  .describe("A price's billing period, as the two halves Paddle states it in.");

/**
 * One line on a subscription, as this rail has to be able to reproduce it.
 *
 * Declared here rather than widened onto `PaddleSubscription` in `objects.ts`, whose item shape reads only
 * the price id: four modules already depend on that type, and adding required-feeling fields to it in the
 * commit that adds a subscription rail is how a shape used by the webhook parser changes for a reason the
 * webhook parser has nothing to do with.
 *
 * **`quantity` is `unknown` on purpose.** A typed `z.number()` here would fail the whole item's parse when
 * Paddle sent something else, and the refusal a caller reads would name the item rather than the quantity —
 * where the quantity is precisely the thing this rail refuses to guess. It is checked below, by hand, so the
 * sentence names it.
 */
const PaddleItemLine = z
  .object({
    price: z
      .object({
        id: z.string().min(1).describe("The price this line bills at — `pri_…`."),
        unit_price: PaddleUnitPrice.nullish().describe("What one unit costs. The left-hand side of a direction."),
        billing_cycle: PaddleBillingCycle.nullish().describe("How often it bills, when Paddle stated it."),
      })
      .loose()
      .describe("The price on this line, with the two facts a change needs from it."),
    quantity: z.unknown().describe("How many. Read untyped so an unusable value refuses by name rather than by shape."),
  })
  .loose()
  .describe("One priced line on a subscription — everything needed to send it back unchanged.");

/** A price entity, as `GET /prices/{id}` answers one. */
const PaddlePriceEntity = z
  .object({
    id: z.string().min(1).describe("The price — `pri_…`."),
    unit_price: PaddleUnitPrice.nullish().describe("What one unit costs. The right-hand side of a direction."),
    billing_cycle: PaddleBillingCycle.nullish().describe("How often it bills, when Paddle stated it."),
  })
  .loose()
  .describe("A Paddle price, narrowed to what choosing a proration mode needs of one.");

/**
 * A change preview, plus the one entity field a quote's dates come from.
 *
 * `next_billed_at` is not part of `PaddleSubscriptionPreview` because that shape claims only the three keys
 * the recordings measured. A preview response is a whole subscription entity carrying those three, and the
 * day the deferred credit lands is the entity's own `next_billed_at` — recorded `2026-09-15T11:42:21.789736Z`
 * on the downgrade, and equal there to `next_transaction.billing_period.starts_at`. The entity field is the
 * one read, because the other lives inside a block that is absent whenever nothing is deferred.
 */
const PaddleChangePreview = PaddleSubscriptionPreview.extend({
  next_billed_at: z
    .string()
    .nullish()
    .describe("When the next invoice falls — the day a deferred credit lands, and the day a new rate starts."),
}).describe("Paddle's preview of a subscription change, with the entity date the quote's two moments come from.");

/** A subscription cannot be changed the way it was asked. 409, with the reason in `detail`. */
function refuse(detail: string): never {
  throw new PaymentsSubscriptionChangeRefusedError({ detail });
}

/**
 * Paddle answered something this build cannot read. 503, so the screen says it could not look.
 *
 * Not a refusal: nothing about the subscription is wrong, and telling a customer their plan cannot be
 * changed because a response had an unfamiliar shape would be a true sentence about the wrong thing.
 */
function unreadable(detail: string): never {
  throw new PaymentsProviderUnavailableError({ detail });
}

/** A string worth reading, or null. `""` is not a date and not a currency. */
function orNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}

/**
 * The subscription this purchase names, or null when it names none.
 *
 * Paddle's ids are globally prefixed, so the row's own key says what it is — `refreshPaddlePurchase`'s rule,
 * and for the same reason: a money row's family key is `sub_…`, and falling back to it would act on a
 * subscription from a row that is not one.
 */
function subscriptionIdOf(purchase: PaymentsPurchase): string | null {
  const id = purchase.providerTransactionId;
  return id.startsWith("sub_") ? id : null;
}

/** The subscription, or a refusal. Used by the write verbs, which have nothing to do without it. */
async function loadSubscription(id: string, options: PaddleSubscriptionOptions): Promise<PaddleSubscription> {
  const subscription = await readOne(id, options);
  if (subscription === undefined) {
    refuse(`Paddle has no subscription ${id}, so there is nothing on it to change.`);
  }
  return subscription;
}

/** The subscription, or `undefined` when Paddle has none. */
async function readOne(id: string, options: PaddleSubscriptionOptions): Promise<PaddleSubscription | undefined> {
  const answer = await paddleJson(options.transport ?? paddleHttpFetch, `/subscriptions/${encodeURIComponent(id)}`, {
    what: `subscription ${id}`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    absentOn404: true,
  });
  if (answer === undefined) return undefined;
  const parsed = PaddleSubscription.safeParse(answer.data);
  if (!parsed.success) unreadable(`Paddle answered for subscription ${id} in a shape this build cannot read.`);
  return parsed.data;
}

/**
 * The one line this subscription bills, and the quantity to send back — or a refusal naming what stopped it.
 *
 * **Paddle's update replaces the items array.** An item omitted from the request is removed from the
 * subscription, and a quantity left out of an item Paddle has never seen is a quantity Paddle picks. So both
 * failures are silent writes to somebody's billing: a five-seat subscription rewritten as `quantity: 1` is
 * four seats canceled, and a two-item subscription rewritten as one item is an add-on deleted. Neither is
 * distinguishable afterwards from a change the customer asked for.
 *
 * A 409 is recoverable by a human in a minute. A dropped add-on is discovered on an invoice. So anything
 * this rail cannot reproduce exactly, it refuses.
 */
function currentLine(subscription: PaddleSubscription): { point: PricePoint; quantity: number } {
  const items = subscription.items ?? [];
  if (items.length !== 1) {
    refuse(
      `Paddle subscription ${subscription.id} carries ${items.length} items, and this rail rewrites the whole array on a change. Reproducing anything but a single line would mean guessing which to keep.`,
    );
  }

  const parsed = PaddleItemLine.safeParse(items[0]);
  if (!parsed.success) {
    refuse(
      `Paddle subscription ${subscription.id} carries an item this rail cannot reproduce: ${parsed.error.message}`,
    );
  }
  const line = parsed.data;

  if (typeof line.quantity !== "number" || !Number.isSafeInteger(line.quantity) || line.quantity < 1) {
    refuse(
      `Paddle subscription ${subscription.id} states a quantity of ${JSON.stringify(line.quantity)} on price ${line.price.id}, and a rewritten items array has to carry it back exactly. Guessing one over- or under-charges a real card.`,
    );
  }

  return { point: pricePointOf(line.price.id, line.price, `subscription ${subscription.id}`), quantity: line.quantity };
}

/** A comparable price point, or a refusal — a direction cannot be read from an amount that is not there. */
function pricePointOf(
  priceId: string,
  price: { unit_price?: { amount: string; currency_code?: string | null } | null; billing_cycle?: unknown },
  where: string,
): PricePoint {
  const amountMinor = minorAmount(price.unit_price?.amount);
  const currency = currencyOf(price.unit_price?.currency_code);
  if (amountMinor === null || currency === null) {
    refuse(
      `Paddle states no readable unit price for ${priceId} on ${where}, so this rail cannot tell an upgrade from a downgrade. Charging immediately on a guess takes money a downgrading customer is owed.`,
    );
  }
  const cycle = PaddleBillingCycle.safeParse(price.billing_cycle);
  return {
    priceId,
    amountMinor,
    currency,
    cycle: cycle.success ? `${cycle.data.interval}:${cycle.data.frequency}` : null,
  };
}

/** The price being moved to. Needs `price.read` on the key, which the refusal names. */
async function readTargetPrice(priceId: string, options: PaddleSubscriptionOptions): Promise<PricePoint> {
  const answer = await paddleJson(options.transport ?? paddleHttpFetch, `/prices/${encodeURIComponent(priceId)}`, {
    what: `price ${priceId} (this key needs the price.read permission)`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
  });
  const parsed = PaddlePriceEntity.safeParse(answer?.data);
  if (!parsed.success) unreadable(`Paddle answered for price ${priceId} in a shape this build cannot read.`);
  return pricePointOf(priceId, parsed.data, "the price being moved to");
}

/**
 * Which of Paddle's two behaviors a change routes to. **This chooses a behavior; it does not compute money.**
 *
 * The settled policy (2026-08-28), and the direction is the whole input:
 *
 * - **Up, or sideways at the same price — `prorated_immediately`.** The customer is charged the difference
 *   now, and the recorded upgrade takes 6582 today.
 * - **Down — `prorated_next_billing_period`.** The tier moves now and the credit lands on the next invoice.
 *   The recorded downgrade owes 6558 on 15 September and settles nothing today.
 *
 * **Equal counts as up**, and the boundary is deliberate. A move between two prices of the same size settles
 * nothing either way, and deferring it would leave a plan changed today with a phantom line waiting on an
 * invoice a month out.
 *
 * **A currency mismatch refuses rather than comparing.** 600 EUR against 11000 USD is not a comparison, and
 * the wrong answer either takes money from a downgrading customer today or defers a charge the store
 * expected to collect.
 *
 * **A change of billing frequency is immediate whatever the direction, because Paddle allows nothing else.**
 * Its documentation is explicit that only `prorated_immediately`, `full_immediately` and `do_not_bill` are
 * accepted when the billing cycle changes, so a monthly→annual downgrade sent deferred is a 400 — which this
 * rail maps to `rail_not_configured`, sending an operator to check a key that is fine. `do_not_bill` is a
 * free change and unreachable here, so `prorated_immediately` is the only mode left; the recorded downgrade
 * under it settles `grand_total: "0"` with the whole credit on the customer's balance, which is the honest
 * outcome rather than a surprise charge. It fires only when Paddle stated both cycles: an unstated one is
 * not evidence of a difference.
 */
function prorationModeFor(current: PricePoint, target: PricePoint): ProrationMode {
  if (current.currency !== target.currency) {
    refuse(
      `Paddle prices ${current.priceId} in ${current.currency} and ${target.priceId} in ${target.currency}, and two currencies do not order. This rail picks a proration mode from the direction of the change, and there is no direction to read.`,
    );
  }
  if (current.cycle !== null && target.cycle !== null && current.cycle !== target.cycle) return "prorated_immediately";
  return target.amountMinor >= current.amountMinor ? "prorated_immediately" : "prorated_next_billing_period";
}

/** The body both writes send, and the one the preview sends — identical, as Paddle's own guidance requires. */
function changeBody(priceId: string, quantity: number, mode: ProrationMode): Record<string, unknown> {
  return {
    // The **complete** array. Paddle removes anything omitted, and `currentLine` has already refused any
    // subscription whose lines this rail could not reproduce exactly.
    items: [{ price_id: priceId, quantity }],
    proration_billing_mode: mode,
    on_payment_failure: ON_PAYMENT_FAILURE,
  };
}

/** Where a subscription stands, from an entity Paddle answered with. */
function standingOf(subscription: PaddleSubscription): SubscriptionStanding {
  const pending = subscriptionPendingChange(subscription);
  const currency = subscription.currency_code;
  const parsed = SubscriptionStanding.safeParse({
    status: subscriptionStatus(subscription.status),
    currency: currencyOf(typeof currency === "string" ? currency : null),
    currentPeriodEndsAt: orNull(subscription.current_billing_period?.ends_at),
    nextBilledAt: orNull(subscription.next_billed_at),
    scheduledChange:
      pending === null
        ? null
        : { action: pending.action, effectiveAt: pending.effectiveAt, resumesAt: pending.resumeAt },
  });
  if (!parsed.success) {
    unreadable(
      `Paddle described subscription ${subscription.id} in a way this build cannot state: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * What settles, from Paddle's own reconciliation of the change.
 *
 * `update_summary.result` and nothing else. The alternative — the immediate transaction's totals — is right
 * on an upgrade and silently wrong on a downgrade, where `grand_total` is `"0"` while 6581 sits in
 * `credit_to_balance`: a screen wired to it says "you will be charged $0.00" and never mentions the money.
 *
 * An action this build does not map refuses rather than being rendered as itself, which is `subscriptionStatus`'s
 * rule. A third verb quietly read as a charge is the wrong direction in front of a paying customer.
 *
 * **`DeferredSubscriptionSettlement`, not `SubscriptionSettlement`** — the union without `nothing`. What
 * Paddle summarized is always a charge or a credit; `nothing` is a statement about *today* that this function
 * has no standing to make, and typing it wider let a `nothing` compile into `nextInvoice.settlement`, which
 * is a row about no money, dated. The narrower union is what refused it, at build time (#465).
 *
 * **The whole summary rather than its `result`, since #96.** The reconciliation Paddle performed is three
 * figures and the net is one of them; a function handed only the net cannot report the two it reconciles, and
 * the screen that showed it had a customer asking why $48.83 was neither of the prices in front of them. The
 * halves are read here, beside the net, from the same object — never carried in separately, which is how they
 * would come to describe a different change than the amount they sit under.
 */
function settlementOf(summary: PaddleUpdateSummary, locale: string | undefined): DeferredSubscriptionSettlement {
  const result = summary.result;
  if (result.action !== "charge" && result.action !== "credit") {
    unreadable(
      `Paddle summarized a subscription change as "${result.action}", which is not an outcome this build maps.`,
    );
  }
  const amountMinor = minorAmount(result.amount);
  const currency = currencyOf(result.currency_code);
  if (amountMinor === null || currency === null) {
    unreadable(
      `Paddle summarized a subscription change as ${result.action} of ${JSON.stringify(result.amount)} ${JSON.stringify(result.currency_code)}, which is not an amount this build can state.`,
    );
  }
  return {
    outcome: result.action,
    amount: quotedMoney(amountMinor, currency, locale, result.action),
    madeUpOf: partsOf(summary, locale),
  };
}

/**
 * The charge and the credit the net reconciles, or null when Paddle did not state both in full.
 *
 * **Null is the whole of the failure handling here, and that is deliberate.** Everywhere else in this file an
 * unreadable figure throws, because everywhere else the figure *is* the answer. This one is an explanation of
 * an answer that already parsed: refusing the quote because a supporting number lacked a currency would take a
 * working confirmation screen away over a detail the customer never asked for. `update_summary.credit` arrived
 * as `{ amount: "-6936" }` with no `currency_code` on a real recording, so this is a shape Paddle sends.
 *
 * **No currency is borrowed from the net.** It is the one shortcut available and it renders a guess as a
 * price. A missing half is reported as missing.
 */
function partsOf(summary: PaddleUpdateSummary, locale: string | undefined): SubscriptionSettlementParts | null {
  const charge = quotedOrNull(summary.charge?.amount, summary.charge?.currency_code, locale);
  const credit = quotedOrNull(summary.credit?.amount, summary.credit?.currency_code, locale);
  return charge === null || credit === null ? null : { charge, credit };
}

/**
 * One supporting figure, or null when it is not a stateable amount. **Never throws** — see {@link partsOf}.
 *
 * The amount and the currency arrive separately because the two blocks this reads carry them that way:
 * `update_summary` puts a `currency_code` on each half, and a totals block states one for the whole block.
 * Taking a money object would have made the second call site build one, which is a shape invented to fit a
 * signature rather than to describe anything.
 */
function quotedOrNull(
  amount: string | null | undefined,
  currencyCode: string | null | undefined,
  locale: string | undefined,
): QuotedMoney | null {
  if (amount === null || amount === undefined) return null;
  const amountMinor = minorAmount(amount);
  const currency = currencyOf(currencyCode);
  if (amountMinor === null || currency === null) return null;
  const rendered = renderMoney(amountMinor, currency, locale);
  return rendered === null ? null : { amountMinor, currency, rendered };
}

/**
 * One figure, with the string a screen shows it as.
 *
 * **Rendering is not the same check as parsing, and this is where the second one fails.** `currencyOf`
 * lowercases whatever Paddle sent and answers null only for an empty string, so a store answering
 * `currency_code: "dollars"` reaches here with an amount that parses and a currency nothing can put a
 * symbol on. `renderMoney` answers null for it, and null is refused the way every other unreadable figure
 * in this file is — a shape change reported as one, rather than a `RangeError` out of `Intl` arriving at a
 * customer's confirmation screen as a 500.
 */
function quotedMoney(amountMinor: number, currency: string, locale: string | undefined, what: string): QuotedMoney {
  const rendered = renderMoney(amountMinor, currency, locale);
  if (rendered === null) {
    unreadable(
      `Paddle stated the ${what} of a subscription change in ${JSON.stringify(currency)}, which is not a currency this build can name. The amount parses and cannot be shown to anybody.`,
    );
  }
  return { amountMinor, currency, rendered };
}

/**
 * A quote, from a preview response.
 *
 * **`update_summary.result` says *what* the change is worth; whether an `immediate_transaction` exists says
 * *when* it lands.** That is the rule the recordings established and the one a two-part quote could not hold:
 * the deferred downgrade answers `immediate_transaction: null` *and* `result: { action: "credit", amount:
 * "6558" }` at the same time. Read `result` as today's headline and the screen promises money the customer
 * will look for and not find; read the missing transaction as the whole answer and 65.58 dollars disappear
 * from the quote.
 *
 * A missing summary is a shape change and not a free change, so it throws rather than settling `nothing`.
 * "This costs you nothing" is a sentence that must come from Paddle, never from a field being absent.
 */
function quoteOf(data: unknown, priceId: string, locale: string | undefined): SubscriptionChangeQuote {
  const preview = PaddleChangePreview.safeParse(data);
  if (!preview.success) unreadable(`Paddle previewed a move to ${priceId} in a shape this build cannot read.`);
  const answer = preview.data;
  const summary = answer.update_summary;
  if (summary === null || summary === undefined) {
    unreadable(
      `Paddle previewed a move to ${priceId} with no \`update_summary\`, so what the change costs is unstated. A quote cannot be built from its absence.`,
    );
  }
  const settlement = settlementOf(summary, locale);
  const settlesToday = answer.immediate_transaction !== null && answer.immediate_transaction !== undefined;
  const nextBilledAt = orNull(answer.next_billed_at);

  if (!settlesToday && nextBilledAt === null) {
    unreadable(
      `Paddle previewed a move to ${priceId} that settles nothing today and named no next billing date, so the ${settlement.outcome} of ${settlement.amount.amountMinor} has no day to land on.`,
    );
  }

  const quote: Quote = {
    settlesToday: settlesToday ? settlement : { outcome: "nothing" },
    nextInvoice: settlesToday || nextBilledAt === null ? null : { settlement, at: new Date(nextBilledAt) },
    recurring: recurringOf(answer, nextBilledAt, priceId, locale),
  };
  const parsed = SubscriptionChangeQuote.safeParse(quote);
  if (!parsed.success) {
    unreadable(`Paddle's preview of a move to ${priceId} does not state a quote: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * What the subscription pays each period after the change, or null when nothing renews.
 *
 * **The two nulls this separates are not the same claim, and collapsing them costs one of them.** No next
 * billing date is Paddle saying the subscription is ending — reachable today, because a preview may be asked
 * for on a subscription with a cancellation already scheduled, where `next_billed_at` is blank and the
 * status is still `active` (recorded 2026-08-28). That is a sentence a screen writes, so it is a null. A
 * *stated* renewal date with no readable recurring block is the provider declining to answer, which is a
 * shape change and throws — because the alternative is inventing a figure, and the invented one is zero.
 */
function recurringOf(
  answer: z.output<typeof PaddleChangePreview>,
  nextBilledAt: string | null,
  priceId: string,
  locale: string | undefined,
): Quote["recurring"] {
  if (nextBilledAt === null) return null;

  const totals = answer.recurring_transaction_details?.totals;
  const amountMinor = minorAmount(totals?.grand_total ?? totals?.total);
  const currency = currencyOf(totals?.currency_code);
  if (amountMinor === null || currency === null) {
    unreadable(
      `Paddle previewed a move to ${priceId} renewing on ${nextBilledAt} without saying what it pays then. A rail with no recurring answer has a shape change to report, not a null to invent.`,
    );
  }
  return {
    amount: quotedMoney(amountMinor, currency, locale, "renewal"),
    startsAt: new Date(nextBilledAt),
    madeUpOf: recurringPartsOf(totals, locale),
  };
}

/**
 * The base and the tax the renewal figure is the sum of, or null when Paddle did not state both in full.
 *
 * **Null rather than a throw, for {@link partsOf}'s reason exactly**: the renewal amount has already been
 * read and refused if unreadable, and this explains that amount rather than being it. A preview whose
 * totals block omits `tax` is a screen with one figure instead of three, not a plan change a customer
 * cannot make.
 *
 * **`subtotal` and not `total - tax`.** Paddle states the base, after any discount; deriving it would be
 * this package computing money, and it would be right only for as long as `discount` stays `"0"`.
 */
function recurringPartsOf(
  totals: z.output<typeof PaddleTotals> | null | undefined,
  locale: string | undefined,
): SubscriptionRecurringParts | null {
  const beforeTax = quotedOrNull(totals?.subtotal, totals?.currency_code, locale);
  const tax = quotedOrNull(totals?.tax, totals?.currency_code, locale);
  return beforeTax === null || tax === null ? null : { beforeTax, tax };
}

/**
 * Where this subscription stands now, or `undefined` when Paddle has nothing to say about this purchase.
 *
 * Read live, because the one fact it exists to report is the one a projected row does not carry: with a
 * cancellation scheduled Paddle answers `status: "active"`, `canceled_at: null` and `next_billed_at: null`
 * (recorded 2026-08-28). Two of those say the subscription is fine and the third says nothing, so the end
 * date lives only on `scheduled_change.effective_at` — and a webhook announcing it can be dropped.
 */
export async function readPaddleStanding(
  purchase: PaymentsPurchase,
  options: PaddleSubscriptionOptions,
): Promise<SubscriptionStanding | undefined> {
  const id = subscriptionIdOf(purchase);
  if (id === null) return undefined;
  const subscription = await readOne(id, options);
  return subscription === undefined ? undefined : standingOf(subscription);
}

/**
 * What moving to this price would cost, as Paddle previews it.
 *
 * **A read, so the no-op rule does not apply.** Previewing the plan already held is a question with an honest
 * answer and asking it takes nothing; skipping the call would mean inventing a recurring figure to fill the
 * quote with, which is the one thing this package will not do.
 *
 * The item refusals *do* apply, because the preview body is the update body: a preview built from a rewritten
 * items array quotes a change that is not the one the update would make.
 *
 * A subscription with a change already scheduled is not refused here. Refusing a read on the grounds of state
 * would hide the figures from the screen that has to explain why the move cannot be made yet, and `changePlan`
 * is where the write is stopped.
 *
 * `locale` is the reader the figures are rendered for, and it is a parameter of this method alone: the other
 * four verbs answer a standing, which carries no amount. Absent, the rendering falls back to the kit's own
 * locale rather than failing — see `data/renderMoney.ts`.
 */
export async function previewPaddleChange(
  input: SubscriptionChangeInput,
  options: PaddleSubscriptionOptions,
  locale?: string,
): Promise<SubscriptionChangeQuote> {
  const id = subscriptionIdOf(input.purchase);
  if (id === null) refuse(`Purchase ${input.purchase.id} names no Paddle subscription, so there is nothing to quote.`);

  const subscription = await loadSubscription(id, options);
  const { point, quantity } = currentLine(subscription);
  const target = await readTargetPrice(input.providerProductId, options);
  const mode = prorationModeFor(point, target);

  const answer = await paddleJson(
    options.transport ?? paddleHttpFetch,
    `/subscriptions/${encodeURIComponent(id)}/preview`,
    {
      what: `a preview of subscription ${id} moving to ${input.providerProductId}`,
      apiKey: options.credentials.apiKey,
      environment: options.environment,
      // Explicit, because `paddleJson` would otherwise POST a request carrying a body — and Paddle does not
      // route a POST here. See the module doc.
      method: "PATCH",
      body: changeBody(input.providerProductId, quantity, mode),
    },
  );
  return quoteOf(answer?.data, input.providerProductId, locale);
}

/**
 * Move the subscription to a different plan, and answer where it now stands.
 *
 * The answer is Paddle's, not a prediction: the screen that just wrote renders what the store says rather than
 * what the request asked for, and the recorded responses are why — a cancel leaves `status` at `active`, and
 * an update's response is the only place the resulting standing exists.
 *
 * **The plan already held is a success and writes nothing.** These verbs sit behind a network, callers retry,
 * and a second delivery of the same instruction must not become a second proration. A 409 for the state the
 * caller asked for would also simply be wrong — the subscription is how they wanted it. The subscription is
 * still re-read, because the standing that comes back has to be the store's; the rule is about not *writing*
 * twice, and a read takes and gives nothing.
 *
 * **A subscription with a change already scheduled is refused.** Honoring the move means discarding the
 * pending action, and Paddle's own refusal for it arrives as an ordinary 4xx that this rail maps to
 * `rail_not_configured` — a refusal naming the wrong thing. Withdraw the schedule first; that is what
 * {@link keepPaddleSubscription} is for, and it is a separate act the audit trail records separately.
 */
export async function changePaddlePlan(
  input: SubscriptionChangeInput,
  options: PaddleSubscriptionOptions,
): Promise<SubscriptionStanding> {
  const id = subscriptionIdOf(input.purchase);
  if (id === null) refuse(`Purchase ${input.purchase.id} names no Paddle subscription, so there is nothing to change.`);

  const subscription = await loadSubscription(id, options);
  const { point, quantity } = currentLine(subscription);
  if (point.priceId === input.providerProductId) return standingOf(subscription);

  const pending = subscriptionPendingChange(subscription);
  if (pending !== null) {
    refuse(
      `Paddle subscription ${id} is already scheduled to ${pending.action} on ${pending.effectiveAt ?? "an unstated date"}, and moving it to ${input.providerProductId} would discard that. Withdraw the scheduled change first.`,
    );
  }

  const target = await readTargetPrice(input.providerProductId, options);
  const mode = prorationModeFor(point, target);

  const answer = await paddleJson(options.transport ?? paddleHttpFetch, `/subscriptions/${encodeURIComponent(id)}`, {
    what: `subscription ${id} moving to ${input.providerProductId}`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    method: "PATCH",
    body: changeBody(input.providerProductId, quantity, mode),
  });
  return standingAnswered(answer?.data, id);
}

/**
 * Stop the subscription renewing, and answer where it now stands.
 *
 * `at_period_end` is Paddle's `next_billing_period` and the settled policy: the tier holds until the paid
 * period runs out. `now` is `immediately`, and it exists because support occasionally has to end one today —
 * and because a policy with no legitimate exit gets departed from by a direct provider call nothing audits.
 *
 * **The no-op is per timing, not per verb.** A subscription scheduled to end on the 15th is not a subscription
 * that ended today, so `now` against a scheduled cancel is a real request and reaches Paddle. What is already
 * true is what is skipped: a period-end cancel on one already scheduled, and an immediate cancel on one the
 * store has already ended.
 */
export async function cancelPaddleSubscription(
  input: SubscriptionCancelInput,
  options: PaddleSubscriptionOptions,
): Promise<SubscriptionStanding> {
  const id = subscriptionIdOf(input.purchase);
  if (id === null) refuse(`Purchase ${input.purchase.id} names no Paddle subscription, so there is nothing to cancel.`);

  const subscription = await loadSubscription(id, options);
  const pending = subscriptionPendingChange(subscription);
  const alreadyScheduled = input.timing === "at_period_end" && pending?.action === "cancel";
  const alreadyEnded = input.timing === "now" && subscriptionStatus(subscription.status) === "canceled";
  if (alreadyScheduled || alreadyEnded) return standingOf(subscription);

  const answer = await paddleJson(
    options.transport ?? paddleHttpFetch,
    `/subscriptions/${encodeURIComponent(id)}/cancel`,
    {
      what: `canceling subscription ${id}`,
      apiKey: options.credentials.apiKey,
      environment: options.environment,
      method: "POST",
      body: { effective_from: input.timing === "now" ? "immediately" : "next_billing_period" },
    },
  );
  return standingAnswered(answer?.data, id);
}

/**
 * Withdraw a scheduled cancellation, so the subscription renews after all.
 *
 * **It withdraws a cancellation, and only a cancellation.** Paddle has no verb for that: the update clears
 * `scheduled_change` *wholesale*, and that field also holds a scheduled pause and a scheduled resume. A rail
 * that simply sent the clear would silently un-pause a paused subscription — the customer's account restarts
 * billing, on a request that said nothing about pausing. So the subscription is re-read and anything but a
 * pending `cancel` is refused, with what was actually scheduled named in `detail`.
 *
 * The check cannot move to the route: the route holds a projected row, and the pending action lives only at
 * the store.
 *
 * **Nothing scheduled is the no-op, not a refusal.** The subscription already renews, which is what the caller
 * asked for, and a retry after a successful withdrawal is exactly that request arriving twice.
 */
export async function keepPaddleSubscription(
  purchase: PaymentsPurchase,
  options: PaddleSubscriptionOptions,
): Promise<SubscriptionStanding> {
  const id = subscriptionIdOf(purchase);
  if (id === null) refuse(`Purchase ${purchase.id} names no Paddle subscription, so there is nothing to withdraw.`);

  const subscription = await loadSubscription(id, options);
  const pending = subscriptionPendingChange(subscription);
  if (pending === null) return standingOf(subscription);
  if (pending.action !== "cancel") {
    refuse(
      `Paddle subscription ${id} is scheduled to ${pending.action}, not to cancel. Clearing the schedule is the only withdrawal Paddle offers and it clears the whole field, so honoring this would ${pending.action === "pause" ? "restart billing on a paused account" : "discard a scheduled resume"}.`,
    );
  }

  const answer = await paddleJson(options.transport ?? paddleHttpFetch, `/subscriptions/${encodeURIComponent(id)}`, {
    what: `withdrawing the scheduled cancellation of subscription ${id}`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    method: "PATCH",
    // The whole field, because Paddle offers nothing narrower. What makes that safe is the refusal above.
    body: { scheduled_change: null },
  });
  return standingAnswered(answer?.data, id);
}

/** The standing in a write's own response. Every write answers the entity, so none of them predicts one. */
function standingAnswered(data: unknown, id: string): SubscriptionStanding {
  const parsed = PaddleSubscription.safeParse(data);
  if (!parsed.success) unreadable(`Paddle answered a write to subscription ${id} in a shape this build cannot read.`);
  return standingOf(parsed.data);
}
