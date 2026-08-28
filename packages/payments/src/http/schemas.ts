// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { EntitlementKey } from "@pithy-sh/core/src/entitlement/entitlement";
import { z } from "zod";
import { DiscountCode, DiscountTerms } from "../data/discount";
import { PurchaseEnvironment } from "../data/purchase";
import { PaymentsHostedRail, PaymentsRail } from "../data/rail";
import { PurchaseStatus } from "../data/status";
import { PaymentsSubject } from "../data/subject";
import { SubscriptionCancelTiming } from "../data/subscription";

/**
 * Everything a caller may send to a payments route, declared here and parsed on the route line. Reading a
 * route tells you what it accepts without opening the handler, and `c.req.valid()` is the only way a handler
 * can reach a body at all — the Biome plugin bans the raw accessors under `src/http/**`.
 *
 * ## What is deliberately absent
 *
 * **The subject.** Never a field on a route the adopter's own app calls, and this is the security core of
 * subject billing. A purchase belongs to whoever the project bills, resolved on the server — the
 * authenticated caller under `billingSubject: "user"`, and under `"organization"` whatever the adopter's
 * own resolver answers from its own session, because this package never learns what an organization is. A
 * body that could name a `subjectId` would let any signed-in caller buy, restore, or read against a holder
 * they have no membership of, and the capability has nothing to check that claim against: it has no
 * members table, by design. So the claim is never accepted. The control-plane schemas at the bottom are
 * the deliberate exception, and the exception is the feature: support acting on somebody else's account is
 * what they are for, which is why they sit behind a default-denied scoped credential and are audited on
 * every write.
 *
 * **Half a subject.** Where a subject *is* named, both halves are, because nothing keeps an organization
 * id from equalling some user's id — a filter or a grant carrying the id alone addresses whichever holder
 * happens to share it. The halves inherit their bounds from `PaymentsSubject` rather than restating them,
 * so a request can never carry an id a row would refuse.
 *
 * **The product.** Also never a field, and this one is easy to get wrong. The catalog product is resolved from
 * the *verified* payload's SKU, not from anything the client declared: a client-supplied `productId` would let
 * a caller present a cheap receipt as an expensive product. The client sends the store's artifact and nothing
 * about what it thinks it bought.
 *
 * **The environment.** The deployment's own, from `ENVIRONMENT`. A body naming it would be a sandbox purchase
 * asking to be treated as production.
 *
 * The size bounds are not decoration. A receipt is an unauthenticated string that gets base64-decoded and
 * DER-parsed, so bounding it bounds that work; the limits are generous against real StoreKit and Play
 * artifacts and still refuse a megabyte of nonsense before any parsing starts.
 */

/**
 * The longest receipt accepted. A StoreKit 2 signed transaction is a few kilobytes — its certificate chain is
 * most of it — and Google's purchase tokens are shorter. 16 KiB is roomy for both and small enough that a
 * flood of them cannot be a parsing denial of service.
 */
const MAX_RECEIPT_LENGTH = 16_384;

/** The most receipts one restore may carry. A store's entitlement list is short; a thousand is not a restore. */
const MAX_RESTORE_RECEIPTS = 50;

/** The longest a catalog product id may be, matching the SKU bound the catalog itself uses. */
const MAX_PRODUCT_ID_LENGTH = 200;

/** The longest a page cursor may be. Ours are a base64url'd pair; the bound refuses anything that is not. */
const MAX_CURSOR_LENGTH = 512;

export const PurchaseSubmission = z
  .object({
    rail: PaymentsRail.describe("Which store the receipt came from. Decides which verifier runs and nothing else."),
    receipt: z
      .string()
      .min(1)
      .max(MAX_RECEIPT_LENGTH)
      .describe(
        "The store's own artifact, exactly as its SDK returned it — a StoreKit 2 signed transaction, a Play purchase token. Everything about what was bought is read from inside it after it verifies, never from the request.",
      ),
  })
  .describe(
    "A client submitting one purchase for verification. Who holds it is the server's answer, never the request's.",
  );
export type PurchaseSubmission = z.infer<typeof PurchaseSubmission>;

export const RestoreRequest = z
  .object({
    rail: PaymentsRail.describe("Which store the history came from."),
    receipts: z
      .array(
        z.string().min(1).max(MAX_RECEIPT_LENGTH).describe("One store artifact from the caller's purchase history."),
      )
      .min(1)
      .max(MAX_RESTORE_RECEIPTS)
      .describe(
        "The caller's current store entitlements, as the store's own artifacts. Restore is client-driven because only the device can enumerate what its store account owns.",
      ),
  })
  .describe("A client re-submitting its store purchase history, to bind it to the subject the server resolves.");
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/**
 * Apple's webhook body. The Apple rail declares the same one field for itself, because it parses the bytes in
 * order to verify them and must not import across the HTTP seam to do it. Change one, change the other.
 */
export const AppleWebhookNotification = z
  .object({
    signedPayload: z
      .string()
      .min(1)
      .describe(
        "The App Store Server Notification V2, as a compact JWS. The guard has already verified it against Apple's pinned certificate chain by the time a handler reads this.",
      ),
  })
  .describe("The body Apple POSTs to the notification endpoint. One field, carrying everything.");
export type AppleWebhookNotification = z.infer<typeof AppleWebhookNotification>;

/**
 * What a caller may ask to buy: a catalog product id, and nothing else.
 *
 * No price, no amount, no currency, no return URL. The price comes from the catalog entry the id resolves to,
 * and the return URLs come from config — a client that could name where hosted Checkout returns to could send a
 * paying customer to a page it controls, and a client that could name a price could buy Pro for the price of a
 * coin pack. The purchaser is the subject the server resolves for the caller, as everywhere else.
 */
export const CheckoutRequest = z
  .object({
    productId: z
      .string()
      .min(1)
      .max(MAX_PRODUCT_ID_LENGTH)
      .describe(
        "The logical catalog product to buy — the key in `products`, never a store SKU. Resolved against config, so an unknown one is a 404 rather than a bad request.",
      ),
    rail: PaymentsHostedRail.optional().describe(
      "Which hosted-checkout rail to buy through. Omit it when the product sells on one, which is the common case. A client may name this because a rail is not a price and not a purchaser — it decides who takes the money, not how much or on whose behalf — so a paywall offering more than one can put a button on the page for each.",
    ),
    discountCode: DiscountCode.optional().describe(
      "A discount code to apply, passed to the store unchanged. A client may send this because the store decides what it is worth and whether it is valid — Pithy never computes a discounted amount, so a code here can only ever ask the provider a question it was going to answer anyway.",
    ),
  })
  .describe("A caller asking to start hosted checkout for one catalog product.");
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/**
 * ## The subscription lifecycle requests
 *
 * Four routes, and between them they accept two fields. That is the design rather than an accident of
 * scope, and each absence below is load-bearing.
 *
 * **No subscription.** The route resolves it from the caller's own purchase rows, and there is no field
 * a caller could send that would widen that set. A `subscriptionId` here would be a value a client
 * supplies, and a value a client supplies is one they can point at somebody else's subscription — which
 * this capability could not refuse, because it holds no members table and no ownership graph to check
 * the claim against. The refusal has to be structural, exactly as `SubscriptionChangeInput` states it
 * for the rail below.
 *
 * **No price.** {@link SubscriptionChangeRequest} names the *logical catalog product*, as
 * {@link CheckoutRequest} does and for the same reason: a body-named `pri_…` moves a customer onto a
 * plan this project does not sell, at a price it did not set. The catalog resolves the store's own
 * identifier, server-side, after the product is known to exist.
 *
 * **No rail.** {@link CheckoutRequest} may name one because a rail is not a price and not a purchaser —
 * it decides who takes the money on a purchase that has not happened yet. A subscription that already
 * exists lives at exactly one store, and its own row says which. A named rail here could only ever be
 * the wrong store asked about somebody's subscription.
 *
 * **No proration mode, and no `on_payment_failure`.** The rail picks the mode from the direction of the
 * change and always prevents a change that cannot be paid for; `data/subscription.ts` holds the longer
 * argument. Modeling either would make it a field, a field is a thing a client can set, and the value a
 * client would eventually set is Paddle's `do_not_bill` — a free upgrade. It is unreachable because
 * there is nowhere to write it.
 *
 * **No body at all on `keep`.** Withdrawing a scheduled cancellation takes no parameters: which
 * subscription is the server's answer, and there is nothing to say about it but *do not*. So that route
 * declares no schema and no `zValidator("json", …)`, exactly as `POST {base}/portal` does. A
 * `z.object({})` would read as a refusal of everything and be neither — Zod strips rather than refuses —
 * while making a POST with no body at all a 400 on a route that wants nothing.
 */

/**
 * What a caller may move their subscription to: a catalog product id, and nothing else.
 *
 * The same one field {@link CheckoutRequest} leads with, bounded the same way, and meaning the same
 * thing: the key in `products`, never a store SKU and never a price. An unknown one is a 404 on the
 * product rather than a bad request, because whether this project sells something is a config-backed
 * lookup and a schema constrains a string.
 */
export const SubscriptionChangeRequest = z
  .object({
    productId: z
      .string()
      .min(1)
      .max(MAX_PRODUCT_ID_LENGTH)
      .describe(
        "The logical catalog product to move to — the key in `products`. The route resolves the store's own price from it, so a caller can only ever ask for a plan this project sells.",
      ),
  })
  .describe("A caller asking to move their own subscription onto one catalog product.");
export type SubscriptionChangeRequest = z.output<typeof SubscriptionChangeRequest>;

/**
 * What a caller may ask a quote about — {@link SubscriptionChangeRequest} itself, under the name the
 * preview route line reads with.
 *
 * **The same value, not a copy of it.** A preview is the change with the commit removed: it asks the
 * provider what moving to this product would cost and takes nothing. Two objects that must stay
 * identical are two objects that will not — and the shape of that drift is a preview accepting a field
 * the change refuses, quoting a customer a figure the commit then cannot honor. `schemas.test.ts`
 * asserts the identity, so this stays an alias rather than becoming a second declaration.
 */
export const SubscriptionPreviewRequest = SubscriptionChangeRequest;
export type SubscriptionPreviewRequest = SubscriptionChangeRequest;

/**
 * When a cancellation takes effect. One field, and it is the customer's word rather than the store's.
 *
 * **Required, with no default.** `at_period_end` is the settled policy, and a default is still the
 * wrong shape for it: the two timings are different things to buy — keep the period already paid for,
 * or lose it today — and a body that omits the field would be choosing one of them by silence. A caller
 * that means `at_period_end` says so, which is also what an audit row then records.
 *
 * The values come from `data/subscription.ts` rather than being spelled again here, so a third timing
 * cannot exist on the wire and not in the rail. Paddle's own `immediately` and `next_billing_period` do
 * not parse: the rail translates, and a request in the store's vocabulary means something upstream
 * stopped translating.
 */
export const SubscriptionCancelRequest = z
  .object({
    timing: SubscriptionCancelTiming.describe(
      "When the cancellation takes effect — `at_period_end` stops the renewal and lets the paid period run out, `now` ends access today. Stated rather than defaulted: ending somebody's access is not a choice made by omission.",
    ),
  })
  .describe("A caller ending their own subscription, and when they stop.");
export type SubscriptionCancelRequest = z.output<typeof SubscriptionCancelRequest>;

/**
 * The terms of a discount to mint. The one control-plane write that creates an object costing money.
 *
 * `DiscountTerms` carries the whole shape and its own cross-field rules — a repeating duration must state
 * the plan's billing interval, because Stripe counts months and Lemon Squeezy counts periods. The rail is
 * named here rather than inferred: minting is an administrative act against one store's dashboard, and
 * guessing which one would put a code where nobody was looking for it.
 */
export const AdminDiscountsQuery = z
  .object({
    rail: PaymentsHostedRail.describe(
      "Which store to list from. Required — a discount exists in one store, and the stores do not merge.",
    ),
  })
  .describe("A management client listing the discount codes one store holds.");
export type AdminDiscountsQuery = z.infer<typeof AdminDiscountsQuery>;

export const DiscountCreateRequest = z
  .object({
    rail: PaymentsHostedRail.describe(
      "Which store to mint the discount at. Required — a discount exists in one store's dashboard.",
    ),
    terms: DiscountTerms.describe("The discount's terms, in customer-visible units."),
  })
  .describe("A management client minting one discount code.");
export type DiscountCreateRequest = z.input<typeof DiscountCreateRequest>;

/**
 * Google's webhook body: a Pub/Sub push, not a Play notification.
 *
 * The Google rail declares the same shape for itself, for the reason Apple's does — it decodes the bytes in order
 * to check them and must not import across the HTTP seam to do it. Change one, change the other.
 *
 * **The proof is not in here.** A Pub/Sub push body carries no signature at all: authenticity is the OIDC token
 * in the `Authorization` header, which the guard has already verified by the time a handler reads this. So this
 * validator's job is only to say the body is shaped like a push, which is what keeps a malformed one a 400 rather
 * than something a handler has to defend against.
 */
export const GoogleWebhookNotification = z
  .object({
    message: z
      .object({
        data: z
          .string()
          .min(1)
          .describe("The Play developer notification, base64-encoded. Decoded and checked by the guard."),
        messageId: z
          .string()
          .min(1)
          .describe("Pub/Sub's own message id — stable across redeliveries, which is what makes it the dedupe key."),
        publishTime: z.string().min(1).optional().describe("When Pub/Sub published the message, RFC 3339."),
      })
      .loose()
      .describe("The Pub/Sub message carrying one Play developer notification."),
    subscription: z
      .string()
      .min(1)
      .optional()
      .describe("The push subscription's resource name. Recorded for diagnosis; nothing is decided from it."),
  })
  .loose()
  .describe("The body Pub/Sub POSTs to the Google notification endpoint.");
export type GoogleWebhookNotification = z.infer<typeof GoogleWebhookNotification>;

/**
 * Stripe's webhook body: an event envelope.
 *
 * Shape-only, like Google's. **The proof is not in here** — it is the HMAC in the `Stripe-Signature` header, which
 * the guard has already checked against the exact received bytes by the time a handler reads this. So this
 * validator's job is to say the body is shaped like an event, which keeps a malformed one a 400 rather than
 * something a handler has to defend against. The Stripe rail declares the same shape for itself, in
 * `rails/stripe/objects.ts`, because it parses the bytes in order to read them and must not import across the
 * HTTP seam. Change one, change the other.
 */
export const StripeWebhookNotification = z
  .object({
    id: z.string().min(1).describe("The event id — `evt_…`. The dedupe key, stable across Stripe's retries."),
    type: z.string().min(1).describe("What happened — `customer.subscription.updated`."),
    created: z.number().int().describe("Stripe's own timestamp for the event, in seconds since the epoch."),
    data: z
      .object({ object: z.record(z.string(), z.unknown()).describe("The object the event is about.") })
      .loose()
      .describe("The event's payload."),
  })
  .loose()
  .describe("The body Stripe POSTs to the notification endpoint.");
export type StripeWebhookNotification = z.infer<typeof StripeWebhookNotification>;

/**
 * Lemon Squeezy's webhook body: a JSON:API envelope with the event name in `meta`.
 *
 * The rail declares the same shape for itself, for the reason Apple's and Google's do — it reads the bytes in
 * order to check them and must not import across the HTTP seam to do it. Change one, change the other.
 *
 * **The proof is not in here.** Authenticity is the bare HMAC in `X-Signature`, which the guard has verified
 * over the exact received bytes before this validator parses anything. So this validator's job is only to say
 * the body is shaped like a delivery, which keeps a malformed one a 400 rather than something a handler has to
 * defend against.
 */
export const LemonSqueezyWebhookNotification = z
  .object({
    meta: z
      .object({
        event_name: z.string().min(1).describe("What happened — `subscription_payment_success`, `order_created`."),
      })
      .loose()
      .describe("The delivery's metadata, including anything this deployment asked to have echoed back."),
    data: z
      .object({
        id: z.string().min(1).describe("The object's id. An integer as a string, and unique only within its type."),
        type: z.string().min(1).describe("Which type that id belongs to — `orders`, `subscriptions`."),
      })
      .loose()
      .describe("The object the event is about."),
  })
  .loose()
  .describe("The body Lemon Squeezy POSTs to the notification endpoint.");
export type LemonSqueezyWebhookNotification = z.infer<typeof LemonSqueezyWebhookNotification>;

/**
 * Paddle's webhook body: an event envelope carrying its own id, its type, when it happened, and the entity.
 *
 * The rail declares the same shape for itself, for the reason every other rail's does — it reads the bytes
 * in order to check them and must not import across the HTTP seam to do it. Change one, change the other.
 *
 * **The proof is not in here.** Authenticity is the timestamped HMAC in `Paddle-Signature`, which the guard
 * has verified over the exact received bytes before this validator parses anything. So this validator's job
 * is only to say the body is shaped like a delivery, which keeps a malformed one a 400 rather than something
 * a handler has to defend against.
 */
export const PaddleWebhookNotification = z
  .object({
    event_id: z.string().min(1).describe("Paddle's own id for the event — `evt_…`. The dedup key."),
    event_type: z.string().min(1).describe("What happened — `transaction.completed`, `subscription.canceled`."),
    occurred_at: z.string().min(1).describe("When it happened. The watermark, off the envelope and never the entity."),
    data: z.record(z.string(), z.unknown()).describe("The entity the event is about."),
  })
  .loose()
  .describe("The body Paddle POSTs to a notification destination.");
export type PaddleWebhookNotification = z.infer<typeof PaddleWebhookNotification>;

/**
 * A control-plane grant: who, which entitlement, and for how long.
 *
 * One of the two places in this package where a subject is a request field, and the only reason it is legal
 * is the gate ahead of it — a manual grant is support acting on somebody else's holding, so naming that
 * holder is the whole point. Every player-facing route resolves the subject on the server precisely because
 * a body that could name one would let any signed-in caller write against another. Here that power *is* the
 * feature, which is why the route requires a default-denied scoped control-plane credential and audits the
 * write.
 *
 * **Both halves, and the type is named rather than assumed.** The row this writes is keyed
 * `(subjectType, subjectId, entitlement)` and is read back by the same pair, so a grant that carried an id
 * alone would land on whichever holder shares it. Whether the named kind is the one this project bills is a
 * config-backed question and stays where the entitlement key's own catalog check is, in the handler: a
 * schema constrains a string, it never replaces a lookup.
 *
 * No product, no rail, no price. A manual grant is not a purchase and must not pretend to be one: it writes
 * the read model directly, with null provenance, and the purchase record stays empty because nothing was
 * bought.
 */
export const EntitlementGrantRequest = z
  .object({
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Which kind of holder to grant — the half that makes the id an address. Named, never assumed from the project's `billingSubject`, so what an audit row records is what a management client asked for.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject to grant. Support acts on somebody else's holding, so this is one of the two routes where the subject is a request field rather than the server's own answer.",
    ),
    entitlement: EntitlementKey.describe(
      "The entitlement key to grant, as gating code names it. Not a store SKU. It must be one this project defines — a key some product grants, or one the adopter declared in `manualEntitlements` — and anything else is a 400 naming the key. Comping a key nothing sells is still the durable case; declaring it is how a project says so.",
    ),
    expiresAt: JsonDate.optional().describe(
      "When the grant lapses, as an ISO 8601 timestamp. Omit for a comp that never ends. A past timestamp writes a row that grants nothing, which is a slower way of revoking.",
    ),
  })
  .describe("A control-plane request to grant one entitlement to one subject, with no purchase behind it.");
export type EntitlementGrantRequest = z.output<typeof EntitlementGrantRequest>;

/**
 * A control-plane revoke: who, and which entitlement.
 *
 * No expiry, because a revoke is immediate — the read model is the truth every gate hits, so the subject
 * loses access on the next request rather than at the end of a period. Revoking a key the subject never held
 * is legal and idempotent: the inactive row is itself the record that somebody decided it.
 */
export const EntitlementRevokeRequest = z
  .object({
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Which kind of holder to revoke from. Half the address: a revoke aimed at an id alone would clear whichever holder shares it, which is an outage for somebody who paid.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject to revoke. As with the grant, the subject is named because support is acting on somebody else's holding.",
    ),
    entitlement: EntitlementKey.describe("The entitlement key to revoke, as gating code names it."),
  })
  .describe("A control-plane request to revoke one entitlement from one subject, effective immediately.");
export type EntitlementRevokeRequest = z.output<typeof EntitlementRevokeRequest>;

/**
 * ## The management read queries
 *
 * The `Admin*` shapes below belong to the **control-plane reads**, which take no bodies at all: there is
 * nothing for a client to send but filters and a place to resume.
 *
 * **Every filter is a closed enum of payments' own values, not a lookup against the adopter's config**,
 * and that is the deliberate difference from `@pithy-sh/ledger`'s currency filter. A rail, a status and a
 * store environment are the kit's own vocabulary — an unknown one is a *malformed request*, so the
 * validator refuses it with a 400 naming the accepted set. A currency, a product id or an entitlement key
 * is the adopter's, so a value that parses but is not configured is a missing resource and stays the
 * handler's 404. A schema constrains a string; it never replaces a lookup, and it is never built from a
 * configured key set.
 */

/** Where a keyset page resumes. Opaque; a malformed one is a first page rather than an error. */
const Cursor = z
  .string()
  .max(MAX_CURSOR_LENGTH)
  .optional()
  .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page.");

/** How many rows one page returns. Bounded, because a verified client can still have a bug. */
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`How many rows to return, from 1 to ${MAX_PAGE_SIZE}. Defaults to a page a dashboard can render.`);

/**
 * The owner filter on a management listing: both halves of a subject, or neither.
 *
 * **Two optional fields with a rule, rather than one field.** A query string is flat, so the pair arrives as
 * two values and the rule is what keeps them one fact. An id without a kind is the dangerous half — the
 * listing would narrow on `subject_id` alone and hand back an organization's purchases to a client that
 * asked about a person, whenever an adopter's two id spaces happen to meet on a value. A kind without an id
 * is merely useless, and it is refused with it because "or neither" is a rule somebody can hold in their
 * head and "or neither, unless" is not.
 *
 * Refused rather than ignored. A filter that silently did nothing would render as *this holder bought
 * everything on the page*, which is worse than a 400 naming what to send.
 */
const SUBJECT_FILTER = {
  subjectType: PaymentsSubject.shape.subjectType
    .optional()
    .describe("Which kind of holder to narrow to. Send it with `subjectId` or send neither."),
  subjectId: PaymentsSubject.shape.subjectId
    .optional()
    .describe(
      "Which holder to narrow to. Send it with `subjectType` or send neither: an id alone names whichever user or organization happens to carry it.",
    ),
};

/** Both halves of the subject filter, or neither. See {@link SUBJECT_FILTER}. */
function subjectFilterIsWhole(query: { subjectType?: string; subjectId?: string }): boolean {
  return (query.subjectType === undefined) === (query.subjectId === undefined);
}

/** What a caller is told when they send one half. Names the remedy, because the remedy is the other field. */
const SUBJECT_FILTER_RULE = {
  message: "Send `subjectType` and `subjectId` together, or neither. Half a subject names no holder.",
} as const;

export const AdminPurchasesQuery = z
  .object({
    ...SUBJECT_FILTER,
    rail: PaymentsRail.optional().describe("Restrict the listing to one store."),
    status: PurchaseStatus.optional().describe("Restrict the listing to one normalized status."),
    environment: PurchaseEnvironment.optional().describe(
      "Restrict the listing to one store environment. Unfiltered by default: hiding sandbox transactions by default would hide the thing an operator most needs to notice.",
    ),
    cursor: Cursor,
    limit: Limit,
  })
  .refine(subjectFilterIsWhole, SUBJECT_FILTER_RULE)
  .describe("The purchase-log query: what to narrow it to, and where to resume.");
export type AdminPurchasesQuery = z.output<typeof AdminPurchasesQuery>;

export const AdminSubscriptionsQuery = z
  .object({
    ...SUBJECT_FILTER,
    status: PurchaseStatus.optional().describe(
      "Restrict the listing to one normalized status — `active` for who is paying now, `in_grace` for whose renewal is failing.",
    ),
    cursor: Cursor,
    limit: Limit,
  })
  .refine(subjectFilterIsWhole, SUBJECT_FILTER_RULE)
  .describe(
    "The subscription query: what to narrow it to, and where to resume. No rail — a subscription is read forwards, not by store.",
  );
export type AdminSubscriptionsQuery = z.output<typeof AdminSubscriptionsQuery>;

export const AdminEntitlementsQuery = z
  .object({
    ...SUBJECT_FILTER,
    entitlement: EntitlementKey.optional().describe(
      "Restrict the listing to one entitlement key — the `who holds pro` question. A shape check only: the key set is the adopter's, and one nothing grants is an empty page rather than a refusal.",
    ),
    cursor: Cursor,
    limit: Limit,
  })
  .refine(subjectFilterIsWhole, SUBJECT_FILTER_RULE)
  .describe("The entitlement query: what to narrow it to, and where to resume.");
export type AdminEntitlementsQuery = z.output<typeof AdminEntitlementsQuery>;

export const AdminReconcileRunsQuery = z
  .object({
    rail: PaymentsRail.optional().describe(
      "Restrict to the passes narrowed to one store. A scheduled pass runs against every rail and carries no rail, so this never matches one.",
    ),
    environment: PurchaseEnvironment.optional().describe(
      "Restrict to one store environment — the sandbox host and the production host each keep their own passes.",
    ),
    cursor: Cursor,
    limit: Limit,
  })
  .describe("The reconciliation-run query: what to narrow it to, and where to resume.");
export type AdminReconcileRunsQuery = z.output<typeof AdminReconcileRunsQuery>;

/**
 * The two path segments on the per-subject management read: `…/entitlements/:subjectType/:subjectId`.
 *
 * **Two segments, not one encoded reference.** `encodeSubjectReference` exists for the single-field slots a
 * store gives us — Apple's `appAccountToken`, Stripe's `client_reference_id` — where there is exactly one
 * string to write and it comes back through a webhook. A URL has as many segments as it needs, and the
 * decoder for that wire format answers `undefined` for anything it does not recognize, which on a path
 * would be a 404 that reads like a missing holder rather than the 400 a malformed address deserves. Two
 * validated segments say which half is wrong.
 *
 * Neither is optional, because half an address is not a narrower read: it is a different holder.
 */
export const AdminSubjectParam = z
  .object({
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Which kind of holder to resolve — the `:subjectType` path segment. A closed enum, so an unknown kind is a 400 naming the two that exist.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "Whose entitlements to resolve — the `:subjectId` path segment. Opaque to payments: whatever id the adopter's auth capability or its own membership model issued.",
    ),
  })
  .describe("The `:subjectType/:subjectId` path segments on the per-subject management read.");
export type AdminSubjectParam = z.output<typeof AdminSubjectParam>;
