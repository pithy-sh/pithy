// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CreatedDiscount, DiscountTerms, SubscriptionPricing } from "../data/discount";
import type { PaymentsPurchase } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
import type { PaymentsSubject } from "../data/subject";
import type {
  RefundRequest,
  SubscriptionCancelTiming,
  SubscriptionChangeQuote,
  SubscriptionStanding,
} from "../data/subscription";
import type { ProviderEventInput } from "../projection/event";

/**
 * The one contract every rail implements, and the one it deliberately does not.
 *
 * A rail does three things: it verifies a receipt a client submitted, it parses a notification the store
 * pushed, and it re-reads the current state of a purchase already projected. All three produce the same
 * normalized event, so the projection writer never learns which store it came from — that is what lets one
 * idempotent writer serve three stores and one entitlement resolve across them.
 *
 * ## Why `refresh` is on the shared contract and `createCheckoutSession` is not
 *
 * Every store can be asked what a purchase looks like now, and every store's answer is worth having: webhooks
 * are dropped, push subscriptions are misconfigured, signing keys rotate, and a subscription can lapse with no
 * notification arriving at all. So `refresh` is not a Stripe-shaped method the other two would stub — it is the
 * question the reconciliation Workflow exists to ask, and all three rails answer it for real. A rail that
 * cannot answer for one *particular* purchase returns `undefined`, which is a fact about that purchase rather
 * than a hole in the rail.
 *
 * ## Why Stripe's session creation is a separate interface
 *
 * Stripe additionally creates the purchase. That asymmetry is real, and this contract does not paper over
 * it. An Apple or Google purchase has **already happened inside the store SDK** by the time the server hears
 * of it: the app presented the sheet, the user paid, and the server's job begins at a receipt. A Stripe
 * purchase is one Pithy initiates, by creating a hosted Checkout Session and sending the browser to it.
 *
 * A single abstraction covering both would force Apple and Google to declare a `createCheckoutSession` with
 * no meaning for them, and every such method is a lie a future maintainer has to read past — worse, one
 * somebody eventually calls. So {@link CheckoutRail} is its own interface, and a rail that initiates
 * purchases implements both. Nothing needs to widen when a fourth rail arrives on either side.
 *
 * ## Why managing a subscription is a third interface, and what changed to allow it
 *
 * {@link SubscriptionRail} is the same split for the same reason: a StoreKit or Play subscription is changed
 * inside the store's own UI, on the customer's device, and a rail that had to declare `changePlan` to satisfy
 * the shared contract would declare a method that cannot be written.
 *
 * It is also **the amendment of 2026-08-28 to #79's locked decision 2**, and the distinction is narrow enough
 * to be worth stating precisely, because the docs it corrects said the wider thing. The kit may *invoke* a
 * plan change and pass the provider's own figures through unmodified. It still never *computes* proration,
 * tax, or SCA: no amount in {@link SubscriptionChangeQuote} is derived from another amount, nothing multiplies
 * a price by a fraction of a period, and nothing checks the provider's arithmetic. The line is between asking
 * a store what a change costs and answering that question ourselves — the second is a number a customer holds
 * against their statement, and the statement is the one they will believe.
 *
 * ## Why a rail cannot name an owner
 *
 * Everything a rail returns is an {@link UnboundProviderEvent} — a provider event with **neither half** of the
 * subject pair. That is a type-level fact, not a convention: a webhook arrives carrying the store's own
 * identifier and nothing else, so a rail that could fill an owner in could be talked into filling in the wrong
 * one. Binding happens in exactly one place, the route, from the authenticated caller through the configured
 * subject seam or from the provider-account map.
 *
 * Omitting *both* halves is what makes the guarantee hold. A rail that could name a `subjectId` and leave the
 * kind to be supplied from config would be pairing an id from a store with a type from somewhere else — and
 * nothing keeps an organization id from equalling some user's, so the two together would grant one holder's
 * subscription to the other. A subject is read and written whole. See `data/subject.ts`.
 *
 * The one thing a rail may report about ownership is an {@link VerifiedNotification.accountReference} — the
 * encoded subject reference *this deployment's own server* attached when it created the purchase, echoed back
 * by the store. That is a claim about the purchase rather than a rail's verdict on who holds it, and it is
 * what a rail with no client-submission path needs: a Stripe purchase is only ever heard about through a
 * webhook, so the pairing of `cus_…` with a subject has to arrive with the notification or never at all.
 */

/**
 * A normalized provider event with its owner left out — **both halves of it**. The rail knows everything about
 * the transaction and nothing about who it belongs to, and the shape says so.
 *
 * Derived by omission rather than declared beside {@link ProviderEventInput}, so a field added to the event is
 * a field every rail may report, and the only fields a rail may never report are the two named here.
 */
export type UnboundProviderEvent = Omit<ProviderEventInput, "subjectType" | "subjectId">;

/** What a rail needs from the request it is serving. The clock, and which deployment is asking. */
export interface RailRequestContext {
  /** The clock, for certificate validity and freshness windows. Injected so verification is deterministic. */
  now: Date;
  /**
   * This deployment's `ENVIRONMENT` var, verbatim — `dev`, `staging`, `prod` — or undefined.
   *
   * For a rail whose store is **one namespace across every environment**, which is the case for Lemon
   * Squeezy: test mode is a flag on an object, not a separate store, so a `dev` deployment and a `staging`
   * deployment pointed at one store both hear everything the other's buyers do. Such a rail stamps this
   * value into the checkout it creates and reads it back off the webhook, and an event stamped for another
   * deployment projects nothing.
   *
   * Deliberately the raw var and not `deploymentEnvironment`'s two-valued answer: that returns `sandbox`
   * for `dev` and `staging` alike, so fencing on it would not separate the two environments this exists to
   * separate. Optional because the other three stores partition by credential and have nothing to fence.
   */
  deployment?: string;
  /**
   * The locale a figure in the answer is rendered for — `Translator.formattingLocale`, region and all.
   *
   * **One method reads it: {@link SubscriptionRail.previewChange}**, whose answer carries `rendered` on
   * every amount, and it is here rather than on {@link SubscriptionChangeInput} because a locale is a fact
   * about the reader of a response, not about the subscription being changed. Every other call on this
   * context — a webhook, a verification, a refresh — answers a machine, and a machine has no locale.
   *
   * **Never a request field, and never `Accept-Language` read directly.** A locale a client can name in a
   * body is a locale a client sets, and the header is only one of four inputs the kit's own negotiation
   * weighs — reading it here would render the money in a language the rest of the same response is not
   * written in. The route resolves it from the translator seam, which is what `@pithy-sh/email` does per
   * recipient and what `@pithy-sh/i18n` fills in per request.
   *
   * Optional, and its absence is not an error: `data/renderMoney.ts` states the fallback rather than
   * guessing one, because a quote in the wrong language is recoverable and a quote with no figure is not.
   */
  locale?: string;
}

/**
 * One inbound notification, as bytes and headers rather than as a `Request`.
 *
 * Bytes because every rail's authenticity check covers the **exact received body** — Apple signs it, Stripe
 * HMACs it — and re-serializing a parsed object would change what was signed. Headers because two of the
 * three rails put their proof in one.
 *
 * Deliberately not a `Request`: a request body is a stream that can be read once, and a rail reading it
 * would leave the route's own validator with nothing. The guard reads it once through Hono's body cache and
 * hands the same string here, so the signature and the handler see the identical bytes.
 */
export interface WebhookDelivery {
  /** The exact received body, decoded as UTF-8. */
  body: string;
  /** The delivery's headers — where Google's OIDC token and Stripe's signature live. */
  headers: Headers;
}

/** A verified client submission: what was bought, and the store-account identifier to link it by. */
export interface VerifiedPurchase {
  /** The transaction, normalized. The route binds the authenticated caller onto it. */
  event: UnboundProviderEvent;
  /**
   * The store's own account identifier — Apple's `appAccountToken`, Google's `obfuscatedAccountId`, Stripe's
   * customer id — or null when the purchase carried none. This is what a later webhook resolves a user
   * through, so a submission that carries one is what stops that webhook arriving orphaned.
   */
  providerAccountId: string | null;
  /**
   * The **encoded subject reference** this deployment's own server attached when it created the purchase,
   * echoed back by the store — Stripe's `client_reference_id`, which the `/checkout` route sets from the
   * caller's resolved subject. `user:ada`, `organization:acme`: the pair, as `encodeSubjectReference` in
   * `data/subject.ts` writes it, and read back only by `decodeSubjectReference`. Never split by hand — one
   * encoding with one decoder is what keeps a value stamped by one code path readable by another.
   *
   * Set only by a rail whose purchases Pithy initiates. Apple's `appAccountToken` and Google's
   * `obfuscatedAccountId` deliberately do **not** go here: those are set by the *app*, which may put anything
   * in them, so treating one as an owner would make a client's choice of value decide who a purchase belongs
   * to. This is the value a server wrote and a store returned unchanged.
   *
   * A string all the same, and untrusted all the same: it comes back as bytes from a store. **It decodes or
   * it names nobody** — a bare id, the shape every pre-subject client sent, is not a user, and a kind this
   * build does not know is not a kind. The route uses it to refuse a submission whose own reference names
   * somebody else, before projecting it.
   */
  accountReference?: string | null;
}

/** A verified notification: authentic, recorded, and sometimes carrying no state change at all. */
export interface VerifiedNotification {
  /**
   * The rail's own event id — Apple's `notificationUUID`, Stripe's event id. `UNIQUE (rail,
   * providerEventId)` is what makes a redelivery recognized rather than reprocessed, and all three providers
   * deliver at-least-once.
   */
  providerEventId: string;
  /** The notification as received, stored whole. What makes "why didn't this renew" answerable. */
  payload: Record<string, unknown>;
  /**
   * The transaction the notification reports, or **null when it reports no transaction state**. Null is a
   * successful outcome, not a failure: a test notification, a consumption request, a declined refund, and a
   * type the store shipped after this package did are all authentic and all change nothing. The row is still
   * recorded, so the reconciliation pass can see what arrived.
   */
  event: UnboundProviderEvent | null;
  /** The store account identifier the notification carried, or null. */
  providerAccountId: string | null;
  /**
   * A refund the rail reported by **order id alone**, with no state attached — or null.
   *
   * Google's voided-purchase notification is the only one shaped this way. It names an order and says it was
   * refunded, and Play offers no lookup that turns it back into a purchase: the one-time endpoint takes the
   * product id as a path segment, and the notification does not carry one. So the rail cannot produce an
   * `event`, and for a while this was recorded and dropped — leaving a refunded non-consumable granting its
   * entitlement forever.
   *
   * The missing product was never in Play, though. It is in **our** row: an order id is exactly what a Google
   * purchase's `providerTransactionId` is. So the rail reports the order and the route, which owns the
   * database, resolves it — the same division as everywhere else, where a rail knows the store and the route
   * knows the projection. An authentic void is itself the refund record, in the same way Apple's `REFUND`
   * notification is; nothing needs to re-ask the store what it already said.
   */
  voidedOrderId?: string | null;
  /**
   * The encoded subject reference this deployment attached when it created the purchase, echoed back — see
   * {@link VerifiedPurchase.accountReference} for the encoding, and for why this is not the same as a rail
   * naming an owner.
   *
   * On a rail with no client-submission path this is the **only** way the account map is ever populated: a
   * Stripe webhook arrives carrying `cus_…`, and the pairing with a subject exists nowhere else. The route
   * decodes it, writes the link from it, and `linkProviderAccount` never rebinds, so the first pairing wins.
   *
   * **It is ranked last in the owner trust order, and it fails closed.** Last because everything above it in
   * `projection/owner.ts` is a fact this server established about a purchase it already projected, and this is
   * a string that made a round trip through somebody else's system — Paddle's is stamped with a MAC precisely
   * because a browser can overwrite it. Closed because `decodeSubjectReference` returns `undefined` for
   * anything that is not exactly the encoding, and `undefined` means the event is recorded as an **orphan**,
   * replayable when an account links, granting nothing. A decode miss is never read as a bare user id: that
   * guess would attribute one customer's renewal to whoever happens to hold the id they sent.
   */
  accountReference?: string | null;
  /**
   * A second event the same notification implies, describing the **subscription's standing** where `event`
   * describes a **charge** — or null, which is the case on every rail but one.
   *
   * Exists because one store reports the two separately and neither message names the other's key. A Lemon
   * Squeezy `subscription_payment_*` webhook carries an invoice: the money, and nothing about whether the
   * subscription is still live. Its `subscription_*` webhooks carry the standing and no money. So that rail
   * writes two rows — see {@link PurchaseRole} — and a notification that changes both has to say both.
   *
   * The case that forces it is a refund. Lemon Squeezy is a merchant of record and issues refunds on its own,
   * for a chargeback or a tax dispute, with no local write preceding it; the invoice row must go `refunded` so
   * the ledger claws back, *and* the subscription must stop granting, because the buyer has their money back.
   * One event could do one or the other, and doing only the first leaves a refunded subscriber with the
   * feature.
   *
   * The route projects it with the same owner as `event` and after it. It is never fulfilled for credit — a
   * `state` row is not a charge, so `purchaseIsPaid` and the clawback both refuse it by role.
   */
  stateEvent?: UnboundProviderEvent | null;
  /**
   * Why an authentic notification produced no event, when that is worth recording — written to the webhook row's
   * `error` column so it is queryable and the reconciliation pass can act on it.
   *
   * Null when there is nothing to say, which is the common case: a test notification is exactly what it looks
   * like. It earns its place on the rails that *can* be authentically told about a purchase they cannot resolve
   * — Play's voided-purchase notification names no product, so the delivery is real, the refund is real, and
   * neither is projectable without a lookup only the Workflow can make. A row recording that with its reason is
   * the difference between a repairable gap and a silent drop.
   *
   * **Which of the two it is decides whether the row is finished** — see {@link NotificationNote}.
   */
  note?: NotificationNote | null;
}

/**
 * Why there is no event, and **where that answer came from**. Two cases, because there are two.
 *
 * `{ stated }` — the delivered bytes say it. A partial refund that takes nothing away, a notification type
 * this build does not act on, an order Play reports voided. The same bytes get the same answer from the same
 * build for ever, so the row is **finished** and a redelivery is answered `duplicate`.
 *
 * `{ read }` — a call to the provider came back empty and this note is that answer. Play has no purchase
 * under the token, Lemon Squeezy no longer knows the subscription, Paddle will not show the transaction an
 * adjustment names. **Repairable**, and this is #341: three rails derived a note this way and it finished the
 * row. A read that answers "no such thing" can be a race — an RTDN outrunning Play's own read-after-write, a
 * key rotated mid-flight, a shared sandbox — so the second answer differs from the first, and the delivery
 * that would have carried it was already being told it was a duplicate.
 *
 * **A note is safe as terminal only when it comes from a source that cannot have failed.** The delivered
 * bytes are such a source; a read is not. So the provenance travels with the text rather than being inferred
 * at the far end, and the two are one field so no rail can claim both.
 *
 * The same rule applies wherever a note finishes a row: the webhook handler and the Paddle events sweep both
 * read this, and both treat `read` as a repairable failure rather than a completion.
 */
export type NotificationNote =
  | {
      /** What the delivered bytes say. Terminal. */
      readonly stated: string;
    }
  | {
      /** What a provider read answered, and could answer differently next time. Repairable. */
      readonly read: string;
    };

/** The note's text, whichever kind it is. An operator reads the two the same way; the row does not. */
export function noteText(note: NotificationNote | null | undefined): string | undefined {
  if (note === null || note === undefined) return undefined;
  return "stated" in note ? note.stated : note.read;
}

/** Whether this note leaves the delivery repairable — true only for one a read produced. */
export function noteIsRepairable(note: NotificationNote | null | undefined): boolean {
  return note !== null && note !== undefined && "read" in note;
}

/** Every rail. Verification of a client submission, parsing of a pushed notification, and a state re-read. */
export interface PaymentsRailProvider {
  /** Which store this provider speaks for. */
  readonly rail: PaymentsRail;
  /**
   * Verify a receipt or signed transaction a client submitted, exactly as the store SDK returned it. Throws
   * `payments/invalid_receipt` when it cannot be read and `payments/verification_failed` when the store does
   * not vouch for it.
   */
  verify(receipt: string, context: RailRequestContext): Promise<VerifiedPurchase>;
  /**
   * Verify and parse a pushed notification. Takes the delivery's bytes and headers rather than a parsed
   * object, because authenticity lives in different places per rail — Apple signs the body, Google puts an
   * OIDC token in a header, Stripe puts an HMAC in one — and every one of those covers the exact received
   * bytes. Throws when authenticity cannot be established; the guard maps that to
   * `payments/webhook_unverified`.
   */
  parseNotification(delivery: WebhookDelivery, context: RailRequestContext): Promise<VerifiedNotification>;
  /**
   * Re-read the current state of a purchase this deployment already projected — the reconciliation path.
   *
   * Takes the stored row rather than a handful of ids, because what identifies a purchase at its store differs
   * per rail and some of it survives only in the payload: Apple keys a subscription family on
   * `originalTransactionId`, Play keys one on the purchase token, and Stripe on `sub_…`. Handing the whole row
   * over means adding a rail never widens this signature.
   *
   * **The returned event's `providerEventAt` is the clock, not a store timestamp**, and that is deliberate. A
   * refresh is a read of the state *now*, so it is the freshest fact anyone has — dating it earlier would let
   * the monotonic write rule discard the very repair the run exists to make.
   *
   * `undefined` means the store has nothing to say about this purchase: the rail cannot address it (a one-time
   * purchase whose store offers no lookup), or the store no longer knows it. That is a normal answer and leaves
   * the row exactly as it stood. A store that cannot be *reached* throws `payments/provider_unavailable`
   * instead, which is what tells the Workflow to fail the step and retry rather than record a repair that
   * never happened.
   */
  refresh(purchase: PaymentsPurchase, context: RailRequestContext): Promise<UnboundProviderEvent | undefined>;
  /**
   * Re-read a notification body this package already recorded, **without re-establishing authenticity**.
   *
   * The row it comes from was written by a delivery that verified, or by a sweep reading the store's own
   * event stream over an authenticated connection, so the bytes are already vouched for. Re-verifying is not
   * merely redundant — it is impossible: a signature covers headers this table never stored, and a JWS has a
   * validity window that expired long ago.
   *
   * It exists for one caller: the repair that runs when an account links. An orphan is a purchase with
   * nobody to project it against, and the only thing that changes is a `provider_accounts` row appearing
   * later. Nothing about the event changes, so the payload is where the purchase is — which is precisely
   * what {@link VerifiedNotification.payload} is stored whole for.
   *
   * **Optional, and a rail that cannot do it says so by not implementing it.** Apple and Google store a
   * signed blob whose claims this build reads only through a verifier, and Lemon Squeezy's parse needs a live
   * subscription read; a stub returning a half-read event would be worse than the absence. Those rails'
   * orphans are repaired by the store's own redelivery, as they were.
   *
   * `undefined` means the payload is not one this rail can replay — a shape from an older build, an event
   * type since dropped. That is a fact about the row, not a failure, and the repair leaves it exactly as it
   * stood.
   */
  replay?(payload: Record<string, unknown>, context: RailRequestContext): Promise<VerifiedNotification | undefined>;
}

/** What a hosted checkout session needs. The catalog product is resolved before this is called. */
export interface CheckoutSessionInput {
  /** The rail's own price identifier for the product being bought. */
  providerProductId: string;
  /** Whether this buys a recurring subscription or a one-off. Decides the hosted flow the store presents. */
  subscription: boolean;
  /**
   * The subject the purchase is for — the authenticated caller, or the organization the project bills on
   * their behalf, as the configured subject seam resolved it.
   *
   * Passed as the pair rather than an id so the rail stamps `encodeSubjectReference(input.subject)` into the
   * checkout it creates, and the webhook that follows arrives already naming a holder this server chose. A
   * rail that received an id alone would have to pair it with a kind from config to build that reference,
   * which is the one pairing `data/subject.ts` forbids.
   */
  subject: PaymentsSubject;
  /**
   * The store account this caller already has, from the provider-account map, or null on a first purchase.
   *
   * Passing it is what keeps one buyer to one store account. Without it every checkout creates a fresh
   * customer, and a user's second purchase would be invisible from the billing portal their first one made.
   */
  providerAccountId?: string | null;
  /** Where the store sends the browser after a completed purchase. */
  successUrl: string;
  /**
   * Where the store sends the browser if the purchase is abandoned, or undefined for a store that offers
   * nowhere to abandon *to*.
   *
   * Optional for the same reason {@link PortalSessionInput.returnUrl} is: Lemon Squeezy's hosted checkout
   * has no cancel destination — a buyer who backs out closes the tab — and a required field there would
   * mean asking an adopter for a URL the rail then silently discarded.
   */
  cancelUrl?: string;
  /**
   * A discount code to apply, passed to the store **unchanged**, or undefined.
   *
   * The store calculates the price. Pithy never computes a discounted amount and never checks a code against
   * anything of its own: the provider is the authority on what is owed, and a second calculation here would
   * be a second answer to the one question a customer will check against their card statement.
   *
   * An invalid or expired code therefore fails at the store, and the rail turns that into
   * `payments/discount_invalid` naming the code — distinctly from a payment failure, because a customer told
   * "something went wrong" at checkout concludes their card was declined.
   */
  discountCode?: string;
}

/** What a billing-portal session needs: the store account whose subscription is being managed. */
export interface PortalSessionInput {
  /** The store's own account identifier for the caller, resolved from the provider-account map. */
  providerAccountId: string;
  /**
   * Where the store sends the browser when the user is done, or undefined for a store that offers nowhere
   * to return to.
   *
   * Optional because one store genuinely is shaped that way, and saying so in the type is better than the
   * alternative. Lemon Squeezy's customer portal is a signed, expiring link read off the customer object;
   * it takes no return parameter, and the subscriber closes the tab. A required field there would leave
   * the rail silently discarding a URL an adopter configured and believed in — the failure would be a
   * button that goes nowhere rather than a type error. So the contract admits the gap, and a project
   * running that rail alone is never asked for a URL nothing will use.
   */
  returnUrl?: string;
  /**
   * The store's own subscription ids this caller owns, for a store that mints per-subscription deep links.
   *
   * **Resolved by the route from the caller's own purchase rows, never from a request body.** `/portal`
   * takes no body at all, and that is the request contract that makes the whole surface safe: a field here
   * naming a subscription would let any signed-in caller ask for authenticated cancel links to somebody
   * else's — the exact vulnerability {@link providerAccountId} coming from the account map exists to close.
   *
   * Undefined for the rails whose portal is one page for the whole account.
   */
  subscriptionIds?: readonly string[];
}

/**
 * How a browser is handed to a store's payment page. Pithy never owns payment UI, SCA, or tax, and never
 * *computes* proration.
 *
 * **"Never computes" is narrower than what this line used to say, and the narrowing is deliberate** (#79's
 * locked decision 2, amended 2026-08-28). A checkout still names no amount and no quantity: the price is the
 * price, and a checkout that could carry a figure is a checkout a client could put a figure on. What the kit
 * may now do is *invoke* a plan change on an existing subscription and pass the provider's own preview through
 * unmodified — see {@link SubscriptionRail}, which is a separate interface reached by a separate route, and
 * which produces no figure of its own either.
 *
 * **A union, because one store has no URL to give.** Stripe and Lemon Squeezy both mint a hosted page and
 * answer with its address, and for eleven months that was the whole shape — `{ url }`. Paddle's overlay and
 * inline modes never leave the adopter's page: the server creates a transaction, and the browser opens it
 * with Paddle.js against a publishable client token. There is no address to send anyone to, so a `{ url }`
 * return could only be filled with a lie or with an empty string.
 *
 * `redirect` is what the two older rails return, unchanged in every field. The widening costs them nothing,
 * and a screen that only ever handled a redirect keeps working by narrowing on `kind` — which is a compile
 * error where it is missing rather than a runtime surprise.
 */
export type CheckoutHandoff =
  | {
      /** A hosted page the browser is sent to. */
      kind: "redirect";
      /** The absolute URL to send the browser to. */
      url: string;
    }
  | {
      /** A transaction the browser opens with Paddle.js, over the adopter's own page. */
      kind: "paddle";
      /** The transaction the server created — `txn_…`. What `Paddle.Checkout.open` is given. */
      transactionId: string;
      /**
       * The publishable client token Paddle.js initializes with — `live_…` or `test_…`.
       *
       * Publishable by design, exactly as a Stripe price id is: it is what a browser needs to open a
       * checkout, and nothing about verification depends on its secrecy. The API key and the webhook
       * signing secret are secrets and never appear here.
       */
      clientToken: string;
      /** Which Paddle environment the token belongs to. `Paddle.Environment.set` takes it verbatim. */
      environment: "sandbox" | "production";
      /** Whether the checkout opens over the page or inside a container the screen provides. */
      displayMode: "overlay" | "inline";
      /**
       * Where a buyer who paid is sent, from `config.paddle.successUrl`.
       *
       * On the handoff because Paddle.js takes it as `settings.successUrl` at the moment the checkout is
       * opened, and that moment is in the browser. It still comes from config and never from a request:
       * a client that could name a return URL could send a paying customer to a page it controls.
       */
      successUrl: string;
    };

/** One subscription's authenticated portal deep links, as a store hands them back. */
export interface PortalSubscriptionLinks {
  /** The store's own subscription id — `sub_…`. */
  subscriptionId: string;
  /** Where this subscription is canceled. */
  cancel: string;
  /** Where this subscription's payment method is changed. */
  updatePaymentMethod: string;
}

/**
 * A billing portal, as a store returns it.
 *
 * `url` is the overview page every rail has. `subscriptions` is the part only Paddle offers: authenticated
 * deep links straight to one subscription's cancel and update-payment-method screens, so a subscription
 * screen can render per-subscription actions rather than one "Manage billing" button.
 *
 * **Every URL here is a bearer credential for that customer's billing, and Paddle's is good for 24 hours.**
 * Its overview link carries a `pga_` JWT whose `iat` and `exp` are 86400 seconds apart, with scopes
 * covering `customer.subscription.update`, `customer.customer.update` and `customer.transaction.create` —
 * verified against a live sandbox session, and materially different from the "single-use, short-lived" the
 * issue described. So: never cached, never persisted, never logged, and never a redirect target something
 * else could read out of a `Referer`.
 */
export interface PortalHandoff {
  /** The portal's overview page for this customer. */
  url: string;
  /** Per-subscription deep links, when the store offers them. Absent on the rails that do not. */
  subscriptions?: readonly PortalSubscriptionLinks[];
}

/**
 * The rails that *initiate* a purchase rather than merely hearing about one — Stripe, Lemon Squeezy, Paddle.
 *
 * Deliberately separate from {@link PaymentsRailProvider}: see the module doc. A rail implements both
 * interfaces or only the first, and the route that needs a checkout session narrows to this one.
 */
export interface CheckoutRail {
  /** Create a checkout for one product, and say how the browser reaches it. */
  createCheckoutSession(input: CheckoutSessionInput, context: RailRequestContext): Promise<CheckoutHandoff>;
  /** Create a billing-portal session, where a subscriber manages or cancels. */
  createPortalSession(input: PortalSessionInput, context: RailRequestContext): Promise<PortalHandoff>;
}

/** Whether a rail provider also initiates purchases. The one narrowing `/checkout` and `/portal` need. */
export function isCheckoutRail(provider: PaymentsRailProvider): provider is PaymentsRailProvider & CheckoutRail {
  return (
    typeof (provider as Partial<CheckoutRail>).createCheckoutSession === "function" &&
    typeof (provider as Partial<CheckoutRail>).createPortalSession === "function"
  );
}

/**
 * A rail that can *mint* a discount, as distinct from one that can merely apply one.
 *
 * **Its own interface, and the separation is load-bearing rather than tidy.** Applying a code must work with
 * creation unimplemented — an adopter whose codes are minted by hand in a provider dashboard is fully served
 * by the apply half, and making that half depend on this one would hold it hostage to a surface they never
 * asked for. So `discountCode` rides on {@link CheckoutSessionInput}, which every checkout rail already
 * takes, and this is a separate question asked separately.
 *
 * It is also the more dangerous half. It writes money-affecting objects into a payment provider through one
 * shape over two APIs that agree on the concept and disagree on nearly every field, and the failures are
 * quiet ones that surface on a customer's statement — see `data/discount.ts` for the three that were
 * designed against. Minting a discount is an administrative act with a cost attached, which is why the route
 * behind it carries its own scope and its own audit event rather than riding on an existing one.
 */
export interface DiscountRail {
  /**
   * Create a discount at the store and return what it made.
   *
   * Throws `payments/discount_invalid` when the store refuses the terms, with the store's own reason in
   * `detail`. Nothing here validates the terms a second time — `DiscountTerms` has already refused the
   * combinations that are wrong on their face, and the store owns the rest.
   */
  createDiscount(terms: DiscountTerms, context: RailRequestContext): Promise<CreatedDiscount>;
  /**
   * The discount codes this store holds, newest first.
   *
   * A management client that can mint a code must be able to see what it minted — otherwise a pane over
   * them computes *absent* rather than blocked, which no grant repairs (#247). Read from the store rather
   * than from a table of ours: the store is where a code actually exists, and a local mirror would be a
   * second answer that drifts the first time somebody uses the dashboard.
   *
   * Never reaches a browser. The set of codes an adopter has issued is a commercial fact, and the client
   * projection draws the same line here it draws for SKUs and the `grants` block.
   */
  listDiscounts(context: RailRequestContext): Promise<readonly ListedDiscount[]>;
}

/** One discount as a store lists it. Deliberately less than {@link CreatedDiscount} — a list is not a receipt. */
export interface ListedDiscount {
  /** The code a customer enters. */
  code: string;
  /** The store's own id. */
  providerDiscountId: string;
  /** How much comes off, rendered for a person — `20%`, `500 usd`. The store's own figures. */
  amount: string;
  /** How many times it has been claimed, when the store reports it. */
  redemptions: number | null;
}

/**
 * A rail that can say what a subscription pays now, what it becomes, and when.
 *
 * Separate from {@link DiscountRail} because they are separate abilities: a rail that can apply a code an
 * adopter minted by hand must be able to report the resulting rate, whether or not it can mint one. Separate
 * from the shared contract because Apple and Google have no equivalent — a store SDK subscription's price
 * changes are the store's business and it does not publish a "what this becomes" figure.
 *
 * **This is the half that stops a bill changing unannounced.** A capability that can apply a discount but
 * cannot report its end date has shipped the half that creates the surprise: from a customer's seat, a rate
 * that silently lapses is indistinguishable from a billing error.
 */
export interface PricingRail {
  /**
   * What this subscription pays now, what it will pay, and when that changes — or `undefined` when the store
   * has nothing to say about it, which is the same answer `refresh` gives for the same reason.
   *
   * Every figure comes from the store. Nothing multiplies a price by a percentage here or anywhere else.
   */
  readPricing(purchase: PaymentsPurchase, context: RailRequestContext): Promise<SubscriptionPricing | undefined>;
}

/** Whether a rail reports pricing. Structural, like the others. */
export function isPricingRail(provider: PaymentsRailProvider): provider is PaymentsRailProvider & PricingRail {
  return typeof (provider as Partial<PricingRail>).readPricing === "function";
}

/**
 * Whether a rail can mint **and** list discounts. Structural, so a rail gains the ability without an edit here.
 *
 * **It ANDs both methods, and until #465 it did not.** {@link DiscountRail} declares two, and a guard probing
 * `createDiscount` alone narrowed a rail that could mint and not list into a type promising both — so
 * `GET {base}/admin/discounts` passed its own guard and then called a method that was not there. That is a
 * `TypeError` inside a handler, which reaches a management pane as a 500, where a rail that plainly cannot
 * mint gets `rail_not_configured` and a pane that can say so. No rail ever hit it: all three hosted rails
 * declare both. It was a defect waiting for the fourth, and it is the one every other guard here is written
 * against by name.
 */
export function isDiscountRail(provider: PaymentsRailProvider): provider is PaymentsRailProvider & DiscountRail {
  const rail = provider as Partial<DiscountRail>;
  return typeof rail.createDiscount === "function" && typeof rail.listDiscounts === "function";
}

/**
 * Which subscription is being changed, and what it becomes. One row, one price, and nothing else.
 *
 * **There is no field naming a subscription, and that absence is the security boundary.** The subscription
 * arrives as a {@link PaymentsPurchase} — a decoded row only this deployment's own database produces, already
 * carrying the subject that owns it — exactly as {@link PaymentsRailProvider.refresh} and
 * {@link PricingRail.readPricing} take one. A `subscriptionId` here would be a value a caller supplies, and a
 * value a caller supplies is one they can point at somebody else's subscription. This capability holds no
 * members table and no ownership graph of its own, so there is nothing it could check that claim against: the
 * refusal has to be structural. It is the same rule {@link PortalSessionInput.subscriptionIds} states for
 * reads, applied where the verb writes.
 *
 * The route's own job follows from that: resolve the row from the authenticated caller's purchases, never
 * from a request body.
 */
export interface SubscriptionChangeInput {
  /**
   * The stored purchase whose subscription is being changed — the projection's own row, already owned.
   *
   * The whole row rather than the ids off it, for {@link PaymentsRailProvider.refresh}'s reason: what
   * identifies a subscription at its store differs per rail and some of it survives only in the payload. A
   * rail added later never widens this signature.
   */
  purchase: PaymentsPurchase;
  /**
   * The rail's own price identifier for the plan being moved to — **exactly one, never a list**.
   *
   * Paddle's subscription update *replaces* the items array: an item omitted from the request is removed from
   * the subscription. So a `readonly string[]` here would be a delete verb wearing an update verb's name, and
   * the shape of the mistake is a caller passing the one price they are moving to and silently dropping every
   * add-on beside it. **Building the complete item list the provider is sent is the rail's obligation**, from
   * the subscription it re-read, and it is the rail's because that is where the provider's replace semantics
   * are known.
   *
   * Named as {@link CheckoutSessionInput.providerProductId} is, and meaning what it means there: the store's
   * own SKU or price id, resolved from the catalog before this is called. One vocabulary, so a reader does not
   * have to work out whether two spellings are two things.
   */
  providerProductId: string;
}

/** Which subscription is being canceled, and when the customer stops. */
export interface SubscriptionCancelInput {
  /** The stored purchase whose subscription is being canceled. See {@link SubscriptionChangeInput.purchase}. */
  purchase: PaymentsPurchase;
  /**
   * When it takes effect, in the customer's terms — `at_period_end` under the settled policy.
   *
   * The rail translates into the store's spelling; Paddle's own `next_billing_period` does not parse here, so a
   * rail that stopped translating fails loudly rather than sending a string Paddle happens to accept. See
   * `data/subscription.ts` for why the customer's word is the one modeled.
   */
  timing: SubscriptionCancelTiming;
}

/**
 * A rail whose subscriptions can be *changed* from the server: read, quoted, moved, ended, and un-ended.
 *
 * Separate from {@link CheckoutRail} because selling and managing are separate abilities — and separate from
 * the shared contract for the reason the module doc gives: an Apple or Google subscription is changed inside
 * the store's own UI, on the device, and no server call exists to do it.
 *
 * ## Five methods, and the guard demands all five
 *
 * {@link isSubscriptionRail} ANDs every one of them. That is the rule {@link isCheckoutRail} sets and
 * {@link isDiscountRail} broke: it probed a single method of two and narrowed a half-implemented rail into a
 * type that promised the other, which is a `TypeError` inside a handler rather than a refusal at its edge.
 * That guard was fixed with this interface's arrival, and the shape is named here so nothing is written to
 * match it again. The floor it sets is a rule about what may ship together:
 *
 * - **No destructive verb without the read that makes it legible.** A rail that could cancel and not report
 *   the cancellation ships the half that creates the support ticket: Paddle leaves `status` at `active` and
 *   blanks `next_billed_at` when a cancellation is scheduled (recorded 2026-08-28, #465), so a customer who
 *   canceled is told they will be billed again by every screen that reads the status.
 * - **No change without the quote that makes it consented to.** A confirmation screen with no figure on it is
 *   a customer agreeing to an amount they were never shown, and the amount is real: the recorded upgrade
 *   charges 6582 immediately.
 *
 * ## What is deliberately absent from every method here
 *
 * **A proration mode, and any other billing enum.** The rail picks the mode from the *direction* of the
 * change — an upgrade prorates immediately and charges now, a downgrade prorates into the next billing period
 * — and `on_payment_failure` is always `prevent_change`. Neither is a parameter, because a parameter is a
 * thing a client eventually sets, and the value a client would eventually set is Paddle's `do_not_bill`: a
 * free upgrade. It is unreachable because there is nowhere to write it.
 *
 * ## The no-op is a success, not a refusal
 *
 * A change to the plan already held, and a cancellation of a subscription that is already scheduled to
 * cancel, both answer the current standing **without calling the provider at all**. That is the retry answer:
 * these verbs sit behind a network, callers retry, and a second delivery of the same intent must not become a
 * second proration. A 409 for the state the caller asked for is also simply wrong — the subscription is how
 * they wanted it.
 */
export interface SubscriptionRail {
  /**
   * Where this subscription stands now — status, dates, and whatever is scheduled to happen to it — or
   * `undefined` when the store has nothing to say about this purchase.
   *
   * `undefined` for {@link PaymentsRailProvider.refresh}'s reason and with its meaning: the rail cannot
   * address this purchase, or the store no longer knows it. A store that cannot be *reached* throws
   * `payments/provider_unavailable` instead, so a screen distinguishes "there is nothing to show" from "we
   * could not look".
   *
   * Read live, never from a projected row. The one fact this exists to report — a scheduled cancellation —
   * is precisely the one a purchase row does not carry, and a webhook announcing it can be dropped.
   */
  readStanding(purchase: PaymentsPurchase, context: RailRequestContext): Promise<SubscriptionStanding | undefined>;
  /**
   * What moving to this price would cost, as the provider previews it — the figures a customer confirms.
   *
   * Every amount comes from the store and none is derived here. See `data/subscription.ts` for what the
   * recordings established about reading them, and in particular for why the answer has three parts.
   *
   * **A read, so the no-op rule does not apply to it.** A preview takes and gives nothing, a second one is
   * free, and asking the provider what the plan already held would cost is a question with an honest answer.
   * The no-op exists to stop a retried *write* from prorating twice; borrowing it here would mean inventing a
   * recurring figure to fill the quote with, which is the one thing this package will not do.
   *
   * Throws rather than answering `undefined`. A quote that could be absent is a confirm button rendered
   * beside nothing, and `payments/provider_unavailable` is what tells a screen to say so.
   */
  previewChange(input: SubscriptionChangeInput, context: RailRequestContext): Promise<SubscriptionChangeQuote>;
  /**
   * Move the subscription to a different plan, and answer where it now stands.
   *
   * **The rail chooses the proration mode from the direction of the change** — up charges immediately, down
   * defers the credit to the next billing period — and nothing the caller sends influences it.
   *
   * Answers the resulting {@link SubscriptionStanding} rather than nothing, so the screen that just wrote can
   * render what it wrote from the provider's own answer instead of predicting it. A prediction is how a
   * customer sees a plan they are not on.
   *
   * A change to the plan already held is the no-op: the current standing, and no provider call. Anything the
   * store refuses — a subscription that is paused, canceled, or past due — throws
   * `payments/subscription_change_refused` (409) with the store's own reason in `detail`.
   */
  changePlan(input: SubscriptionChangeInput, context: RailRequestContext): Promise<SubscriptionStanding>;
  /**
   * Stop the subscription renewing, and answer where it now stands.
   *
   * `at_period_end` is the settled policy and the tier holds until the paid period runs out; `now` exists
   * because support occasionally has to end one today, and because a policy with no legitimate exit gets
   * departed from by a direct provider call nothing audits.
   *
   * A cancellation on a subscription already scheduled to cancel is the no-op: the current standing, and no
   * provider call. A subscription the store will not cancel throws `payments/subscription_change_refused`.
   */
  cancelSubscription(input: SubscriptionCancelInput, context: RailRequestContext): Promise<SubscriptionStanding>;
  /**
   * Withdraw a scheduled cancellation, so the subscription renews after all.
   *
   * **It withdraws a cancellation, and only a cancellation.** Paddle offers no verb for that: the update
   * clears `scheduled_change` *wholesale*, by setting it to null, and the field also holds a scheduled pause
   * and a scheduled resume. So a rail that simply sent the clear would silently un-pause a paused subscription
   * — the customer's account restarts billing, on a request that said nothing about pausing. The rail must
   * **re-read the subscription first and refuse unless the pending action is `cancel`**, with
   * `payments/subscription_change_refused` (409) naming what was actually scheduled. The check cannot move to
   * the route: the route holds a projected row, and the pending action lives only at the store.
   *
   * A subscription with nothing scheduled is the no-op rather than a refusal: it already renews, which is what
   * the caller asked for, and a retry after a successful withdrawal is exactly that request arriving twice.
   *
   * Its own method rather than `changePlan` to the same price, because the two are separate acts by possibly
   * separate actors and the audit trail records them separately — a withdrawal folded into a plan change
   * leaves a trail that asserts a cancellation and holds nothing saying it was taken back.
   */
  keepSubscription(purchase: PaymentsPurchase, context: RailRequestContext): Promise<SubscriptionStanding>;
}

/**
 * Whether a rail can manage a subscription from the server. Structural, like the others — and **it ANDs all
 * five methods**, which the others do not all do.
 *
 * Every guard in this file ANDs its whole interface now, which was not true when this one was written — see
 * {@link isDiscountRail} for the shape and what it cost. A guard that probes one method narrows a
 * partially-implemented rail into a type promising the rest, and the first thing anybody learns about the gap
 * is a `TypeError` thrown mid-cancellation, on a route that has already written an audit row. Here a rail
 * missing any one verb is simply not a subscription rail, and the route answers `rail_not_configured` — which
 * is true, and which is a refusal rather than a half-applied change.
 */
export function isSubscriptionRail(
  provider: PaymentsRailProvider,
): provider is PaymentsRailProvider & SubscriptionRail {
  const rail = provider as Partial<SubscriptionRail>;
  return (
    typeof rail.readStanding === "function" &&
    typeof rail.previewChange === "function" &&
    typeof rail.changePlan === "function" &&
    typeof rail.cancelSubscription === "function" &&
    typeof rail.keepSubscription === "function"
  );
}

/**
 * Which payments are being refunded, and why — one set, no amount, and no identifier a caller could have
 * written.
 *
 * **There is no transaction id here, and that absence is the security boundary**, exactly as
 * {@link SubscriptionChangeInput} states it for a subscription. The payments arrive as
 * {@link PaymentsPurchase} rows — decoded rows only this deployment's own database produces, each already
 * carrying the subject that owns it — because a `txn_…` a caller supplies is a `txn_…` they can point at a
 * stranger's money. This capability holds no ownership graph to check such a claim against, so the refusal
 * has to be structural: the route resolves the rows from the authenticated caller's own purchases and there
 * is nowhere in this shape to write anything else.
 *
 * **And there is no amount.** Every refund raised through this seam is for a transaction's whole total. A
 * partial one is a different feature — it needs the store's own line-item ids, which nothing here holds —
 * and an amount on a bearer route is a self-service withdrawal.
 */
export interface RefundRequestInput {
  /**
   * The payments to refund — the caller's own purchase rows, one adjustment each.
   *
   * A set rather than one, because refunds attach to transactions and a subscription is a family of them:
   * a customer who upgraded mid-period has paid twice and is owed both. The rail raises one refund per row
   * and reports one outcome per row.
   *
   * **Order is the caller's and the report keeps it**, so a partial report is reproducible rather than
   * whatever the store answered first.
   */
  purchases: readonly PaymentsPurchase[];
  /**
   * Why, in the operator's words — composed by the route, and **never read from a request body.**
   *
   * Every store requires one and shows it to a human in the merchant's own console. That is the argument
   * for not taking it from the caller: a bearer request writing free text into an adopter's back office is
   * a stranger writing into somebody's operational record, and there is nothing a customer could say there
   * that the audit row and the store's own history do not already hold. An adopter who wants the
   * customer's own words collects them on their own screen, where they belong to the adopter.
   */
  reason: string;
}

/**
 * A rail that can ask its store to give a customer's money back.
 *
 * ## Its own interface, and not a sixth method on {@link SubscriptionRail}
 *
 * **The two abilities are independent in both directions, which is the whole argument.** Google Play has a
 * server-side refund call and no server-side plan change — a subscription's plan is changed inside the
 * store, on the device — so that rail could implement this and never implement {@link SubscriptionRail}.
 * Apple is the other corner: refunds are Apple's own decision and the only server endpoint is a *lookup*,
 * so a rail may be able to manage a subscription and have nothing to put here. An interface that demanded
 * both would be one neither of them can satisfy.
 *
 * **And widening a guard that ANDs its methods is retroactive.** {@link isSubscriptionRail} requires all
 * five verbs; a sixth would silently de-narrow every rail that already satisfies the five, and the first
 * anybody would hear of it is `rail_not_configured` on a cancellation, from a release that changed nothing
 * about canceling. A new interface costs one guard and breaks nothing that exists.
 *
 * **The floors differ too.** `SubscriptionRail`'s floor is *no destructive verb without the read that makes
 * it legible* — the read being a standing. A refund's legibility read is a different one: the transactions
 * and whatever adjustments already stand on them. Folding refunds in would make the ability to change a
 * plan carry the power to move money back, which is a much larger power granted for a much smaller job.
 *
 * ## What a rail implementing this must guarantee
 *
 * - **It never claims money moved.** The answer is {@link RefundRequest}, whose every outcome is a request
 *   and whose statuses say so. Most live refunds sit at the store awaiting a human.
 * - **It revokes nothing.** No entitlement, no purchase row, no projection. An approved refund arrives as a
 *   webhook and the projection acts on it — revoking on the *request* takes access from a customer whose
 *   refund the store then rejects, leaving them with neither the money nor the product.
 * - **It refuses before it writes, and reports after.** Everything knowable in advance refuses the whole
 *   request with `payments/subscription_change_refused` and sends nothing; once one adjustment exists,
 *   every remaining failure is an outcome in the report. {@link RefundRequest} holds the long form.
 * - **It bounds the set.** A set it cannot issue inside one request is refused before the first write, not
 *   discovered half way through.
 *
 * ## What is deliberately absent
 *
 * **An amount, a currency, a transaction id, and a window.** The first three are {@link RefundRequestInput}'s
 * argument. The window is the *adopter's*: how many days a customer has to ask for their money back is a
 * commercial policy with a company behind it, and a kit that hard-coded fourteen days would be wrong for the
 * second adopter. The kit makes the refund possible; the adopter's screen decides which button exists.
 */
export interface RefundRail {
  /**
   * Ask the store to refund these payments in full, and report what became of each.
   *
   * Throws `payments/subscription_change_refused` (409) when the request is refused before anything is
   * sent, and `payments/provider_unavailable` (503) when the store could not be reached or answered in a
   * shape this build cannot read — both only while nothing has been raised. After the first adjustment
   * exists it answers, whatever else happened.
   */
  requestRefunds(input: RefundRequestInput, context: RailRequestContext): Promise<RefundRequest>;
}

/**
 * Whether a rail can refund at its store. Structural, like the others.
 *
 * One method, so probing it *is* ANDing all of them — {@link isSubscriptionRail}'s rule, satisfied by
 * arithmetic rather than by care. Stated because that stops being true the moment a second method is added
 * here, and a guard left probing one of two is what {@link isDiscountRail} did until #465.
 */
export function isRefundRail(provider: PaymentsRailProvider): provider is PaymentsRailProvider & RefundRail {
  return typeof (provider as Partial<RefundRail>).requestRefunds === "function";
}
