// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProductType } from "../config/config";
import { PurchaseEnvironment } from "../data/purchase";
import { PaymentsHostedRail, PaymentsRail } from "../data/rail";
import { PurchaseStatus } from "../data/status";
import { PaymentsSubject } from "../data/subject";
import { RefundRequestStatus, ScheduledSubscriptionChangeAction } from "../data/subscription";

/**
 * What the payments routes return, as Zod objects a client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help — so every client that had only an interface hand-wrote a mirror, and the mirror drifted
 * the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot.
 *
 * **Nothing here is a receipt.** `PaymentsPurchase.payload` is the whole verified provider response,
 * and a bearer artifact; the purchase view is the normalized projection of it, and there is no field
 * that carries the original. The webhook responses are deliberately absent from this file too — they
 * are acknowledgements addressed to Apple, Google and Stripe, not a contract offered to any client.
 *
 * **A client's own views name no subject; the management views name both halves of one.** A player reads
 * its own rows, and who holds them is the answer the request already carried — echoing it back teaches a
 * client that the holder is a value in the protocol, which is the first step towards one sending it. A
 * management client reads everybody's, so every row it sees has to say whose it is, and says it as the
 * pair: nothing keeps an organization id from equalling some user's id, so a view carrying the id alone
 * would render one holder's subscription under the other's name.
 *
 * **A field added here later is `.optional()`, not merely `.nullable()`.** This module is read across a
 * version boundary — a management client validates a response with this schema against a customer's
 * Worker at whatever kit version it is on — so an additive required key fails `safeParse` for everyone
 * below that release and takes the whole pane with it (#450). Absent then means *this Worker cannot
 * say*, which is a different fact from `null`.
 */

/** One entitlement as a client reads it. */
export const PaymentsEntitlementView = z
  .object({
    key: z.string().describe("The entitlement key, as the catalog spells it."),
    granted: z.boolean().describe("Whether it grants right now. Re-checked against `expiresAt` on every read."),
    expiresAt: z.iso.datetime().nullable().describe("When it lapses, ISO-8601; null when it does not."),
  })
  .describe("One entitlement: the key, whether it grants right now, and when it lapses.");
export type PaymentsEntitlementView = z.output<typeof PaymentsEntitlementView>;

/** One purchase as a client may see it — the normalized projection, never the stored provider payload. */
export const PaymentsPurchaseView = z
  .object({
    id: z.string().describe("The purchase's UUID."),
    rail: PaymentsRail.describe("Which store this transaction came from."),
    productId: z.string().describe("The catalog product the verified SKU resolved to."),
    type: PaymentsProductType.describe("What kind of product it is."),
    status: PurchaseStatus.describe("The normalized status. Nothing here is ever a rail-specific state."),
    environment: PurchaseEnvironment.describe(
      "The store environment it happened in. A sandbox purchase never grants in production.",
    ),
    purchasedAt: z.iso.datetime().describe("When the store recorded the purchase, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When the entitlement it bought lapses, ISO-8601; null when none."),
    resumesAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When a paused subscription resumes, ISO-8601, as the store stated it. Null with `status` `paused` is a pause the store put no end on; null with any other status means it is not paused.",
      ),
    outcome: z
      .enum(["created", "updated", "ignored"])
      .describe(
        "What the write actually did. `ignored` is a success — a replay of a receipt already projected, or an event staler than the row it would have overwritten.",
      ),
  })
  .describe("One purchase as the projection left it. Never the receipt, which is a bearer artifact.");
export type PaymentsPurchaseView = z.output<typeof PaymentsPurchaseView>;

/** `POST {base}/purchases`. */
export const PaymentsPurchaseResponse = z
  .object({
    purchase: PaymentsPurchaseView.describe("The purchase as this submission left it."),
    entitlements: z.array(PaymentsEntitlementView).describe("What that purchase grants, resolved now."),
  })
  .describe("A verified purchase and the entitlements it produced.");
export type PaymentsPurchaseResponse = z.output<typeof PaymentsPurchaseResponse>;

/** `GET {base}/entitlements` — always the caller's own. */
export const PaymentsEntitlementsResponse = z
  .object({ entitlements: z.array(PaymentsEntitlementView).describe("The caller's entitlements, resolved now.") })
  .describe("Every entitlement the caller holds.");
export type PaymentsEntitlementsResponse = z.output<typeof PaymentsEntitlementsResponse>;

/** `POST {base}/restore`. */
export const PaymentsRestoreResponse = z
  .object({
    purchases: z.array(PaymentsPurchaseView).describe("Every receipt in the batch, as the projection left it."),
    entitlements: z.array(PaymentsEntitlementView).describe("The caller's entitlements after the restore."),
  })
  .describe("What a Restore Purchases run projected, and what the caller now holds.");
export type PaymentsRestoreResponse = z.output<typeof PaymentsRestoreResponse>;

/**
 * `POST {base}/checkout` — how the browser reaches the store's payment page.
 *
 * A discriminated union rather than `{ url }`, because one rail has no URL to give. Stripe and Lemon
 * Squeezy mint a hosted page and answer with its address; Paddle's overlay and inline modes never leave
 * the adopter's page, so the server answers with the transaction the browser opens with Paddle.js and the
 * publishable token it initializes against. A `url` filled with an empty string would be a field a screen
 * navigates to.
 *
 * **Nothing secret crosses.** The client token is publishable exactly as a Stripe price id is. The API
 * key, the webhook signing secret and the resolved discount id are all server-side and none of them is
 * expressible here.
 */
export const PaymentsCheckoutHandoffResponse = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("redirect").describe("A hosted page the browser is sent to."),
        url: z
          .string()
          .describe("Where to send the browser. The store's own page; it expires on the store's schedule."),
      })
      .describe("A redirect handoff — Stripe's hosted Checkout, Lemon Squeezy's hosted checkout."),
    z
      .object({
        kind: z.literal("paddle").describe("A transaction the browser opens over this page with Paddle.js."),
        transactionId: z.string().describe("The transaction the server created — `txn_…`."),
        clientToken: z.string().describe("Paddle's publishable client token, which is designed to reach a browser."),
        environment: z
          .enum(["sandbox", "production"])
          .describe("Which Paddle environment the token belongs to. `Paddle.Environment.set` takes it verbatim."),
        displayMode: z
          .enum(["overlay", "inline"])
          .describe("Whether the checkout opens over the page or inside a container the screen provides."),
        successUrl: z
          .string()
          .describe(
            "Where a buyer who paid is sent, from `config.paddle.successUrl`. Paddle.js takes it as `settings.successUrl` when the checkout opens, which is why it crosses here rather than staying on the server — and why it comes from config rather than from the request that asked for the checkout.",
          ),
      })
      .describe("A Paddle.js handoff — nothing to navigate to, because the checkout opens in place."),
  ])
  .describe("How the buyer reaches checkout: a page to go to, or a transaction to open in place.");
export type PaymentsCheckoutHandoffResponse = z.output<typeof PaymentsCheckoutHandoffResponse>;

/**
 * `POST {base}/portal` — the caller's own billing portal.
 *
 * `subscriptions` is present only for a store that mints per-subscription deep links, which is Paddle
 * alone. Every URL in this response is a bearer credential for that customer's billing — Paddle's is good
 * for 24 hours — so nothing here is cached, persisted, or logged.
 */
export const PaymentsPortalHandoffResponse = z
  .object({
    url: z.string().describe("The portal's overview page for this customer."),
    subscriptions: z
      .array(
        z
          .object({
            subscriptionId: z.string().describe("The store's own subscription id."),
            cancel: z.string().describe("Where this subscription is canceled."),
            updatePaymentMethod: z.string().describe("Where this subscription's payment method is changed."),
          })
          .describe("One subscription's deep links. Every URL here is a bearer credential for that billing."),
      )
      .optional()
      .describe("Per-subscription deep links, for the store that offers them. Absent on the rails that do not."),
  })
  .describe("Where the caller manages their own billing, and the per-subscription actions the store offers.");
export type PaymentsPortalHandoffResponse = z.output<typeof PaymentsPortalHandoffResponse>;

/**
 * `POST {base}/entitlements/grant` and `POST {base}/entitlements/revoke` — the two control-plane routes.
 *
 * One shape for both, because both are the same act read two ways: the entitlement as it now stands.
 * A revoke returns `granted: false` rather than nothing, so a management client renders the state it
 * produced instead of assuming it.
 */
export const PaymentsEntitlementResponse = z
  .object({ entitlement: PaymentsEntitlementView.describe("The entitlement as the write left it.") })
  .describe("The single entitlement a management client granted or revoked, as it now stands.");
export type PaymentsEntitlementResponse = z.output<typeof PaymentsEntitlementResponse>;

/**
 * What the caller's own subscription pays now, what it becomes, and when.
 *
 * A **bearer** response, not a management one: this is a customer reading their own bill. Dates cross as
 * ISO-8601 strings like everything else here, and every amount is the store's own figure — nothing in this
 * package multiplies a price by a percentage.
 */
export const PaymentsPricingResponse = z
  .object({
    currency: z.string().nullable().describe("The currency both amounts are in, or null."),
    currentAmountMinor: z.number().int().nullable().describe("What the next invoice comes to under any discount."),
    listAmountMinor: z.number().int().nullable().describe("What it comes to once the discount ends."),
    discountCode: z.string().nullable().describe("The code in force, or null at list price."),
    discountEndsAt: z
      .string()
      .nullable()
      .describe(
        "When the rate changes, ISO-8601, or null — which is either no discount or one that runs forever. Read it beside `discountCode` to tell which.",
      ),
  })
  .describe("What this subscriber pays, what they will pay, and when that changes.");
export type PaymentsPricingResponse = z.output<typeof PaymentsPricingResponse>;

/**
 * Who a store prices this caller as — the identity a quote and a charge must both resolve from.
 *
 * **The point of it is agreement, not disclosure.** `POST /payments/checkout` hands this exact value to
 * the rail as the customer being charged, read from the provider-account map keyed on the subject the
 * authenticated caller acts for. A browser quoting a price without it reads an IP-derived estimate and is then charged from a
 * billing address, and the two can differ by up to 15% in the United States alone. So the same row is
 * published here, and the screen asks Paddle about the customer rather than about the network.
 *
 * **An identifier, not a credential.** `ctm_…` names a Paddle customer and authorizes nothing; Paddle's
 * `PricePreview` reads a price with it and the publishable client token, which is the pair Paddle
 * publishes for browsers. The route is `requireAuth()` and answers only about its own caller, so nobody
 * learns anybody else's.
 */
export const PaymentsQuotedFrom = z
  .object({
    rail: z.literal("paddle").describe("Which store holds this identity. Paddle is the rail that quotes in a browser."),
    providerAccountId: z
      .string()
      .min(1)
      .describe("The store's own customer id — `ctm_…`. The same value this caller's checkout is charged against."),
  })
  .describe("Who a store prices this caller as, so a quote and a charge resolve location from one row.");
export type PaymentsQuotedFrom = z.output<typeof PaymentsQuotedFrom>;

/**
 * What `GET /payments/pricing` answers with.
 *
 * Two independent facts about one caller, and each is null on its own terms. `pricing` is null when no
 * rail can price a subscription they hold — including when they hold none. `quotedFrom` is null when no
 * store holds a customer for them yet, which is the ordinary state of somebody who has not bought
 * anything. A caller can have either without the other, which is why they are siblings rather than one
 * nested in the other.
 */
export const PaymentsPricingEnvelope = z
  .object({
    pricing: PaymentsPricingResponse.nullable().describe("What this caller's subscription pays, or null."),
    quotedFrom: PaymentsQuotedFrom.nullable().describe("Who a store prices this caller as, or null."),
  })
  .describe("What this caller pays, and who the store prices them as.");
export type PaymentsPricingEnvelope = z.output<typeof PaymentsPricingEnvelope>;

/**
 * ## The subscription lifecycle responses
 *
 * What `GET {base}/subscription` reads and what the three writes beside it answer with. **Bearer
 * shapes, not management ones**: this is a customer reading and changing their own bill.
 *
 * **These are wire mirrors of `data/subscription.ts`, and the duplication is forced.** Those shapes
 * carry `JsonDate` codecs so the rail hands the rest of the package real `Date`s; this file declares no
 * codec and no transform anywhere, because these describe the JSON a browser receives — parsing one has
 * to hand back exactly what went in. Re-exporting the data shapes here would give a client `Date`
 * objects it cannot have and would make `responses.test.ts`'s equality check unwritable. So `.encode()`
 * is the bridge, and `responses.test.ts` builds every fixture below by encoding a real
 * `SubscriptionStanding` and a real `SubscriptionChangeQuote` and comparing key sets — which is what
 * keeps two objects that must agree from drifting into a date a screen cannot read.
 *
 * **No store identifier crosses.** No `sub_…`, no `ctm_…`, no `txn_…`, and no price id. A customer's
 * screen addresses their subscription by *being that customer*; the route resolves the row. An
 * identifier published here is a field a request grows next, and the request that grows it is the one
 * that names somebody else's subscription.
 *
 * **Required rather than `.optional()`, unlike a field added to a shape that already shipped.** The
 * module note above is about widening a response an older Worker already answers; these arrive with the
 * routes that answer them, so a Worker too old to have the field is a Worker that 404s the route and
 * never returns a body for a client to validate.
 */

/**
 * An amount a provider quoted, on the wire: an integer in the currency's minor unit, and the currency.
 *
 * **Signed, because the provider's own figures are.** A credit comes back negative from Paddle and a
 * downgrade's totals are negative throughout; a `.nonnegative()` here would refuse the recorded response
 * of every plan change these routes exist to make. **And never a float** — 6582 is $65.82, so a `65.82`
 * arriving here is somebody reading a rendered figure back in, in a currency whose minor unit may not be
 * a hundredth.
 *
 * `currency` is a plain string, as it is on {@link PaymentsPricingResponse}, and deliberately not the
 * lowercase-only rule `data/subscription.ts` enforces. That rule is where a rail that stopped lowering
 * its provider's casing fails — at the boundary that reads the store. Re-refusing it here would take a
 * customer's whole subscription pane down over a casing difference, which is the failure mode #450
 * names, arrived at from the other direction.
 *
 * **`rendered` is what a screen puts in front of the customer, and it is why this response is usable at
 * all** (#465). Minor units alone cross as bare digits, and a client cannot scale them without carrying
 * the currency exponents itself — which is the table this Worker already has and the client does not. So
 * the figure is rendered here, in the locale the request resolved, and crosses beside the integer rather
 * than instead of it: a client comparing two amounts still reads `amountMinor`.
 *
 * **`.min(1)` on it, unlike a `.string()` elsewhere in this file.** An empty string is a confirmation
 * screen with a blank where the price goes, and a blank is the one thing worse than a figure in the wrong
 * language.
 */
export const PaymentsQuotedMoney = z
  .object({
    amountMinor: z
      .number()
      .int()
      .describe(
        "How much, as an integer in the currency's minor unit. Signed: a credit is negative on the wire. 6582 is $65.82.",
      ),
    currency: z.string().describe("The ISO currency the amount is in, as this Worker stores it — lowercase."),
    rendered: z
      .string()
      .min(1)
      .describe(
        "The same amount, rendered for the reader this response was built for — `$65.82`, `65,82 US$`, `¥6,582`. What a screen displays; `amountMinor` is what it compares. Never a second answer to how much: the store's integer decides the amount and only its spelling is decided here.",
      ),
  })
  .describe("An amount a store quoted: minor units, one currency, and the figure as this reader reads it.");
export type PaymentsQuotedMoney = z.output<typeof PaymentsQuotedMoney>;

/**
 * The three settlement members, declared once because two unions are built from them — the same sharing
 * `data/subscription.ts` does, for the same reason. Two hand-written lists differing by one member are
 * two lists that will differ by two the next time an outcome is added.
 */
/**
 * The two halves a settled amount reconciles: what the plan being moved to costs for the rest of the period,
 * and what the plan being left gives back over the same unused time.
 *
 * **This exists because the net alone is a figure the customer cannot check.** Recorded 2026-08-31 (#96),
 * previewing Solo → Team mid-period: `charge` 5116, `credit` -233, net 4883. The screen said "$48.83 to pay"
 * beside two prices of $18 and $110, and the only honest reading available to somebody looking at it was
 * that the store had got it wrong.
 *
 * **The credit is negative, and stays negative on the wire.** Flipping the sign here would put the direction
 * in the field name for one half and in the number for the other. It is money coming off; it reads that way.
 *
 * Nothing is derived: `charge + credit` is the store's arithmetic, and the net is stated separately because
 * it is separately stated. A screen that summed these to check would have a second answer to what a change
 * costs, and the one the customer believes is on their statement.
 */
const SettlementParts = z
  .object({
    charge: PaymentsQuotedMoney.describe(
      "What the plan being moved to costs for the remainder of the period already paid for, before the credit comes off.",
    ),
    credit: PaymentsQuotedMoney.describe(
      "What the plan being left is worth back over that same unused time. **Negative** — it is money coming off.",
    ),
  })
  .describe("The charge and the credit a settlement reconciles, both as the store stated them.");

/** Why it is nullable, said once for both members that carry it. */
const MADE_UP_OF =
  "The charge and the credit this amount reconciles, or null when the store did not state both in full. A screen shows the breakdown when there is one; the amount stands on its own when there is not.";

const SettlesByCharge = z
  .object({
    outcome: z.literal("charge").describe("The customer is billed."),
    amount: PaymentsQuotedMoney.describe("How much is taken, as a positive magnitude. The direction is `outcome`."),
    madeUpOf: SettlementParts.nullable().describe(MADE_UP_OF),
  })
  .describe("Money leaves the customer — the upgrade case, prorated immediately.");

const SettlesByCredit = z
  .object({
    outcome: z.literal("credit").describe("The customer is owed, and it lands as credit rather than as cash."),
    amount: PaymentsQuotedMoney.describe(
      "How much the customer is owed, as a positive magnitude. The same number rendered without `outcome` is a charge.",
    ),
    madeUpOf: SettlementParts.nullable().describe(MADE_UP_OF),
  })
  .describe("The customer is owed. It reaches their balance, not their card.");

const SettlesNothing = z
  .object({ outcome: z.literal("nothing").describe("Nothing is billed or credited. There is no amount to state.") })
  .describe("Nothing settles: no transaction at all, with the difference carried to the next invoice.");

/**
 * What settles at one moment — the thing a confirmation screen states.
 *
 * **A discriminated union rather than a signed number**, because the direction must be unreadable
 * without being read: a 6581 credit and a 6581 charge are the same characters and the opposite meaning,
 * and nothing in a type system would object to the swap. Here `amount` cannot be reached without
 * matching `outcome` first.
 *
 * **`nothing` is a member, not a zero**, and it carries no amount — one smuggled in does not survive the
 * parse. "Nothing to pay today" and "a charge of $0.00" are different sentences and only one of them
 * describes what is happening.
 */
export const PaymentsSubscriptionSettlement = z
  .discriminatedUnion("outcome", [SettlesByCharge, SettlesByCredit, SettlesNothing])
  .describe("What settles at one moment — a charge, a credit, or nothing, with the direction as the discriminant.");
export type PaymentsSubscriptionSettlement = z.output<typeof PaymentsSubscriptionSettlement>;

/**
 * The same settlement minus `nothing` — what lands on an invoice that is not today's.
 *
 * The block holding it is nullable, and null already says nothing lands later. Two spellings of one fact
 * is how a screen checks the block for presence, finds it, and renders "$— credit on 15 Sep": a row
 * about no money, dated.
 */
export const PaymentsDeferredSubscriptionSettlement = z
  .discriminatedUnion("outcome", [SettlesByCharge, SettlesByCredit])
  .describe("What lands on a later invoice: a charge or a credit. Never nothing — a null block says that.");
export type PaymentsDeferredSubscriptionSettlement = z.output<typeof PaymentsDeferredSubscriptionSettlement>;

/**
 * What a change costs, as the customer sees it before confirming — the store's own preview, normalized.
 *
 * **Three facts, because a deferred downgrade has three**: what happens today, what happens on the next
 * invoice, and what the subscription pays from then on. The recorded downgrade settles *nothing* today
 * and still owes the customer 6558 — so a shape with two parts is one that either says money moved on a
 * day it did not, or drops 65.58 dollars out of a quote a customer is being asked to agree to.
 *
 * Nothing here is derived from anything else here. The store is the authority on what is owed, and a
 * second answer is a second number for a customer to hold against their statement.
 */
/**
 * What a recurring price is made of: the plan's own rate, and the tax on it.
 *
 * **The plans table said $110 and the quote beside it said $119.76** — both that plan's price, one before
 * tax and one after, with nothing on the page saying so. The store states the split whole (`subtotal`,
 * `tax`), so it crosses to the browser rather than being reconstructed there.
 *
 * The tax *rate* is deliberately absent. A percentage beside two amounts invites a reader to check
 * arithmetic, and one rounding decision separates a rate that reproduces the figure from one that does not.
 */
const RecurringParts = z
  .object({
    beforeTax: PaymentsQuotedMoney.describe(
      "What the plan itself costs each period, before tax and after any discount.",
    ),
    tax: PaymentsQuotedMoney.describe("The tax on that base, as the store assessed it for this customer."),
  })
  .describe("The two figures a recurring price is the sum of, both as the store stated them.");

export const PaymentsSubscriptionQuote = z
  .object({
    settlesToday: PaymentsSubscriptionSettlement.describe(
      "What is taken or given **today, and only today** — charged, credited, or nothing at all.",
    ),
    nextInvoice: z
      .object({
        settlement: PaymentsDeferredSubscriptionSettlement.describe(
          "What lands on that invoice, direction first — the recorded deferred downgrade is a credit of 6558.",
        ),
        at: z.iso.datetime().describe("The day that invoice falls, ISO-8601."),
      })
      .nullable()
      .describe(
        "The part of the change that settles on the **next** invoice rather than now, and the day it does. Null means nothing from this change lands later, which is every immediate proration. The amount is what *this change* is worth, never that invoice's own total with the new rate already netted off it.",
      ),
    recurring: z
      .object({
        amount: PaymentsQuotedMoney.describe("What each period costs once the change has taken effect, tax included."),
        startsAt: z.iso.datetime().describe("When that amount first bills, ISO-8601 — the end of the period prorated."),
        madeUpOf: RecurringParts.nullable().describe(
          "The base and the tax `amount` is the sum of, or null when the store did not state both in full. The same name a settlement uses for the same idea, so a screen has one word for what a figure is made of.",
        ),
      })
      .nullable()
      .describe(
        "What the subscription pays each period afterwards, and from when. Null means nothing renews after this change — the subscription is ending, which is a sentence a screen writes rather than a figure it invents.",
      ),
  })
  .describe(
    "A store's preview of a subscription change: what settles today, what settles on the next invoice, and what it pays afterwards. Rendered, confirmed, discarded — never stored.",
  );
export type PaymentsSubscriptionQuote = z.output<typeof PaymentsSubscriptionQuote>;

/**
 * A change the store will apply later — the object that makes an `active` subscription's future
 * different from its present.
 *
 * **This is what distinguishes "renews on the 15th" from "ends on the 15th".** With a cancellation
 * scheduled, Paddle reports `status: "active"`, no cancellation date, and a blank next billing date: two
 * of those say the subscription is fine and the third says nothing. Only this object says what is
 * coming, which is why it crosses to the customer rather than being read into the status server-side.
 *
 * The action enum is imported from `data/subscription.ts` rather than respelled — it is a closed set
 * with no codec in it, so it crosses this seam intact, and a fourth schedulable action cannot then exist
 * on one side only.
 */
export const PaymentsSubscriptionScheduledChange = z
  .object({
    action: ScheduledSubscriptionChangeAction.describe("What will happen: the subscription ends, pauses, or resumes."),
    effectiveAt: z.iso
      .datetime()
      .describe(
        "When it happens, ISO-8601. On a scheduled cancellation this is the date the customer is owed — it is where 'until' comes from once the next billing date has gone blank.",
      ),
    resumesAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When a paused subscription comes back, ISO-8601, when the store named a day. Null on a pause means indefinitely; null on a cancel or a resume means the field does not apply.",
      ),
  })
  .describe("A change the store will apply at a stated future moment, on a subscription that is fine until then.");
export type PaymentsSubscriptionScheduledChange = z.output<typeof PaymentsSubscriptionScheduledChange>;

/**
 * What happens to this subscription next, and when — the reading of the standing, published rather than
 * left for a screen to derive.
 *
 * **The precedence is the whole point, and it is not obvious**: a scheduled change wins over the next
 * billing date, because Paddle *blanks* that date the moment a cancellation is scheduled. A screen
 * reading the status says the subscription renews; a screen reading the billing date says nothing at
 * all; the date the customer is owed exists only on the scheduled change. Every client would have to
 * rediscover that, and the ones that got it wrong would tell somebody who canceled that they will be
 * billed again.
 *
 * So this is a derived field on purpose, in the register {@link PaymentsAdminEntitlementView}'s
 * `granted` already sets: the rule lives once, on the server, and the answer crosses. It is the answer
 * `nextSubscriptionEvent` gives in `data/subscription.ts`, encoded — a client cannot call that function,
 * because it takes `Date`s and this is JSON.
 *
 * **A union of two members, so `at` is null on exactly one kind.** A caller that has narrowed to any
 * other has a date without checking for one, and `unknown` cannot carry a day a screen would print for
 * an event nobody said was happening.
 */
export const PaymentsSubscriptionNextEvent = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z
          .enum(["renews", "ends", "pauses", "resumes"])
          .describe("What happens next — a renewal falling due, or the scheduled change landing."),
        at: z.iso.datetime().describe("When it happens, ISO-8601."),
      })
      .describe("Something is going to happen, and the store said when."),
    z
      .object({
        kind: z
          .literal("unknown")
          .describe(
            "Nothing is scheduled and nothing is due. An expired subscription and one whose store went quiet both land here, and neither of them renews.",
          ),
        at: z.null().describe("There is no date, because there is no event."),
      })
      .describe("Nothing is known to be coming. A screen says so rather than printing a date it was not given."),
  ])
  .describe("The next thing that happens to this subscription, and when — the scheduled change first.");
export type PaymentsSubscriptionNextEvent = z.output<typeof PaymentsSubscriptionNextEvent>;

/**
 * One subscription as its own holder reads it: which plan, where it stands, and what happens next.
 *
 * The standing's own five fields cross verbatim, and two are added.
 *
 * **`productId`, because a screen has to name the plan.** "Team, renews 15 Sep" is unwritable without
 * it, and it is the one fact here a client cannot already know: the route resolved the subscription from
 * this caller's own purchase rows, so which plan they are on is the server's answer. The display name is
 * not copied beside it — that is the catalog's, read once by whatever screen renders a paywall, and a
 * second copy traveling on every standing is a name that goes stale on the customer's screen the day an
 * adopter renames a product.
 *
 * **`nextEvent`, because the precedence rule must not be client-side.** See
 * {@link PaymentsSubscriptionNextEvent}.
 *
 * **Nothing about money.** What the subscription costs is `GET {base}/pricing`'s answer, which already
 * states the discount in force and when it lapses; a second price here would be two figures to keep in
 * step. `currency` crosses so a screen can format that price without a second lookup, which is exactly
 * why it is on the standing in the first place.
 */
export const PaymentsSubscriptionView = z
  .object({
    productId: z
      .string()
      .describe(
        "The catalog product this subscription is for — the key in `products`, resolved from the caller's own purchase row. What a screen looks a display name up by.",
      ),
    status: PurchaseStatus.describe(
      "The normalized status, never a store's own. **It does not say whether the subscription is ending** — a scheduled cancellation leaves it `active`. Read `nextEvent`.",
    ),
    currency: z
      .string()
      .nullable()
      .describe(
        "The currency this subscription bills in, or null when the store did not state one. Here to format the price `GET {base}/pricing` carries, not to carry a price.",
      ),
    currentPeriodEndsAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the period already paid for runs out, ISO-8601 — the day access lapses if nothing renews it. Null while trialing or paused, which are the states with no billing period.",
      ),
    nextBilledAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the next charge falls due, ISO-8601, or null when none is going to. **Null is not canceled and not broken:** the store blanks it the moment a cancellation is scheduled and leaves the status `active`. Render `nextEvent` instead of putting this beside the word 'renews'.",
      ),
    scheduledChange: PaymentsSubscriptionScheduledChange.nullable().describe(
      "The change waiting to land, or null when nothing is. The only field that separates a subscription ending this period from one renewing.",
    ),
    nextEvent: PaymentsSubscriptionNextEvent.describe(
      "What happens next and when, already resolved — the scheduled change ahead of the billing date. The sentence a screen prints.",
    ),
  })
  .describe("One subscription as the person paying for it reads it: which plan, where it stands, and what is next.");
export type PaymentsSubscriptionView = z.output<typeof PaymentsSubscriptionView>;

/**
 * `GET {base}/subscription` — the caller's own subscription, or that they have none.
 *
 * **The read ships before the writes**, and this is it. A capability that can cancel a subscription and
 * cannot report the cancellation has shipped the half that creates the support ticket; #247 is the
 * larger version of the same mistake, where writes went out with no read beside them and a dashboard's
 * panes dropped out of the rail entirely.
 *
 * `null` is a real answer and a common one: somebody who has never bought anything. It is not an error
 * and not a 404 — a 404 would make this route an existence oracle and would read, to a screen, exactly
 * like a Worker that could not be reached.
 */
export const PaymentsSubscriptionResponse = z
  .object({
    subscription: PaymentsSubscriptionView.nullable().describe(
      "The caller's own subscription, or null when they hold none.",
    ),
  })
  .describe("Where the caller's own subscription stands, or that there is not one.");
export type PaymentsSubscriptionResponse = z.output<typeof PaymentsSubscriptionResponse>;

/**
 * What the three writes answer with — `change`, `cancel` and `keep`.
 *
 * **The store's own answer to where the subscription now stands, not a prediction of it.** The screen
 * that just wrote renders what it wrote, from the state the store reported after applying it. A
 * prediction is how a customer sees a plan they are not on — and it is why nothing in this package
 * writes a purchase row on these routes: the webhook owns that row, and a second producer of it disagrees
 * with the first the moment a webhook is late.
 *
 * **Never null, which is the one way this differs from {@link PaymentsSubscriptionResponse}.** Each of
 * the three resolved a subscription before it ran, so a null here is a case every screen would branch on
 * and none could reach.
 *
 * A no-op answers exactly this shape too, and answers 200: a change to the plan already held, or a
 * cancellation already scheduled for the timing asked for. The subscription is how the caller wanted it,
 * so there is nothing to refuse — and these verbs sit behind a network, where a retried intent must not
 * become a second proration.
 */
export const PaymentsSubscriptionStandingResponse = z
  .object({
    subscription: PaymentsSubscriptionView.describe("Where the subscription stands now, as the store reports it."),
  })
  .describe("Where the caller's subscription stands after a change, a cancellation, or a withdrawal of one.");
export type PaymentsSubscriptionStandingResponse = z.output<typeof PaymentsSubscriptionStandingResponse>;

/**
 * `POST {base}/subscription/preview` — what the change would cost, before anything is committed.
 *
 * The quote alone: it echoes nothing back about what was asked, because the request named the product
 * and the client therefore already holds it. Contrast {@link PaymentsAdminSubjectEntitlementsResponse},
 * which echoes the subject precisely because half of what it renders came from the server.
 */
export const PaymentsSubscriptionQuoteResponse = z
  .object({ quote: PaymentsSubscriptionQuote.describe("What the change would cost, as the store previews it.") })
  .describe("A preview of one subscription change. Nothing has been committed and nothing has been stored.");
export type PaymentsSubscriptionQuoteResponse = z.output<typeof PaymentsSubscriptionQuoteResponse>;

/**
 * ## The refund report
 *
 * What `POST {base}/subscription/refund` answers with. **Nothing in it says the money moved**, because at
 * the moment it is produced nobody has decided that: a refund is a request, most live ones sit at the store
 * awaiting a person, and the settlement arrives later as a webhook.
 *
 * **No amount, anywhere.** A figure here would be read as what the customer is getting back, which is the
 * one thing this response cannot know. What a screen renders is *how many* payments were asked about and
 * where each stands — and the customer's own payment history, which they already have, is where the sums
 * are.
 *
 * **No identifier either — not the store's, and not ours.** No `txn_…` and no adjustment id: the module note
 * above bans store identifiers from every bearer response, and an adjustment id published to a browser is a
 * field a request grows next. The purchase id is withheld on the same principle rather than on a rule, since
 * a screen that has just asked to refund a whole subscription needs a count and a state, not a join key. The
 * ids are in the audit trail, where an operator is the reader.
 */

/** Where one refund request stands. The values come from `data/subscription.ts`, so the wire cannot hold a state the rail cannot produce. */
export const PaymentsRefundRequestStatus = RefundRequestStatus.describe(
  "Where a refund request stands at the store. **None of these means the money has arrived** — `approved` is a decision, not a settlement.",
);
export type PaymentsRefundRequestStatus = z.output<typeof PaymentsRefundRequestStatus>;

/** A refund this request raised: it exists at the store, and it is waiting. */
const RefundRaised = z
  .object({
    outcome: z.literal("requested").describe("A refund was raised for this payment. It is a request, not a payout."),
    status: PaymentsRefundRequestStatus.describe("Where it stands at the store."),
  })
  .describe("A refund request this call raised.");

/** A refund that was already there, so nothing new was asked for. The per-payment no-op. */
const RefundAlreadyStanding = z
  .object({
    outcome: z
      .literal("already_requested")
      .describe("A refund was already standing against this payment, so nothing was sent."),
    status: PaymentsRefundRequestStatus.describe("Where that standing refund is."),
  })
  .describe(
    "A payment that already had a refund against it. Success, not a refusal: it is the state that was asked for.",
  );

/**
 * A payment the store would not refund, in a request where others were.
 *
 * **It carries no reason**, and that is the security boundary rather than an omission. The store's own
 * sentence is throw-site context — it names transactions, statuses and account facts — so it rides in the
 * audit trail and in a refusal's `detail`, both of which the codec keeps off the wire. A screen is told
 * which payments did not go through and asks the customer to get in touch, which is the only action
 * available to them either way.
 */
const RefundNotRaised = z
  .object({
    outcome: z
      .literal("failed")
      .describe("The store would not refund this payment. Others in the same request may have gone through."),
  })
  .describe("One payment that was not refunded, reported so a partial cannot pass as a success.");

/** What became of one payment. Three outcomes, and the discriminant is what stops a report reading as a success. */
export const PaymentsRefundOutcome = z
  .discriminatedUnion("outcome", [RefundRaised, RefundAlreadyStanding, RefundNotRaised])
  .describe("What became of one payment: a refund was raised, one was already standing, or the store refused it.");
export type PaymentsRefundOutcome = z.output<typeof PaymentsRefundOutcome>;

/**
 * What came of asking for a subscription's payments back.
 *
 * **One entry per payment, always** — the report is total over what was asked about, which is what makes a
 * partial impossible to miss. A caller counting entries and a caller counting their own payments get the
 * same number, whatever happened in between.
 *
 * A refund attaches to a *transaction*, and a subscription is a family of them. A customer who joined on one
 * plan, upgraded mid-period and canceled has paid twice; a policy that owes them their money owes both, so
 * this is a list rather than a single outcome even in the common case.
 */
export const PaymentsRefundRequest = z
  .object({
    outcomes: z
      .array(PaymentsRefundOutcome)
      .describe(
        "One entry per payment asked about, in the order the server resolved them — never a subset. A shorter list is what a silent partial looks like.",
      ),
  })
  .describe("What came of a refund request: one outcome per payment, none of which says the money has arrived.");
export type PaymentsRefundRequest = z.output<typeof PaymentsRefundRequest>;

/** The envelope `POST {base}/subscription/refund` answers with. */
export const PaymentsRefundResponse = z
  .object({ refund: PaymentsRefundRequest.describe("What became of each payment on the subscription.") })
  .describe("What a refund request produced. Never a claim that anybody has been paid.");
export type PaymentsRefundResponse = z.output<typeof PaymentsRefundResponse>;

/**
 * The discount codes one store holds.
 *
 * A management shape, never a client one: what an adopter has issued is a commercial fact, and the client
 * projection draws the same line here it draws for SKUs and the `grants` block.
 */
export const PaymentsAdminDiscountsResponse = z
  .object({
    discounts: z
      .array(
        z
          .object({
            code: z.string().min(1).describe("The code a customer enters."),
            providerDiscountId: z.string().min(1).describe("The store's own id, for finding it in the dashboard."),
            amount: z.string().describe("How much comes off, rendered for a person — the store's own figures."),
            redemptions: z
              .number()
              .int()
              .nullable()
              .describe("How many times it has been claimed, when the store says."),
          })
          .describe("One discount code, as the store holds it."),
      )
      .describe("The codes, as the store lists them."),
  })
  .describe("Every discount code one store holds for this project.");
export type PaymentsAdminDiscountsResponse = z.output<typeof PaymentsAdminDiscountsResponse>;

/**
 * A discount as the store minted it.
 *
 * The **code** is the point — an adopter mints one per applicant and has to be told what it is — and the
 * provider id is what finds it in that store's dashboard afterwards. The terms are echoed back as this
 * package models them rather than as the store recorded them, so a client can show what it asked for
 * without learning either provider's vocabulary.
 *
 * Nothing here is a list. A management client learns the code it just created and no other, because the set
 * of codes an adopter has issued is a commercial fact and not one this route publishes.
 */
export const PaymentsDiscountResponse = z
  .object({
    code: z.string().min(1).describe("The code a customer enters, whether supplied or store-generated."),
    providerDiscountId: z.string().min(1).describe("The store's own id, for finding it in the dashboard."),
    rail: PaymentsHostedRail.describe("Which store now holds it."),
  })
  .describe("One discount code, as the store minted it.");
export type PaymentsDiscountResponse = z.output<typeof PaymentsDiscountResponse>;

/**
 * ## The management read surface
 *
 * Everything below answers a **control-plane** route, so it is read by a dashboard across a trust
 * boundary rather than by the adopter's own app. The `Admin` prefix is what keeps the two apart: a
 * client's view of its own purchase and a management client's view of everybody's are different
 * projections with different rules, and one schema doing both would be one edit away from serving the
 * wider shape to the narrower caller.
 *
 * **The provider payload appears nowhere in this file and is not even selected by the queries behind
 * it** — see `admin/read.ts`. That is where an email address would otherwise reach a purchases list,
 * since payments stores no address of its own.
 */

/**
 * One catalog product, as a management client sees it.
 *
 * **Strictly less than the client projection already ships, and the reasoning is that file's.**
 * `clientProjection` argues that a product's Apple and Google SKUs stay server-side because a browser has
 * no use for them, and that the `grants` block stays there because a currency code and an amount describe
 * the economy. A management client needs less again: it is filling a list of *things that can be comped*,
 * and a comp names an entitlement key. So there is no Stripe price id here either — publishable in a
 * paywall, where it is the thing a Checkout Session names, and simply not this surface's business.
 *
 * What `controlPlane.workers.test.ts` asserts is the invariant first: every leaf in the response is one of
 * these four facts about some product. A field added here carrying anything else fails it whatever the
 * field is called, which is the point — a projection somebody must remember not to widen is not a control.
 * Beside it sits a hand-written list of the seven keys that may cross, because the value half alone cannot
 * police a boolean or a null: `true` and `null` are in every JSON document's vocabulary. That list is
 * deliberately **not** read off this schema. It was, and a field added here and to the view together
 * widened the gate by the same edit (#308).
 */
export const PaymentsAdminCatalogProduct = z
  .object({
    id: z.string().describe("The logical product id — the key in `products`, and what lands in every purchase row."),
    type: PaymentsProductType.describe("What kind of product it is. Decides how a renewal and a restore behave."),
    name: z.string().describe("The display name the adopter wrote — `Pro`, `Remove ads`. What a list renders."),
    entitlements: z
      .array(z.string())
      .describe(
        "The entitlement keys this product grants. The whole reason this read exists: a comp names a key, so this is the list a grant control offers instead of a text box.",
      ),
  })
  .describe("One catalog product as a management client sees it: what it is, and what it grants.");
export type PaymentsAdminCatalogProduct = z.output<typeof PaymentsAdminCatalogProduct>;

/**
 * `GET {base}/admin/catalog` — what this project sells.
 *
 * **`enabled` is the same modeled answer `clientProjection` gives, and deliberately the same shape.** A
 * catalog with nothing in it answers `{ enabled: false }` rather than an empty list, so "composed with
 * nothing to sell" is a state a client renders as *there is nothing to comp here* instead of as a dropdown
 * that came back broken. A catalog that failed to load is not this: it is a non-200, or a body that does
 * not parse, and a client that branches on `enabled` never confuses the two.
 *
 * A discriminated union rather than an optional `products`, because the two states are genuinely different
 * answers and an optional array makes "empty" and "absent" indistinguishable at the exact moment a caller
 * needs them apart.
 */
export const PaymentsAdminCatalogResponse = z
  .discriminatedUnion("enabled", [
    z
      .object({
        enabled: z
          .literal(false)
          .describe(
            "This project defines nothing — no product is configured and no key was declared grantable, so there is no entitlement a comp control could offer and no grant that would succeed.",
          ),
      })
      .describe("A project composing payments with an empty catalog. The same answer as not composing it at all."),
    z
      .object({
        enabled: z.literal(true).describe("This project sells something."),
        products: z
          .array(PaymentsAdminCatalogProduct)
          .describe("The catalog, in the order the adopter wrote it — which is the order a list should show."),
        manualEntitlements: z
          .array(z.string())
          .describe(
            "Entitlement keys the adopter declared grantable with no product behind them. Offered beside the products because a comp control that omitted them would refuse the grants it then submitted.",
          ),
      })
      .describe("The catalog, as a management client reads it."),
  ])
  .describe("What this project sells, or that it sells nothing. Never a price, a SKU, or a rail's identifier.");
export type PaymentsAdminCatalogResponse = z.output<typeof PaymentsAdminCatalogResponse>;

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/**
 * One purchase, as a management client sees it.
 *
 * Wider than {@link PaymentsPurchaseView} in the two ways an operator needs and a buyer does not: it
 * names the **owner** — as the pair, always — and it names the **money**. Narrower in one: there is no `outcome`, because
 * `outcome` says what a *write* did — projected, replayed, ignored — and a read of the log has no write
 * to report.
 *
 * The provider identifiers are kept and the provider *payload* is not, and the line between them is
 * whether the value is a bearer artifact. A transaction id is the join key an operator pastes into App
 * Store Connect or the Stripe dashboard to settle a dispute; a receipt is the thing that could be
 * replayed. The first is the whole point of the pane and the second never leaves the Worker.
 */
export const PaymentsAdminPurchaseView = z
  .object({
    id: z.string().describe("The purchase's UUID — its stable identifier on this Worker."),
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Whether `subjectId` names a user or an organization. Half the owner: read the two together or a row is attributed to whoever else holds that id.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject that bought it — the opaque id the adopter's auth capability issued, or the one its own membership model did. The only identity payments stores, and the join key to `auth:users:read`, which is granted separately.",
    ),
    rail: PaymentsRail.describe("Which store this transaction came from."),
    providerTransactionId: z
      .string()
      .describe(
        "The store's own transaction id — what an operator pastes into App Store Connect, Play Console or the Stripe dashboard. An identifier, never a credential: the receipt that would be one is not projected.",
      ),
    originalTransactionId: z
      .string()
      .nullable()
      .describe(
        "The transaction that started this subscription, chaining renewals back to it. Null for a one-time purchase.",
      ),
    productId: z
      .string()
      .describe(
        "The catalog product the verified SKU resolved to, copied at projection time so a later config edit cannot rewrite history.",
      ),
    type: PaymentsProductType.describe("What kind of product it is."),
    status: PurchaseStatus.describe("The normalized status. Nothing here is ever a rail-specific state."),
    environment: PurchaseEnvironment.describe(
      "The store environment it happened in. Rendered rather than filtered on by default: a sandbox transaction read as a production one is the oldest defect in in-app purchasing.",
    ),
    amountMinor: z
      .number()
      .int()
      .nullable()
      .describe(
        "What was charged, in the currency's minor unit — an integer, never a float. Null where the rail reported no amount, which is common on a renewal.",
      ),
    currency: z.string().nullable().describe("The ISO currency the amount is in, or null when none was reported."),
    purchasedAt: z.iso.datetime().describe("When the store recorded the purchase, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When access lapses, ISO-8601; null for one that never does."),
    revokedAt: z.iso.datetime().nullable().describe("When it was refunded or revoked, ISO-8601; null when it was not."),
    resumesAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When a paused subscription resumes, ISO-8601, as the store stated it — never computed here. Null with `status` `paused` is an indefinite pause; null with any other status means it is not paused. A store that never dates a pause says so in the kit's `PAYMENTS_PAUSE_RESUMPTION` table rather than by leaving this ambiguous.",
      ),
    updatedAt: z.iso
      .datetime()
      .describe("When this row was last projected, ISO-8601 — how an operator tells a live row from a stale one."),
  })
  .describe("One purchase as a management client sees it. Never the stored provider payload.");
export type PaymentsAdminPurchaseView = z.output<typeof PaymentsAdminPurchaseView>;

/**
 * One entitlement, as a management client sees it.
 *
 * Wider than {@link PaymentsEntitlementView} by the two facts a buyer has no use for and an operator
 * cannot work without: **whose** it is, and **why** they have it. `manual` is the difference between an
 * entitlement somebody paid for and one somebody decided; `source` is the purchase currently granting
 * it, which answers "why is this subject entitled" without a scan.
 *
 * Whose it is crosses as the pair the row is keyed on, `UNIQUE (subjectType, subjectId, entitlement)`. A
 * dashboard that read only the id would show an organization's `pro` beside a person's name the moment
 * an adopter's two id spaces met on a value.
 */
export const PaymentsAdminEntitlementView = z
  .object({
    subjectType: PaymentsSubject.shape.subjectType.describe("Whether `subjectId` names a user or an organization."),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject holding it — the opaque id the adopter's auth capability issued, or its own organization id.",
    ),
    key: z.string().describe("The entitlement key the adopter's gating code names — `pro`, `beta`."),
    granted: z
      .boolean()
      .describe(
        "Whether it grants access right now, resolved against `expiresAt` on this read exactly as the hot path resolves it. The stored flag is an optimization; this is the answer.",
      ),
    expiresAt: z.iso.datetime().nullable().describe("When it lapses, ISO-8601; null for one that does not."),
    manual: z
      .boolean()
      .describe(
        "Whether a human wrote this row through the control plane rather than a purchase producing it. A manual grant is held against the projection, so it survives the subject's next renewal.",
      ),
    source: z
      .string()
      .nullable()
      .describe(
        "The purchase currently granting this entitlement, or null when nothing does — a comp, or a grant whose purchase has lapsed.",
      ),
  })
  .describe("One entitlement as a management client sees it: whose it is, whether it grants, and why.");
export type PaymentsAdminEntitlementView = z.output<typeof PaymentsAdminEntitlementView>;

/**
 * One reconciliation pass, as a management client sees it.
 *
 * **The positive invariant this response is held to: every field is a count, a timestamp, an enum, or this
 * run's own id.** Not "no payload field" — a list of forbidden names is a list somebody has to keep, and the
 * field that leaks is the one nobody thought to forbid. There is no field here whose value comes from a
 * store, because the run record has no column one could be written into.
 *
 * It names no account and no transaction either, which is why it sits behind its own scope: reading whether
 * the nightly repair is firing is not reading anybody's commerce.
 */
export const PaymentsAdminReconcileRunView = z
  .object({
    id: z.string().describe("The run's id. The same value every repair this pass audited carries as `runId`."),
    startedAt: z.iso.datetime().describe("When the pass began, ISO-8601."),
    finishedAt: z.iso.datetime().describe("When it finished, ISO-8601."),
    environment: PurchaseEnvironment.describe("The store environment the host was deployed to."),
    rail: PaymentsRail.nullable().describe(
      "The store this pass was narrowed to, or null for every enabled rail. Null is the scheduled behavior.",
    ),
    pages: z.number().int().describe("Durable steps read — one page of purchases each."),
    scanned: z.number().int().describe("Purchases examined."),
    unchanged: z.number().int().describe("Purchases whose stored state already matched the store's."),
    drifted: z
      .number()
      .int()
      .describe(
        "Purchases whose stored state disagreed. The number an operator watches: a rising one means webhooks are being lost.",
      ),
    superseded: z.number().int().describe("Old periods a later transaction replaced, settled on this pass."),
    skipped: z.number().int().describe("Purchases no store could be asked about."),
    failed: z.number().int().describe("Purchases a store refused to answer for."),
    truncated: z
      .boolean()
      .describe("Whether the pass stopped at its page cap. True means the tally is a floor rather than a total."),
    dryRun: z.boolean().describe("Whether the pass only reported. A dry run's `drifted` is a finding, not a fix."),
  })
  .describe("One reconciliation pass: when it ran, what it was narrowed to, and its tally. Counts and times only.");
export type PaymentsAdminReconcileRunView = z.output<typeof PaymentsAdminReconcileRunView>;

/**
 * `GET {base}/admin/reconcile-runs`.
 *
 * An empty page is a real answer and a loud one: reconciliation has never run here, which for a project that
 * has provisioned the Workflow is the failure the read exists to surface.
 */
export const PaymentsAdminReconcileRunsResponse = z
  .object({
    runs: z.array(PaymentsAdminReconcileRunView).describe("The page, most recently started first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the reconciliation run log.");
export type PaymentsAdminReconcileRunsResponse = z.output<typeof PaymentsAdminReconcileRunsResponse>;

/** `GET {base}/admin/purchases`. */
export const PaymentsAdminPurchasesResponse = z
  .object({
    purchases: z.array(PaymentsAdminPurchaseView).describe("The page, most recently purchased first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the purchase log.");
export type PaymentsAdminPurchasesResponse = z.output<typeof PaymentsAdminPurchasesResponse>;

/** `GET {base}/admin/subscriptions` — the same rows, narrowed to the ones that renew. */
export const PaymentsAdminSubscriptionsResponse = z
  .object({
    subscriptions: z
      .array(PaymentsAdminPurchaseView)
      .describe("The page, most recently purchased first. Every row has `type: subscription`."),
    nextCursor: NextCursor,
  })
  .describe("A page of the purchases that renew.");
export type PaymentsAdminSubscriptionsResponse = z.output<typeof PaymentsAdminSubscriptionsResponse>;

/** `GET {base}/admin/entitlements`. */
export const PaymentsAdminEntitlementsResponse = z
  .object({
    entitlements: z.array(PaymentsAdminEntitlementView).describe("The page, most recently first granted first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the entitlement model, across every subject.");
export type PaymentsAdminEntitlementsResponse = z.output<typeof PaymentsAdminEntitlementsResponse>;

/**
 * `GET {base}/admin/entitlements/:subjectType/:subjectId`.
 *
 * No cursor, because there is no page: the table is keyed `UNIQUE (subjectType, subjectId, entitlement)`,
 * so this is at most one row per key. A subject holding nothing answers an empty list rather than a 404 —
 * an entitlement row appears with the first purchase that grants one, so its absence is not a missing
 * holder, and a 404 would make this an existence oracle for ids.
 *
 * Both halves are echoed, and that is the reason this response can stand on its own: a body carrying one
 * id and a list is a body a client has to remember it asked about an organization. The pair it asked with
 * comes back verbatim, so what it renders is what it requested.
 */
export const PaymentsAdminSubjectEntitlementsResponse = z
  .object({
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Which kind of holder was asked after, echoed back. Half of the address — the id alone named nothing.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe("The id asked after, echoed so a response stands on its own."),
    entitlements: z
      .array(PaymentsAdminEntitlementView)
      .describe("Every entitlement this subject holds, by key. Empty when it holds none."),
  })
  .describe("One subject's entitlements, resolved now.");
export type PaymentsAdminSubjectEntitlementsResponse = z.output<typeof PaymentsAdminSubjectEntitlementsResponse>;
