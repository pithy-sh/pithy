import type { PaymentsPurchase } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
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
 * ## Why a rail cannot name a user
 *
 * Everything a rail returns is an {@link UnboundProviderEvent} — a provider event with no `userId`. That is
 * a type-level fact, not a convention: a webhook arrives carrying the store's own identifier and no Pithy
 * user, so a rail that could fill in a `userId` could be talked into filling in the wrong one. Binding
 * happens in exactly one place, the route, from the authenticated caller or the provider-account map.
 *
 * The one thing a rail may report about ownership is an {@link VerifiedNotification.accountReference} — a value
 * *this deployment's own server* attached when it created the purchase and the store echoed back. That is a
 * different fact from a user id the rail decided, and it is what a rail with no client-submission path needs:
 * a Stripe purchase is only ever heard about through a webhook, so the pairing of `cus_…` with a Pithy user
 * has to arrive with the notification or never at all.
 */

/**
 * A normalized provider event with its owner left out. The rail knows everything about the transaction and
 * nothing about who it belongs to, and the shape says so.
 */
export type UnboundProviderEvent = Omit<ProviderEventInput, "userId">;

/** What a rail needs from the request it is serving. Just the clock — everything else is on the rail. */
export interface RailRequestContext {
  /** The clock, for certificate validity and freshness windows. Injected so verification is deterministic. */
  now: Date;
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
   * The reference **this deployment's own server** attached when it created the purchase, echoed back by the
   * store — Stripe's `client_reference_id`, which the `/checkout` route sets from the authenticated caller.
   *
   * Set only by a rail whose purchases Pithy initiates. Apple's `appAccountToken` and Google's
   * `obfuscatedAccountId` deliberately do **not** go here: those are set by the *app*, which may put anything
   * in them, so treating one as an owner would make a client's choice of value decide who a purchase belongs
   * to. This is the value a server wrote and a store returned unchanged.
   *
   * The route uses it to refuse a submission whose own reference names somebody else, before projecting it.
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
   * The reference this deployment attached when it created the purchase, echoed back — see
   * {@link VerifiedPurchase.accountReference} for why that is not the same as a rail naming a user.
   *
   * On a rail with no client-submission path this is the **only** way the account map is ever populated: a
   * Stripe webhook arrives carrying `cus_…`, and the pairing with a Pithy user exists nowhere else. The route
   * writes the link from this, and `linkProviderAccount` never rebinds, so the first pairing wins.
   */
  accountReference?: string | null;
  /**
   * Why an authentic notification produced no event, when that is worth recording — written to the webhook row's
   * `error` column so it is queryable and the reconciliation pass can act on it.
   *
   * Null when there is nothing to say, which is the common case: a test notification is exactly what it looks
   * like. It earns its place on the rails that *can* be authentically told about a purchase they cannot resolve
   * — Play's voided-purchase notification names no product, so the delivery is real, the refund is real, and
   * neither is projectable without a lookup only the Workflow can make. A row recording that with its reason is
   * the difference between a repairable gap and a silent drop.
   */
  note?: string | null;
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
}

/** What a hosted checkout session needs. The catalog product is resolved before this is called. */
export interface CheckoutSessionInput {
  /** The rail's own price identifier for the product being bought. */
  providerProductId: string;
  /** Whether this buys a recurring subscription or a one-off. Decides the hosted flow the store presents. */
  subscription: boolean;
  /** The authenticated purchaser, passed to the rail so its webhook arrives already bound to a user. */
  userId: string;
  /**
   * The store account this caller already has, from the provider-account map, or null on a first purchase.
   *
   * Passing it is what keeps one buyer to one store account. Without it every checkout creates a fresh
   * customer, and a user's second purchase would be invisible from the billing portal their first one made.
   */
  providerAccountId?: string | null;
  /** Where the store sends the browser after a completed purchase. */
  successUrl: string;
  /** Where the store sends the browser if the purchase is abandoned. */
  cancelUrl: string;
}

/** What a billing-portal session needs: the store account whose subscription is being managed. */
export interface PortalSessionInput {
  /** The store's own account identifier for the caller, resolved from the provider-account map. */
  providerAccountId: string;
  /** Where the store sends the browser when the user is done. */
  returnUrl: string;
}

/** A hosted page the client is sent to. Pithy never owns payment UI, SCA, tax, or proration. */
export interface HostedSession {
  /** The absolute URL to send the browser to. */
  url: string;
}

/**
 * The rails that *initiate* a purchase rather than merely hearing about one — Stripe, in v1.
 *
 * Deliberately separate from {@link PaymentsRailProvider}: see the module doc. A rail implements both
 * interfaces or only the first, and the route that needs a checkout session narrows to this one.
 */
export interface CheckoutRail {
  /** Create a hosted checkout session for one product. */
  createCheckoutSession(input: CheckoutSessionInput, context: RailRequestContext): Promise<HostedSession>;
  /** Create a hosted billing-portal session, where a subscriber manages or cancels. */
  createPortalSession(input: PortalSessionInput, context: RailRequestContext): Promise<HostedSession>;
}

/** Whether a rail provider also initiates purchases. The one narrowing `/checkout` and `/portal` need. */
export function isCheckoutRail(provider: PaymentsRailProvider): provider is PaymentsRailProvider & CheckoutRail {
  return (
    typeof (provider as Partial<CheckoutRail>).createCheckoutSession === "function" &&
    typeof (provider as Partial<CheckoutRail>).createPortalSession === "function"
  );
}
