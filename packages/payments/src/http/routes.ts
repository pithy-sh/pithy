// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { safeEmit } from "@pithy-sh/core/src/controlPlane/audit/actions";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { InternalError, NotFoundError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { Context, Hono } from "hono";
import { listEntitlements, listPurchases, listReconcileRuns, listSubscriptions, readEntitlements } from "../admin/read";
import { type PaymentsAuditAction, PaymentsAuditActions } from "../audit/actions";
import {
  type PaymentsCatalogEntry,
  type PaymentsConfig,
  type PaymentsStripeSettings,
  providerProductId,
  railEnabled,
  resolveProduct,
} from "../config/config";
import type { PaymentsEntitlement } from "../data/entitlement";
import type { PurchaseEnvironment } from "../data/purchase";
import { PaymentsPurchase } from "../data/purchase";
import { PAYMENTS_HOSTED_RAILS, type PaymentsRail } from "../data/rail";
import type { PurchaseStatus } from "../data/status";
import {
  decodeSubjectReference,
  encodeSubjectReference,
  type PaymentsSubject,
  type PaymentsSubjectType,
  sameSubject,
} from "../data/subject";
import {
  nextSubscriptionEvent,
  type RefundRequest,
  type SubscriptionChangeQuote,
  type SubscriptionStanding,
} from "../data/subscription";
import { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } from "../data/tables";
import { WEBHOOK_EVENT_ORPHANED } from "../data/webhookEvent";
import { grantEntitlement, revokeEntitlement } from "../entitlement/manual";
import { type PaymentsSubjectSeam, requirePaymentsSubject, resolvePaymentsSubject } from "../entitlement/subjectSeam";
import {
  PaymentsEntitlementNotInCatalogError,
  PaymentsProductNotFoundError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
  PaymentsSubscriptionChangeRefusedError,
} from "../error/errors";
import { fulfillPurchase } from "../grants/apply";
import { repairOrphanedEvents } from "../projection/orphans";
import { linkProviderAccount, providerAccountForSubject, resolveNotificationOwner } from "../projection/owner";
import { resolveEntitlements } from "../projection/resolve";
import { type PurchaseProjection, projectPurchase } from "../projection/writer";
import {
  type CheckoutRail,
  isCheckoutRail,
  isDiscountRail,
  isPricingRail,
  isRefundRail,
  isSubscriptionRail,
  noteText,
  type PaymentsRailProvider,
  type RefundRail,
  type SubscriptionRail,
} from "../rails/contract";
import { type RailTrustOptions, resolveRailProvider } from "../rails/providers";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";
import { requireAuth } from "./guards";
import type {
  PaymentsAdminCatalogResponse,
  PaymentsAdminDiscountsResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminReconcileRunsResponse,
  PaymentsAdminSubjectEntitlementsResponse,
  PaymentsAdminSubscriptionsResponse,
  PaymentsCheckoutHandoffResponse,
  PaymentsDiscountResponse,
  PaymentsEntitlementResponse,
  PaymentsEntitlementsResponse,
  PaymentsPortalHandoffResponse,
  PaymentsPricingEnvelope,
  PaymentsPricingResponse,
  PaymentsPurchaseResponse,
  PaymentsQuotedFrom,
  PaymentsRefundRequest,
  PaymentsRefundResponse,
  PaymentsRestoreResponse,
  PaymentsSubscriptionQuote,
  PaymentsSubscriptionQuoteResponse,
  PaymentsSubscriptionResponse,
  PaymentsSubscriptionStandingResponse,
  PaymentsSubscriptionView,
} from "./responses";
import {
  AdminDiscountsQuery,
  AdminEntitlementsQuery,
  AdminPurchasesQuery,
  AdminReconcileRunsQuery,
  AdminSubjectParam,
  AdminSubscriptionsQuery,
  AppleWebhookNotification,
  CheckoutRequest,
  DiscountCreateRequest,
  EntitlementGrantRequest,
  EntitlementRevokeRequest,
  GoogleWebhookNotification,
  LemonSqueezyWebhookNotification,
  PaddleWebhookNotification,
  PurchaseSubmission,
  RestoreRequest,
  StripeWebhookNotification,
  SubscriptionCancelRequest,
  SubscriptionChangeRequest,
  SubscriptionPreviewRequest,
} from "./schemas";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./scopes";
import {
  adminCatalogView,
  adminEntitlementView,
  adminPurchaseView,
  adminReconcileRunView,
  entitlementView,
  purchaseView,
} from "./view";
import { completeWebhook, requireSignedWebhook, verifiedWebhook } from "./webhookGuard";

/**
 * The payments routes, their declared verification strategies, and what each accepts.
 *
 * **This list is prose, and it had rotted.** It named sixteen of the twenty-one routes mounted before #465 —
 * `GET /pricing`, two webhook rails and both discount routes had landed without a line here — which is the
 * same failure the README's Routes table had before a gate held it, and for the same reason: a list that is
 * merely *near* the code is a list nothing compares. It was brought level with the registrations as part of
 * #465 and every mounted route is below, but **nothing holds it there**: the gated inventories are the
 * README's Routes table and the `mountedRoutes` pin in `routeContract.test.ts`, checked in both directions
 * against the real registrations. Read those as the record; edit this one by hand and expect it to rot again.
 *
 *   POST /payments/purchases              → verify a receipt, project it     (bearer | session)  json: PurchaseSubmission
 *   GET  /payments/entitlements           → the caller's entitlements        (bearer | session)  —
 *   POST /payments/restore                → rebind store history             (bearer | session)  json: RestoreRequest
 *   GET  /payments/pricing                → what the caller's subscription pays, and when that changes
 *                                                                            (bearer | session)  —
 *   POST /payments/checkout               → a hosted checkout, on whichever rail sells the product
 *                                                                            (bearer | session)  json: CheckoutRequest
 *   POST /payments/portal                 → a billing-portal session         (bearer | session)  —
 *   GET  /payments/subscription           → where the caller's subscription stands, read live
 *                                                                            (bearer | session)  —
 *   POST /payments/subscription/preview   → what a move would cost           (bearer | session)  json: SubscriptionPreviewRequest
 *   POST /payments/subscription/change    → move it onto a catalog product   (bearer | session)  json: SubscriptionChangeRequest
 *   POST /payments/subscription/cancel    → stop it renewing                 (bearer | session)  json: SubscriptionCancelRequest
 *   POST /payments/subscription/keep      → withdraw a scheduled cancel      (bearer | session)  —
 *   POST /payments/subscription/refund    → ask for its payments back        (bearer | session)  —
 *   POST /payments/webhooks/apple         → ASSN V2                          (signed-webhook)    json: AppleWebhookNotification
 *   POST /payments/webhooks/google        → Play RTDN via Pub/Sub push       (signed-webhook)    json: GoogleWebhookNotification
 *   POST /payments/webhooks/stripe        → Stripe events                    (signed-webhook)    json: StripeWebhookNotification
 *   POST /payments/webhooks/lemon-squeezy → Lemon Squeezy events             (signed-webhook)    json: LemonSqueezyWebhookNotification
 *   POST /payments/webhooks/paddle        → Paddle events                    (signed-webhook)    json: PaddleWebhookNotification
 *   POST /payments/entitlements/grant     → comp or repair an entitlement    (control-plane)     json: EntitlementGrantRequest
 *   POST /payments/entitlements/revoke    → take one back                    (control-plane)     json: EntitlementRevokeRequest
 *
 *   GET  /payments/admin/catalog                → what this project sells        (control-plane: payments:catalog:read)        —
 *   GET  /payments/admin/purchases              → the purchase log, paged        (control-plane: payments:purchases:read)      query: AdminPurchasesQuery
 *   GET  /payments/admin/subscriptions          → the purchases that renew       (control-plane: payments:subscriptions:read)  query: AdminSubscriptionsQuery
 *   GET  /payments/admin/entitlements           → the entitlement model, paged   (control-plane: payments:entitlements:read)   query: AdminEntitlementsQuery
 *   GET  /payments/admin/entitlements/:subjectType/:subjectId
 *                                              → one subject's entitlements     (control-plane: payments:entitlements:read)   param: AdminSubjectParam
 *   GET  /payments/admin/reconcile-runs         → the reconciliation run log     (control-plane: payments:reconcile:read)      query: AdminReconcileRunsQuery
 *   GET  /payments/admin/discounts              → the codes this project issued  (control-plane: payments:discounts:read)      query: AdminDiscountsQuery
 *   POST /payments/admin/discounts              → mint one at a store            (control-plane: payments:discounts:create)    json: DiscountCreateRequest
 *
 * **The reads exist because the writes did.** Payments shipped `entitlements/grant` and
 * `entitlements/revoke` with no read beside them, so a management client could comp an entitlement and take
 * one back and could never list one — and a dashboard's Purchases, Entitlements and Subscriptions panes
 * computed *absent* against a live manifest and dropped out of the rail entirely. Not blocked, not refused:
 * absent, which no grant and no seed can repair, because there was no route to grant a scope to (#247).
 *
 * **They sit under `admin/` because the player surface owns the bare paths.** `GET ${base}/entitlements` is
 * already a bearer route reading the caller's own; a control-plane read at the same address would sit behind
 * whichever Hono matched first, with a route's gate decided by registration order. The extra segment makes
 * the two sets disjoint by construction.
 *
 * **One `POST` among them, and it is the exception that states the rule.** Every `admin/` route is a read
 * except `POST ${base}/admin/discounts`, which mints a code at a store — a write with a cost attached, so it
 * carries its own scope, `payments:discounts:create`, granted separately from the `payments:discounts:read`
 * on the listing beside it, and its own audit event. The three writes this capability offers a management
 * client are grant, revoke and mint; each is separately scoped, and nothing here widens any of them.
 *
 * That one path serving two methods is also why `routeContract.test.ts` pins `METHOD /path` rather than the
 * path: a `POST ${base}/admin/purchases` mounted beside the read would be a write nobody declared, sitting
 * on a path the pin already contained.
 *
 * **The two control-plane routes are the only way an entitlement appears without money moving**, and that is
 * the whole reason they are gated the way they are. Each wears core's `requireControlPlane()` and nothing
 * else: an EdDSA-signed token on the `pithy-control-plane` header, verified against a public key the adopter
 * registered, bound to one connection, one environment, one request body and one use — and carrying the single
 * scope that route needs, `payments:entitlements:grant` or `payments:entitlements:revoke`. The two are granted
 * separately, so a refund tool cannot comp and a comp tool cannot revoke.
 *
 * **`requireAuth()` is deliberately absent from those two lines, and adding it would break them.** A
 * management client is not a user of this app; the seam never populates `c.var.auth`, precisely so that a
 * control-plane credential cannot satisfy an ordinary `requireAuth()` anywhere in the tree. An auth gate here
 * would deny every legitimate management call and no credential could fix it. With the seam not composed at
 * all the gate raises `controlplane/not_connected`, so the routes are shut rather than open. Both writes are
 * audited to the management client, because the trail is the only record of who decided an account should have
 * something nobody paid for.
 *
 * `POST /payments/purchases` and `/restore` serve every rail with no branch of their own: the rail a caller names
 * selects a verifier through `resolveRailProvider`, and everything past that point is the normalized event. A
 * rail arriving is one entry in `rails/providers.ts`, not a case in a handler.
 *
 * **No `public` routes, ever.** Every caller is either an authenticated user acting on their own purchases or a
 * machine proving authenticity. Turnstile has nothing to gate here.
 *
 * **`signed-webhook` is one strategy over three unrelated mechanisms** — Apple signs a JWS against its
 * certificate chain, Google's Pub/Sub push carries an OIDC token verified with an audience check, Stripe sends
 * an HMAC. Each has its own verifier, which is why these are literal routes rather than one `:rail`: a single
 * route line could not carry three of them, and the rail a caller *claims* is not something to route on.
 *
 * **`/checkout` and `/portal` are Stripe's alone, and they are not a fourth strategy.** Apple and Google
 * purchases happen inside a store SDK before the server hears of them, so there is no session for Pithy to
 * create; Stripe's are ones Pithy initiates. The routes narrow to {@link CheckoutRail} rather than branching on
 * the rail name, so a rail is never asked for something it does not do — and with Stripe off they raise
 * `payments/rail_not_configured`, which reads as "that payment method is not available here" rather than as a
 * broken endpoint.
 *
 * **The five subscription routes are one surface with one rule: nothing a caller sends names anything.**
 * The subscription comes from that caller's own purchase rows, the rail from the row it found, and the
 * store's price from the catalog by logical product id. A body-named subscription moves somebody else's — a
 * claim this capability could not check, because it holds no members table by design — and a body-named
 * price moves a customer onto a plan this project does not sell, at a price it did not set. Neither is
 * refused by a check; both are unreachable because there is nowhere to write them.
 *
 * **The read shipped before the four verbs, deliberately and in its own step.** `GET ${base}/subscription`
 * is the answer to the #247 paragraph below, applied before the mistake could repeat: a capability that can
 * cancel a subscription and cannot report the cancellation ships the half that creates the support ticket,
 * and Paddle leaves `status` at `active` with a blank next billing date when one is scheduled.
 *
 * **None of the four writes touches the projection.** The webhook owns the purchase row; a route that wrote
 * it too would be a second producer of one row, and the two disagree the first time a webhook is late. So
 * each verb answers the *store's* own report of where the subscription now stands, rather than a prediction
 * of it — a prediction is how a customer sees a plan they are not on.
 *
 * **Validators sit after the guards on every route line.** A validator ahead of a guard turns a 401 into a 400
 * and tells an unauthenticated caller which of its requests were well-formed. Config-backed resolution stays in
 * the handler and raises its own domain 404 — a schema constrains a string, it never replaces a lookup.
 *
 * ## What the handlers never trust
 *
 * The **product** comes from the verified payload's SKU, never from the request. A client-supplied product id
 * would let a caller present a cheap receipt as an expensive product. The **owner** comes from the subject
 * seam on the authed routes and from the provider-account map on the webhook, never from a body. The
 * **environment** comes from this deployment's own `ENVIRONMENT` var, never from the payload: inferring it
 * from what the store said is exactly what lets a sandbox purchase grant a real entitlement.
 *
 * ## Who a request is about: one question, one implementation
 *
 * Every route here that touches a holder asks the subject seam, and asks it in one of exactly two ways.
 * A **read** calls {@link resolvePaymentsSubject}: nobody resolved is an empty or denied read, never a 500 and
 * never a guess, because a gate that resolved *something* when it could not tell who was asking would hand one
 * holder's plan to whoever asked next. A **write** calls {@link requirePaymentsSubject}, which refuses with
 * `payments/subject_unresolved` (403): a purchase, a restore, a checkout and a portal session each need a row
 * key, and a guessed key attributes real money to the wrong holder.
 *
 * **Nothing here falls back to `c.var.auth.userId`, in either mode.** Under `billingSubject: "user"` the
 * fallback would be identical to the seam's own default and would therefore look harmless; under
 * `"organization"` it would silently key a company's subscription to whichever employee happened to be signed
 * in. One expression, in `entitlement/subjectSeam.ts`, is what keeps the gate and the routes answering the
 * same question — a second copy is a second policy, and the two disagree the day one of them is edited.
 *
 * **No player-facing request names a subject, and no player-facing response publishes one.** A body or a query
 * that could name a holder is a body that could name somebody else's, and this capability has nothing to check
 * that claim against: it has no members table, by design. The control-plane surfaces are the deliberate
 * exception, and the exception is the feature — support acting on another holder's account is what they are
 * for, which is why each sits behind a default-denied scoped credential and is audited. `schemas.ts` states
 * the same rule from the request side, and `routeContract.test.ts` asserts it as a property over every schema
 * and every response this capability declares, rather than route by route.
 */
export interface PaymentsRoutesOptions {
  /** The resolved catalog. */
  config: PaymentsConfig;
  /** Where the routes mount. Defaults to the config's own `basePath`. */
  basePath?: string;
  /** The clock. Injected so verification windows and stored timestamps are deterministic in tests. */
  now?: () => Date;
  /**
   * Certificate roots to accept *in addition to* each rail's pinned ones. Absent in production, and additive
   * only — no caller can narrow the trust set. See {@link RailTrustOptions} for the two callers that need it.
   */
  trust?: RailTrustOptions;
  /**
   * Which subject a caller is acting for: the mode, and the adopter's resolver. See
   * `entitlement/subjectSeam.ts`.
   *
   * **Handed in whole rather than assembled here**, because `payments()` builds exactly one of these and
   * gives the same object to the entitlement middleware and to these routes. Two constructions are two
   * policies, and the two disagree the day one of them is edited.
   *
   * **The resolver rides on this rather than on `PaymentsConfig`, and that is a hard constraint rather than a
   * preference.** `provision/resolvePaymentsConfig.ts` serializes the resolved config into the
   * `PAYMENTS_CONFIG` var and `workflows/worker.ts` parses it back, so a function cannot survive the round
   * trip. The serializable half of the decision — `billingSubject`, which mode this project bills in — is
   * config; the callable half is a composition-time option.
   *
   * The consequence is worth stating out loud: **a Workflow runs with no adopter resolver.** The reconcile and
   * Paddle sweep hosts parse the config and never see this, so anything in them needing a holder reads it from
   * the stored row that already carries the pair, and never from the seam.
   *
   * Omitted means the config's own mode with no adopter resolver — the authenticated caller under
   * `billingSubject: "user"`, and nobody at all under `"organization"`. The default is the *same* derivation
   * `payments()` makes for a project that supplies none, never a different one, and `payments()` refuses to
   * compose organization billing without a resolver rather than reaching this state.
   */
  subject?: PaymentsSubjectSeam;
}

/** The app `DB` binding, or a wiring failure. Payments cannot resolve anything without it. */
function database(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!binding) {
    throw new InternalError({
      message: "Payments is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "Payments requires a `DB` D1 binding; none was present on env.",
    });
  }
  return binding;
}

/**
 * This deployment's store environment, from the `ENVIRONMENT` var.
 *
 * Only a Worker deployed to `prod` is production. Every other value — `staging`, `dev`, a var nobody
 * set — is sandbox, because the failure directions are not symmetric: treating production as sandbox loses a
 * purchase that reconciliation repairs, while treating sandbox as production hands out real entitlements for
 * test transactions. That is the single most common in-app-purchase security defect there is, and the default
 * is what decides it.
 */
function deploymentEnvironment(c: Context<PithyHonoEnv>): PurchaseEnvironment {
  return (c.env as Record<string, unknown>).ENVIRONMENT === "prod" ? "production" : "sandbox";
}

/**
 * This deployment's `ENVIRONMENT` var, verbatim, or undefined.
 *
 * Deliberately *not* {@link deploymentEnvironment}'s two-valued answer. A rail sharing one store across
 * every environment — Lemon Squeezy, whose test mode is a flag on an object rather than a separate store —
 * fences its webhooks on this, and `dev` and `staging` both evaluate to `sandbox`, so fencing on that would
 * separate neither. The two are different questions: one asks whether real money moved, this asks which
 * deployment is speaking.
 */
function deploymentName(c: Context<PithyHonoEnv>): string | undefined {
  const value = (c.env as Record<string, unknown>).ENVIRONMENT;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The locale a figure in this response is rendered for.
 *
 * **The translator seam, not the request.** `c.var.t` is always present — core seeds a translator over the
 * baked English when nothing composes `@pithy-sh/i18n`, and the capability replaces it with one negotiated
 * from the URL, the reader's account, a cookie and `Accept-Language` — so this is the same locale every
 * other string in the same response is written in. `@pithy-sh/email` sets the precedent, building a
 * per-recipient translator from a stored locale rather than a second rule of its own.
 *
 * **Not a request field and not a header read here.** A locale a caller can name in a body is a locale a
 * caller sets, and these are the routes whose rule is that nothing a caller sends names anything.
 * `Accept-Language` is already one of the four inputs the negotiation weighs, and reading it directly would
 * put the money in one language and the sentence around it in another.
 *
 * `formattingLocale` rather than `catalogLocale`: it is the tag `Intl` is meant to be handed, region and
 * all, so an `es-AR` reader gets `es-AR` grouping whether or not anybody wrote Spanish copy. The seam
 * documents that split at the field.
 */
function readerLocale(c: Context<PithyHonoEnv>): string {
  return c.var.t.formattingLocale;
}

/**
 * The subject filter on a management listing: the pair, or nothing at all.
 *
 * `AdminPurchasesQuery` and its siblings carry the two halves as two optional query fields with a both-or-
 * neither refinement, because a query string is flat. This is the one place that pair is reassembled, and the
 * `&&` is what makes an id with no kind resolve to *no filter* rather than to half of one. The refinement has
 * already refused that request with a 400 — a listing narrowed on `subject_id` alone would hand a client
 * asking about a person the rows of an organization that happens to share the id — so this is belt and braces
 * on the one narrowing where being wrong discloses somebody else's commerce.
 */
function subjectFilter(query: { subjectType?: PaymentsSubjectType; subjectId?: string }): PaymentsSubject | undefined {
  return query.subjectType !== undefined && query.subjectId !== undefined
    ? { subjectType: query.subjectType, subjectId: query.subjectId }
    : undefined;
}

/**
 * The verified management client behind a control-plane call. `requireControlPlane()` has run on every route
 * that calls this, so a null context is a wiring mistake rather than an unverified request — hence
 * `InternalError`, not a 401.
 *
 * Deliberately not the subject seam. A management client has no user row and no session, so there is nothing
 * here to read off `c.var.auth` and nothing for a resolver to answer; keeping the two apart is what stops a
 * control-plane caller from being recorded as, or mistaken for, a user of this app.
 */
function controlPlaneCaller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const caller = c.var.controlPlane;
  if (!caller) {
    throw new InternalError({
      detail: "requireControlPlane() must run before a payments handler reads the management caller.",
    });
  }
  return caller;
}

/** Every rail's credentials, read through the one reader at the point of need. */
async function credentials(c: Context<PithyHonoEnv>) {
  const secrets = await sharedSecretsStore(c.env as unknown as SecretsStoreEnv, paymentsSecretsRegistry);
  return secrets.get(PAYMENTS_PROVIDER_SECRET);
}

/**
 * The catalog product a caller named, or a 404. The catalog is config rather than rows, so an id nothing maps
 * is a missing resource — and the lookup stays in the handler, where it can raise its own domain error, rather
 * than being folded into a request schema built from the configured key set.
 */
function product(config: PaymentsConfig, id: string): PaymentsCatalogEntry {
  const found = resolveProduct(config, id);
  if (found === undefined) throw new PaymentsProductNotFoundError({ detail: `No product "${id}" is configured.` });
  return found;
}

/**
 * The statuses a subscription can still be *acted on* in — the filter {@link changeableSubscription} applies
 * before it counts anything.
 *
 * The set is "there is something left to do to this", not "this grants access", and the two differ at both
 * ends. It is stated positively rather than as a list of exclusions so that a status added later is inert
 * here until somebody decides it belongs, which is the safe direction: an unknown status silently joining an
 * actionable set is how a dead row starts competing with a live subscription.
 *
 * - **`active`** — the ordinary case.
 * - **`in_grace`** — a renewal that failed inside the retry window. The subscription exists at the store and
 *   a customer with a bounced card is precisely the customer who wants to downgrade or cancel.
 * - **`on_hold`** — the same, past the retry window. No rail implementing {@link SubscriptionRail} writes it
 *   today; it is here because a subscription nobody has ended is still one somebody may want to end.
 * - **`canceled`** — auto-renew off with the paid period still running. It **grants access**
 *   ({@link ACCESS_GRANTING_STATUSES}), so a holder in it still has what they paid for, and it is the only
 *   status `keepSubscription` can start from on the rails that write it while the schedule is pending.
 * - **`paused`** — suspended, not ended. Canceling a paused subscription is legitimate; a store that will
 *   not move one answers `payments/subscription_change_refused` with its own reason, which is a better
 *   sentence than this query pretending the subscription is not there.
 *
 * **The four that are absent are endings**, and every one of them is an ending the *store* declared:
 * `expired` (a period we were paid for, over), `never_paid` (terminated before money moved), `refunded` and
 * `revoked` (taken back). None of them can be changed, canceled or un-canceled, and counting one is how a
 * holder with a history of subscriptions becomes ambiguous forever.
 *
 * **Refusing on state is not this set's job.** A store that will not move a particular subscription is the
 * rail's 409, carrying the store's own reason; this filter only decides whether there is a subscription to
 * ask about at all. Widening the difference between the two is how a customer is told they have no
 * subscription when what is true is that this one cannot be upgraded today.
 */
const SUBSCRIPTION_ACTIONABLE_STATUSES: readonly PurchaseStatus[] = [
  "active",
  "in_grace",
  "on_hold",
  "canceled",
  "paused",
];

/**
 * Which subscription a change verb may act on — none, exactly one, or more than one.
 *
 * **A discriminated answer rather than `PaymentsPurchase | undefined`**, because the three cases are three
 * different sentences to a caller: nothing to change, here it is, and *this server will not choose for you*.
 * Collapsing the last into either of the others is the defect this whole helper exists to make impossible —
 * silently picking one of two live subscriptions moves a plan the customer did not name.
 */
export type SubscriptionTarget =
  | {
      /** The caller holds no subscription this server can act on. */
      found: "none";
    }
  | {
      /** Exactly one, and it is theirs. */
      found: "one";
      /** The row a {@link SubscriptionRail} is handed. The whole row — see `SubscriptionChangeInput.purchase`. */
      purchase: PaymentsPurchase;
    }
  | {
      /** More than one, so no verb can proceed without being told which. */
      found: "many";
      /** Every candidate, newest event first — so a refusal can say how many and on which rails. */
      purchases: readonly PaymentsPurchase[];
    };

/**
 * The one subscription this subject may change, cancel or keep — resolved from their own rows, never from a
 * request.
 *
 * ## Why neither existing answer was reusable
 *
 * `ownSubscriptionIds` returns *every* subscription row a subject holds, at any status, and that is right for
 * what it feeds: a portal request hands the whole list to Paddle, which sorts out which are live. A write
 * verb cannot hand a list to anything — it needs one — and expired, refunded and superseded rows are all in
 * that list.
 *
 * `GET {base}/pricing` takes `rows.find(r => r.role === "state") ?? rows[0]` from an unfiltered, time-ordered
 * read. Two things are wrong with that here. The order is not a filter, so the newest row of a holder who
 * canceled a year ago is still a year-old cancellation; and `?? rows[0]` can land on a money row, whose
 * `providerTransactionId` is Paddle's `txn_…` rather than a `sub_…`. Pricing survives it because
 * `readPricing` answers `undefined` for a row it cannot address. A cancel verb would not: it would ask a
 * store to end a subscription by a transaction id, and the useful outcome is the one where that fails.
 *
 * ## The three rules
 *
 * **One: the head row, never a period of it.** A subscription's money rows carry the family in
 * `originalTransactionId` and their own invoice or transaction id in `providerTransactionId`; the row that
 * *is* the subscription carries the same value in both — Paddle's and Lemon Squeezy's state builders say so
 * at the field, and it is what `subscriptionIdOf` relies on when it demands a `sub_` prefix. So the predicate
 * is `originalTransactionId = providerTransactionId`, compared in SQL, which also excludes a one-off (whose
 * family is null, and `null = anything` is not true) without a second clause. It is structural rather than a
 * prefix test, so it needs no edit when a rail is added — and a rail whose rows never satisfy it resolves to
 * `none`, which is an honest "there is nothing here this server can change" rather than a wrong row handed
 * to a store.
 *
 * `UNIQUE (rail, providerTransactionId)` then does the rest of the work: a family has at most one head row,
 * so surviving rows are subscriptions one-for-one and there is no de-duplication to get wrong.
 *
 * **Two: a cancellation whose period has run out is over.** `canceled` is in the actionable set because the
 * holder still has what they paid for — but only until `expiresAt`, and the `expired` webhook that would
 * overwrite the row can be late or dropped. Without this, every resubscriber is permanently ambiguous:
 * their old, dead cancellation competes with the subscription they are currently paying for, and they are
 * locked out of managing it. The check is deliberately **only** on `canceled`, because that is the one
 * status whose `expiresAt` is a final date the store has already committed to. On every other actionable
 * status the date is a rolling period end that each renewal moves, and dropping a row on it would tell a
 * paying customer they have no subscription for as long as one renewal webhook is late.
 *
 * **Three: both halves of the subject, always.** `user:acme` and `organization:acme` are two holders and
 * nothing in the kit keeps the id namespaces disjoint, so an id-only filter would let either act on the
 * other's subscription. The pair arrives resolved from the seam, under whichever mode the project bills in.
 *
 * @param d1 The purchases database.
 * @param subject The holder, as the subject seam resolved them — both halves.
 * @param now The clock, for rule two. Passed rather than read, so a test can stand either side of an expiry.
 */
export async function changeableSubscription(
  d1: D1Database,
  subject: PaymentsSubject,
  now: Date,
): Promise<SubscriptionTarget> {
  const rows = await paymentsDatabase(d1)
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    // Every column: a rail is handed the whole row, because what identifies a subscription at its store
    // differs per rail and some of it survives only in the payload. See `SubscriptionChangeInput.purchase`.
    .selectAll()
    .where("subjectType", "=", subject.subjectType)
    .where("subjectId", "=", subject.subjectId)
    .where("type", "=", "subscription")
    .where("status", "in", SUBSCRIPTION_ACTIONABLE_STATUSES)
    // Rule one, in SQL. A null family is not equal to anything, so one-off purchases fall out here too.
    .whereRef("originalTransactionId", "=", "providerTransactionId")
    // Newest first, and `id` to break a tie, so a `many` answer is stable rather than whatever D1 returns.
    .orderBy("providerEventAt", "desc")
    .orderBy("id", "desc")
    .execute();

  // Parsed, not read raw. A D1 row is a boundary like any other, and `expiresAt` is an epoch integer until
  // the codec makes it a date — comparing the number against a `Date` is the kind of quiet nonsense this
  // package validates at every edge to prevent.
  const candidates = rows
    .map((row) => PaymentsPurchase.parse(row))
    .filter((purchase) => !cancellationRanOut(purchase, now));

  const [only, ...rest] = candidates;
  if (only === undefined) return { found: "none" };
  if (rest.length > 0) return { found: "many", purchases: candidates };
  return { found: "one", purchase: only };
}

/**
 * Every payment made on one subscription, as this holder's own rows record them — what a refund acts on.
 *
 * ## Why a refund needs a different query from every other verb
 *
 * The other four act on the subscription, and {@link changeableSubscription} resolves *the* row that is one.
 * A refund cannot: **no store refunds a subscription.** Every refund attaches to a transaction, and a
 * subscription is a family of them — so this returns the money rows, which is a set, and the caller raises
 * one refund each.
 *
 * The set is ordinary rather than exotic. A customer who joined on Solo at 6.00, upgraded to Team on day 10
 * for a 65.82 proration and cancels on day 13 has paid twice. An adopter whose policy gives them their money
 * back owes both, and a query returning one would quietly keep 65.82 of somebody's money.
 *
 * ## The three rules
 *
 * **One: money rows only, stated twice.** `role = 'charge'` is the discriminator Lemon Squeezy forced into
 * existence, and the second clause — `providerTransactionId <> originalTransactionId` — is the structural
 * form of the same statement for the rails that write `charge` for everything: the row that *is* the
 * subscription carries its family key in both columns. Either alone is right on some rail and wrong on
 * another, and what they exclude is the head row, whose provider id is a `sub_…`. Sending that to a store is
 * asking it to refund a subscription, which is not a thing it can do.
 *
 * **Two: both halves of the subject, always.** `user:acme` and `organization:acme` are two holders and
 * nothing keeps the id namespaces disjoint, so an id-only filter would refund one holder's payments on the
 * other's request. The same rule every query here follows, and here it is the difference between a refund
 * and a theft.
 *
 * **Three: the family, and only this rail.** A holder may have paid on two stores; the rail comes from the
 * subscription row that was resolved, never from a request.
 *
 * ## What is deliberately absent
 *
 * **A window, and a status filter.** How long a customer has to ask for their money back is the *adopter's*
 * policy — the kit must not hard-code fourteen days, or any number — so every payment on the subscription is
 * returned and the adopter's screen decides which button exists. And nothing here filters on a status of
 * *ours*: whether a payment can still be refunded is the **store's** answer, read live from the transaction's
 * own adjustments, and a projected row is a lagging copy of it. Filtering here would drop a payment on a
 * stale row and call the result a complete refund.
 *
 * Ordered oldest first and tie-broken by id, so the report a caller gets back is in the order the money was
 * taken and is reproducible across two identical requests.
 */
export async function refundablePayments(
  d1: D1Database,
  subject: PaymentsSubject,
  subscription: PaymentsPurchase,
): Promise<readonly PaymentsPurchase[]> {
  const family = subscription.originalTransactionId ?? subscription.providerTransactionId;
  const rows = await paymentsDatabase(d1)
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    // Every column, for `SubscriptionChangeInput.purchase`'s reason: a rail is handed the whole row.
    .selectAll()
    .where("subjectType", "=", subject.subjectType)
    .where("subjectId", "=", subject.subjectId)
    .where("rail", "=", subscription.rail)
    .where("type", "=", "subscription")
    .where("originalTransactionId", "=", family)
    .where("role", "=", "charge")
    // The head row, structurally. A `sub_…` sent to a refund endpoint is a request no store can honor.
    .whereRef("providerTransactionId", "!=", "originalTransactionId")
    .orderBy("providerEventAt", "asc")
    .orderBy("id", "asc")
    .execute();
  // Parsed, not read raw. A D1 row is a boundary like any other.
  return rows.map((row) => PaymentsPurchase.parse(row));
}

/** Rule two: a cancellation the paid period has already outrun. See {@link changeableSubscription}. */
function cancellationRanOut(purchase: PaymentsPurchase, now: Date): boolean {
  if (purchase.status !== "canceled" || purchase.expiresAt === null) return false;
  return purchase.expiresAt.getTime() <= now.getTime();
}

/**
 * More than one subscription, on every one of the five routes — the read included.
 *
 * **A refusal rather than a choice, and it is the same refusal on the read as on the writes.** The read's
 * envelope holds one subscription or none, so `many` has no honest encoding in it: null says the caller
 * holds nothing, which is false, and picking one renders somebody's other plan beside a cancel button
 * that would end a third thing. `changeableSubscription` exists to make that silent pick impossible, and
 * this is where its third answer becomes a sentence.
 *
 * 409 rather than 400: the request is well-formed and the conflict is with the state of the account, which
 * is what tells a client to re-read rather than to re-word. `detail` counts them and names the rails —
 * throw-site context, stripped by the codec — and the message names nothing about anybody's billing.
 */
function tooManySubscriptions(purchases: readonly PaymentsPurchase[]): PithyError {
  return new PaymentsSubscriptionChangeRefusedError({
    message: "There is more than one subscription on this account.",
    action: "Open the billing portal to manage them there. This route acts on one subscription and will not choose.",
    detail: `${purchases.length} actionable subscriptions resolved for this holder, on ${[
      ...new Set(purchases.map((purchase) => purchase.rail)),
    ].join(", ")}. No verb may pick one.`,
  });
}

/**
 * The one subscription a verb acts on, or the refusal that says why there is not one.
 *
 * The `none` case is a 404 rather than a payments-domain refusal, for the reason `POST {base}/portal`
 * gives for the same shape: the rail is configured and working, and the resource simply does not exist.
 * `GET {base}/subscription` does **not** call this — a read has an honest empty answer and `null` is it.
 */
function requireOneSubscription(target: SubscriptionTarget): PaymentsPurchase {
  if (target.found === "many") throw tooManySubscriptions(target.purchases);
  if (target.found === "none") {
    throw new NotFoundError({
      message: "No subscription to manage.",
      action: "Buy a subscription first, then change or cancel it here.",
      detail: "The caller holds no subscription in a status this server can act on.",
    });
  }
  return target.purchase;
}

/**
 * One subscription as its own holder reads it — the standing the store reported, plus the two facts a
 * screen cannot derive.
 *
 * **`productId` is a parameter rather than read off the purchase row, and that is not tidiness.** After a
 * plan change the row still names the old plan: the webhook owns that row and has not arrived yet
 * (invariant 2 — no route writes the projection). A view built from the row would answer the change route
 * with the plan the customer just left, on the screen that renders what it wrote. So the read passes the
 * row's product and `change` passes the one the store just confirmed.
 *
 * **`nextEvent` is derived here rather than by the client**, because the precedence is not obvious and
 * every client would have to rediscover it: a scheduled change wins over the next billing date, since
 * Paddle blanks that date the moment a cancellation is scheduled. `nextSubscriptionEvent` is the one
 * implementation, in `data/subscription.ts`; a client cannot call it, because it takes `Date`s.
 */
function subscriptionView(productId: string, standing: SubscriptionStanding): PaymentsSubscriptionView {
  const event = nextSubscriptionEvent(standing);
  return {
    productId,
    status: standing.status,
    currency: standing.currency,
    currentPeriodEndsAt: standing.currentPeriodEndsAt?.toISOString() ?? null,
    nextBilledAt: standing.nextBilledAt?.toISOString() ?? null,
    scheduledChange:
      standing.scheduledChange === null
        ? null
        : {
            action: standing.scheduledChange.action,
            effectiveAt: standing.scheduledChange.effectiveAt.toISOString(),
            resumesAt: standing.scheduledChange.resumesAt?.toISOString() ?? null,
          },
    nextEvent:
      event.kind === "unknown" ? { kind: "unknown", at: null } : { kind: event.kind, at: event.at.toISOString() },
  };
}

/**
 * The store's own price for a catalog product, on the rail the subscription actually lives at.
 *
 * **This is the whole of "no body-named price".** A caller names the logical product — the key in
 * `products` — and this resolves it, server-side, on a rail read from the caller's own purchase row. A
 * `pri_…` in a request body would move a customer onto a plan this project does not sell, at a price it did
 * not set, and nothing here could refuse it: the catalog is the only statement of what is for sale.
 *
 * A 404 on the **product** when the rail has no SKU for it, never on the rail, for `/checkout`'s reason:
 * the rail is available and this product simply is not one of the things it sells. Naming which of the two
 * it was would describe the deployment to a stranger.
 */
function subscriptionPrice(entry: PaymentsCatalogEntry, rail: PaymentsRail): string {
  const sku = providerProductId(entry.product, rail);
  if (sku === undefined) {
    throw new PaymentsProductNotFoundError({
      detail: `Product "${entry.id}" declares no ${rail} price, so a subscription at that store cannot be moved onto it.`,
    });
  }
  return sku;
}

/**
 * Whether a plan change is a change at all — the route's own reading of the no-op, and the only thing that
 * decides whether an audit row is written.
 *
 * **The rail answers the no-op and reports nothing about it.** `changePlan` returns the current standing
 * either way, with no flag, because a standing is a subscription's state and "did anything happen" is not
 * one of its fields. So the route cannot learn it from the answer and has to decide from what it holds.
 *
 * What it holds is the purchase row, which names the catalog product the store last told this deployment
 * the subscription was for. Equal to the product asked for means the caller is asking for the plan their
 * own subscription is already on, which is exactly the retry the no-op exists to absorb.
 *
 * **The gap, stated rather than left to be discovered.** The row lags the store by one webhook. During that
 * window a caller repeating a change they already made can find the row still naming the old plan, and this
 * answers `true` for a call the rail then no-ops — one audit row for a change that did not happen on that
 * request. It cannot go the other way: the row only ever names a plan the store has already reported, so a
 * genuine move is never recorded as a no-op and the trail never goes silent about a real change. Of the two
 * directions to be wrong in, a duplicate row that a reader can date against the store's own history is
 * recoverable, and a missing one is not.
 */
function changedPlan(purchase: PaymentsPurchase, productId: string): boolean {
  return purchase.productId !== productId;
}

/**
 * Whether a verb changed anything — the no-op test for `cancel` and `keep`, read off the store's own
 * before and after rather than off a rule copied out of the rail.
 *
 * **The rail reports no such flag, and the fact this needs is not in the purchase row.** A cancellation
 * scheduled for the end of the period is exactly the thing a projected row cannot carry — Paddle leaves
 * `status` at `active` and blanks `next_billed_at` — so the route reads the standing before it writes.
 * That costs one `GET` beside the one the rail makes, and it buys the only thing that keeps the trail
 * honest: an audit row is written when something actually happened and not when a caller retried.
 *
 * **A comparison of outcomes, not a second copy of the rail's rules.** Restating "already scheduled to
 * cancel" and "already ended" here would be two statements of one policy, and they disagree the day one is
 * edited. This asks a narrower question the rail cannot get wrong: after the call, does the store describe
 * the subscription differently than it did before? A no-op is defined by its answer.
 *
 * The views are compared rather than the standings, because a view is what a screen renders and both sides
 * are built by the same function in the same field order. `before === undefined` counts as changed, and is
 * unreachable in practice: a rail that cannot address the purchase refuses the write rather than returning
 * from it.
 */
function standingMoved(before: SubscriptionStanding | undefined, after: SubscriptionStanding): boolean {
  if (before === undefined) return true;
  // The product id is irrelevant to this comparison and identical on both sides — no verb here changes it.
  return JSON.stringify(subscriptionView("", before)) !== JSON.stringify(subscriptionView("", after));
}

/**
 * A quote on the wire: the store's own three figures, with the dates rendered.
 *
 * Nothing is computed, summed or netted — `data/subscription.ts` holds the argument, and the short form is
 * that a second answer to "what will this cost" is a second number for a customer to hold against their
 * statement. The settlements cross verbatim because they already are what a screen renders: a direction
 * and a magnitude, with the direction as the discriminant so the amount cannot be reached without it.
 *
 * **The money is already rendered when it gets here, and that is why this function does not render it.**
 * `QuotedMoney` requires the string, so the figure exists from the moment the quote does — an adopter
 * calling the rail directly gets the same sentence this response carries, rather than a formatting rule
 * that lives only on the HTTP path. What this layer supplies is the *locale*, resolved from the translator
 * seam at the route and handed down through `RailRequestContext`. See `data/renderMoney.ts`.
 */
function quoteView(quote: SubscriptionChangeQuote): PaymentsSubscriptionQuote {
  return {
    settlesToday: quote.settlesToday,
    nextInvoice:
      quote.nextInvoice === null
        ? null
        : { settlement: quote.nextInvoice.settlement, at: quote.nextInvoice.at.toISOString() },
    recurring:
      quote.recurring === null
        ? null
        : {
            amount: quote.recurring.amount,
            startsAt: quote.recurring.startsAt.toISOString(),
            madeUpOf: quote.recurring.madeUpOf,
          },
  };
}

/**
 * A refund report on the wire: what became of each payment, and nothing that identifies one.
 *
 * **Every id is dropped and no amount is added.** The store's adjustment id and our own purchase id both
 * stay server-side — a store identifier never crosses a bearer response, and an id published here is a field
 * a request grows next — and the store's refusal sentence is throw-site context that names transactions and
 * account facts. What a screen renders is how many payments were asked about and where each stands; the ids
 * and the reasons are in the audit trail, where an operator is the reader.
 *
 * The order is the server's resolution order and the length is the input's, so a partial arrives as a
 * countable list rather than as a success with something missing.
 */
function refundView(refund: RefundRequest): PaymentsRefundRequest {
  return {
    outcomes: refund.outcomes.map((outcome) =>
      outcome.outcome === "failed" ? { outcome: "failed" } : { outcome: outcome.outcome, status: outcome.status },
    ),
  };
}

/**
 * Record a management read.
 *
 * **Every read, not only the writes.** A credential quietly paging every account's purchases leaves no
 * other trace anywhere, and the customer's ability to reconstruct what a dashboard did with the access
 * they granted is the whole promise of the control plane. Counts, filters and identifiers only: no row, no
 * amount, no provider identifier. Copying the purchase log into the audit trail would make a second
 * purchase log with weaker access rules than the first.
 */
async function recordRead(
  c: Context<PithyHonoEnv>,
  action: PaymentsAuditAction,
  resourceId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  const who = controlPlaneCaller(c);
  await c.var.emit({
    action,
    outcome: "success",
    // A management client, not a user of this app — and the actor is the token's `sub`, so the trail names
    // which person at the dashboard looked, not merely "the dashboard".
    actorType: "control-plane",
    actorId: who.subject,
    resourceType: "payments_read",
    resourceId,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: { connectionId: who.connectionId, ...metadata },
  });
}

export function registerPaymentsRoutes(options: PaymentsRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const { config } = options;
  const base = options.basePath ?? config.basePath;
  const clock = options.now ?? (() => new Date());
  const trust = options.trust ?? {};
  /** The seam `payments()` built, or the resolver-less one this config implies. See {@link PaymentsRoutesOptions.subject}. */
  const seam: PaymentsSubjectSeam = options.subject ?? { billingSubject: config.billingSubject };

  /**
   * Stripe's hosted-flow return URLs, or the 404 that says the rail is off.
   *
   * Reachable only when `rails.stripe` is false — the catalog refuses to parse with the rail on and the block
   * absent, so a deploy is where that is caught. This is the "Stripe is not enabled here" answer, and it costs
   * no secret read to give.
   */
  function stripeSettings(): PaymentsStripeSettings {
    if (config.stripe === undefined) {
      throw new PaymentsRailNotConfiguredError({
        detail: "The stripe rail is off in this project's config, so there are no hosted flows to start.",
      });
    }
    return config.stripe;
  }

  /**
   * Where a hosted checkout returns the browser, for whichever rail is taking the money.
   *
   * Each rail carries its own pair, because each returns to a different page: a Stripe success URL holds a
   * `{CHECKOUT_SESSION_ID}` token the return page posts back, and a Lemon Squeezy one cannot — that rail has
   * no submittable receipt, so its page shows a pending state and waits for the webhook.
   */
  function returnUrls(rail: PaymentsRail): { successUrl: string; cancelUrl?: string } {
    if (rail === "paddle") {
      if (config.paddle === undefined) {
        throw new PaymentsRailNotConfiguredError({
          detail: "The paddle rail is off in this project's config, so there are no checkout flows to start.",
        });
      }
      // The cancel URL is optional here and required for Stripe, and the asymmetry is the store's: an
      // overlay a buyer closes leaves them exactly where they were, with nowhere to be sent.
      return { successUrl: config.paddle.successUrl, cancelUrl: config.paddle.cancelUrl };
    }
    if (rail === "lemonSqueezy") {
      if (config.lemonSqueezy === undefined) {
        throw new PaymentsRailNotConfiguredError({
          detail: "The lemonSqueezy rail is off in this project's config, so there are no hosted flows to start.",
        });
      }
      // No cancel URL: that store's checkout has no cancel destination to send one to.
      return { successUrl: config.lemonSqueezy.successUrl };
    }
    const settings = stripeSettings();
    return { successUrl: settings.successUrl, cancelUrl: settings.cancelUrl };
  }

  /**
   * Which hosted-checkout rail this request is for.
   *
   * A product declares its rails by carrying their blocks, so the candidates are the checkout-capable rails
   * this project has enabled *and* this product is listed on. One candidate is the common case and needs no
   * request field. Two, with the caller naming neither, is refused: picking one would decide who takes a
   * customer's money on their behalf, and an adopter selling on two rails means to offer the choice.
   *
   * The candidate list is `PAYMENTS_HOSTED_RAILS`, and it is not written out here: this route and the
   * scaffolded screens ask the same question, and a fifth copy of the answer is what #336 was.
   * `PAYMENTS_HOSTED_RAILS` is ordered, which is the only thing that order does — when a product sells on
   * two rails and the caller named neither the request is refused, so nothing here resolves silently; the
   * order exists to make the refusal's message deterministic.
   */
  function checkoutRailFor(entry: PaymentsCatalogEntry, requested: PaymentsRail | undefined): PaymentsRail {
    const enabled = PAYMENTS_HOSTED_RAILS.filter((rail) => railEnabled(config, rail));

    // No hosted-checkout rail at all. That is a fact about the deployment rather than about the product —
    // a mobile-only project sells through Apple and Google and has no browser flow to start — so it is the
    // rail refusal, and it costs no credential read and no round-trip to give.
    if (enabled.length === 0) {
      throw new PaymentsRailNotConfiguredError({
        detail:
          "No hosted-checkout rail is on in this project's config, so there are no hosted flows to start. Enable `rails.stripe`, `rails.lemonSqueezy`, or `rails.paddle`.",
      });
    }

    const candidates = enabled.filter((rail) => providerProductId(entry.product, rail) !== undefined);

    if (requested !== undefined) {
      if (candidates.includes(requested)) return requested;
      // Named a rail this product is not sold on, or one this project has turned off. A 404 on the product
      // rather than the rail: naming which of the two it was would describe the deployment to a stranger.
      throw new PaymentsProductNotFoundError({
        detail: `Product "${entry.id}" cannot be bought through ${requested} here — the rail is off, or the product declares no ${requested} block.`,
      });
    }

    const [only, ...rest] = candidates;
    if (only === undefined) {
      throw new PaymentsProductNotFoundError({
        detail: `Product "${entry.id}" declares no enabled hosted-checkout rail, so it cannot be bought through this route.`,
      });
    }
    if (rest.length > 0) {
      throw new ValidationError({
        message: "Choose how to pay.",
        action: `Send \`rail\` as one of: ${candidates.join(", ")}.`,
        detail: `Product "${entry.id}" is sold through ${candidates.join(" and ")}, and the request named neither.`,
      });
    }
    return only;
  }

  /** One rail, narrowed to the interface that creates hosted sessions. */
  async function checkoutRail(
    c: Context<PithyHonoEnv>,
    rail: PaymentsRail,
  ): Promise<PaymentsRailProvider & CheckoutRail> {
    const provider = resolveRailProvider(rail, config, await credentials(c), trust);
    if (!isCheckoutRail(provider)) {
      // Structural rather than a name check, so a future rail that initiates purchases needs no edit here and one
      // that does not can never be asked.
      throw new PaymentsRailNotConfiguredError({
        detail: `The ${provider.rail} rail does not create hosted sessions.`,
      });
    }
    return provider;
  }

  /**
   * One rail, narrowed to the interface that manages a subscription from the server.
   *
   * {@link checkoutRail}'s shape and {@link checkoutRail}'s reason: structural, never a rail-name check, so
   * a rail that gains the ability needs no edit here and one that has not can never be asked. The guard
   * ANDs all five verbs — a rail missing any one of them is simply not a subscription rail, and the answer
   * is `payments/rail_not_configured` rather than a `TypeError` thrown mid-cancellation on a route that has
   * already written an audit row.
   *
   * **Which rail is never a request field.** It is the rail on the caller's own purchase row: a subscription
   * that exists lives at exactly one store, and a rail a caller could name could only ever be the wrong
   * store asked about somebody's subscription. That is why the argument comes from
   * {@link changeableSubscription} and from nowhere else.
   *
   * The refusal is honest on the mobile rails rather than a bug: an Apple or Google subscription is changed
   * inside the store's own UI, on the device, and there is no server call that does it.
   */
  async function subscriptionRail(
    c: Context<PithyHonoEnv>,
    rail: PaymentsRail,
  ): Promise<PaymentsRailProvider & SubscriptionRail> {
    const provider = resolveRailProvider(rail, config, await credentials(c), trust);
    if (!isSubscriptionRail(provider)) {
      throw new PaymentsRailNotConfiguredError({
        detail: `The ${provider.rail} rail does not manage subscriptions from the server. A subscription on that store is changed inside the store's own UI, on the device.`,
      });
    }
    return provider;
  }

  /**
   * One rail, narrowed to the interface that refunds at its store.
   *
   * Its own narrowing rather than a sixth verb on {@link subscriptionRail}, because the two abilities are
   * independent in both directions: Google Play refunds from the server and changes no plan from it, and
   * Apple's only refund endpoint is a lookup. Asking one guard for both would refuse a rail that can do the
   * thing being asked for.
   *
   * Structural, like the others, and the rail still comes from the caller's own purchase row rather than
   * from a request — a rail a caller could name could only ever be the wrong store asked about somebody
   * else's money.
   */
  async function refundRail(c: Context<PithyHonoEnv>, rail: PaymentsRail): Promise<PaymentsRailProvider & RefundRail> {
    const provider = resolveRailProvider(rail, config, await credentials(c), trust);
    if (!isRefundRail(provider)) {
      throw new PaymentsRailNotConfiguredError({
        detail: `The ${provider.rail} rail does not refund from the server. A refund on that store is asked for through the store itself.`,
      });
    }
    return provider;
  }

  /**
   * The store's own subscription ids this caller holds on a rail — the family keys of their own rows.
   *
   * Read from the projection rather than from the store, and always for the subject the seam resolved. What
   * it feeds is a portal request for authenticated cancel links, so the set has to be exactly what this
   * holder owns: a wider one would mint somebody else's cancel button, and there is no request field that
   * could widen it.
   *
   * `originalTransactionId` rather than `providerTransactionId`, because a subscription's money rows name
   * the family there and the state row names itself there too — so one column answers for both.
   */
  async function ownSubscriptionIds(
    c: Context<PithyHonoEnv>,
    rail: PaymentsRail,
    subject: PaymentsSubject,
  ): Promise<readonly string[]> {
    const rows = await paymentsDatabase(database(c))
      .selectFrom(PAYMENTS_PURCHASES_TABLE)
      .select(["originalTransactionId"])
      // Both halves, as everywhere: an id-only predicate would mint `user:acme` a cancel link for whatever
      // `organization:acme` is paying for.
      .where("subjectType", "=", subject.subjectType)
      .where("subjectId", "=", subject.subjectId)
      .where("rail", "=", rail)
      .where("type", "=", "subscription")
      .orderBy("providerEventAt", "desc")
      .execute();
    const ids = new Set<string>();
    for (const row of rows) if (typeof row.originalTransactionId === "string") ids.add(row.originalTransactionId);
    return [...ids];
  }

  /** The subject's store account on a rail, or null. What keeps one buyer to one Stripe customer. */
  async function accountFor(
    c: Context<PithyHonoEnv>,
    rail: PaymentsRail,
    subject: PaymentsSubject,
  ): Promise<string | null> {
    return (await providerAccountForSubject(paymentsDatabase(database(c)), rail, subject)) ?? null;
  }

  /**
   * Verify one receipt through its rail and project it against the subject. Shared by submit and restore.
   *
   * **The subject is a parameter, not resolved here**, and that is deliberate: `/restore` submits a batch, and
   * a seam call per receipt would ask the adopter's resolver the same question fifty times — and would let the
   * answer change halfway through a batch, filing one client's history under two holders.
   */
  async function submit(
    c: Context<PithyHonoEnv>,
    subject: PaymentsSubject,
    rail: PaymentsRail,
    receipt: string,
  ): Promise<PurchaseProjection> {
    const now = clock();
    const d1 = database(c);
    const provider = resolveRailProvider(rail, config, await credentials(c), trust);
    // **The deployment travels with the clock**, and on one rail it is load-bearing rather than incidental.
    // Paddle's `verify` honors a submitted transaction's ownership stamp only when a MAC keyed on this
    // deployment's own secret verifies beside it — and the environment is *inside* that MAC's message, so a
    // rail handed no deployment can prove nothing and refuses every submission. The other rails ignore it.
    const verified = await provider.verify(receipt, { now, deployment: deploymentName(c) });

    // A purchase this deployment initiated names its own purchaser, and a submission from anyone else is refused
    // before it is projected. Only Stripe and Paddle set this — see `VerifiedPurchase.accountReference` for why
    // an app-supplied identifier like Apple's `appAccountToken` deliberately does not.
    //
    // **A reference that does not decode is refused, not ignored.** It is bytes from a store, so it may be a
    // bare id — the shape every pre-subject client sent — or a kind this build does not know, and neither names
    // this caller. `sameSubject` answers false for `undefined` against anything, so the one comparison covers
    // the malformed case and the wrong-holder case together, and covers both halves of the pair: `user:acme`
    // submitting `organization:acme`'s purchase is refused exactly as a stranger's is.
    if (verified.accountReference) {
      const stamped = decodeSubjectReference(verified.accountReference);
      if (!sameSubject(stamped, subject)) {
        throw new PaymentsReceiptAlreadyOwnedError({
          detail: `${rail} purchase ${verified.event.providerTransactionId} was started for ${stamped === undefined ? "a reference this build cannot read" : encodeSubjectReference(stamped)}; ${encodeSubjectReference(subject)} submitted it.`,
        });
      }
    }

    // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt* the
    // rejection instead of raising it, and the workerd runtime then reports the adopted promise as an
    // unhandled rejection even though Hono's `onError` answers the request correctly. A refusal here is normal
    // traffic — a stale receipt, a sandbox transaction — so it must not read as a runtime fault in a log.
    const projection = await projectPurchase(
      d1,
      // Both halves, off the one resolved subject. The event carries them flat because a row does, and
      // spreading the pair is what keeps a kind from one place beside an id from another.
      { ...verified.event, ...subject },
      { config, environment: deploymentEnvironment(c), now },
    );

    // The account link comes **after** the projection, not before it.
    //
    // On Apple and Google `providerAccountId` is `appAccountToken` / `obfuscatedAccountId` — a value the app
    // chose. Writing the link first meant any receipt this deployment refused still minted a permanent
    // ownership record: a Sandbox transaction is free and is rejected by the environment check *inside* the
    // projection, so an attacker could bind an unlimited number of identifiers at no cost and then collect the
    // notifications of whoever those identifiers really belonged to. Requiring a projected purchase first means
    // a binding costs a real purchase on the deployment's own environment, and leaves a row naming who made it.
    if (verified.providerAccountId) {
      const bound = await linkProviderAccount(d1, rail, verified.providerAccountId, subject, { now });
      // The binding never rebinds, so a disagreement means somebody else claimed this store account first.
      // That is legitimate often enough (a shared device, a reinstall against a new Pithy account) that
      // refusing would hand an attacker a way to lock the real owner out — so the first binding stands, this
      // caller keeps the purchase they just projected, and the collision is recorded for somebody to look at.
      // The purchases that were waiting on exactly this link. On Apple and Google the client submission is
      // the *only* link event there is — no webhook on those rails carries an account reference — so a rail
      // that cannot replay its own recorded payload is answered by a no-op here rather than by an omission.
      await repairOrphans(c, rail, now);
      if (!sameSubject(bound, subject)) {
        await c.var.emit({
          action: PaymentsAuditActions.providerAccountContested,
          outcome: "denied",
          severity: "warning",
          // The **person** who submitted, not the holder they act for. An organization does not press a
          // button; somebody at it does, and a trail that recorded the company here would answer "who did
          // this" with a name nobody can be asked about it.
          actorType: "user",
          actorId: c.var.auth?.userId,
          resourceType: "provider_account",
          resourceId: `${rail}:${verified.providerAccountId}`,
          // Two keys per subject, never one joined string. A trail is queried by equality on a column, and a
          // `user:ada` that has to be split before it can be compared is a column nobody filters correctly
          // twice. `encodeSubjectReference` is for the single-field slots a *store* gives us; this is ours.
          metadata: {
            rail,
            boundToType: bound.subjectType,
            boundToId: bound.subjectId,
            claimedByType: subject.subjectType,
            claimedById: subject.subjectId,
          },
        });
      }
    }

    await fulfill(c, projection);
    return projection;
  }

  /**
   * Credit what the purchase bought, and reverse it where a refund and the catalog both ask.
   *
   * A no-op for every product with no `grants` clause, and it resolves the optional `@pithy-sh/ledger` import
   * only when one is present — so a project selling nothing but features never reaches the package. A failure
   * here is deliberately left to propagate: the credit's ref is stable, so a retry settles it, and swallowing
   * it would lose a purchase's currency with nothing anywhere to read.
   */
  /**
   * Project the orphans a link just made resolvable. Never throws: see {@link repairOrphanedEvents}.
   *
   * The rail provider is built here rather than passed, because `replay` is the one thing the repair needs
   * from a rail and building one costs a secrets read the handler has already paid for on every path that
   * reaches this.
   */
  async function repairOrphans(c: Context<PithyHonoEnv>, rail: PaymentsRail, now: Date): Promise<void> {
    const provider = resolveRailProvider(rail, config, await credentials(c), trust);
    const replay = provider.replay?.bind(provider);
    if (replay === undefined) return;
    const repaired = await repairOrphanedEvents(database(c), rail, {
      config,
      environment: deploymentEnvironment(c),
      now,
      replay: (payload) => replay(payload, { now, deployment: deploymentName(c) }),
      fulfill: (projection) => fulfill(c, projection),
    });
    for (const providerEventId of repaired.projected) {
      await c.var.emit({
        action: PaymentsAuditActions.webhookReceived,
        outcome: "success",
        actorType: "service",
        actorId: rail,
        metadata: { rail, providerEventId, projected: true, repaired: "orphan" },
      });
    }
  }

  async function fulfill(c: Context<PithyHonoEnv>, projection: PurchaseProjection): Promise<void> {
    await fulfillPurchase(database(c), projection, {
      config,
      emit: c.var.emit,
      now: () => clock().getTime(),
    });
  }

  return (app) => {
    // The management surface: control-plane, read-only, under `admin/`. Its paths are disjoint from the
    // player surface by construction, so registering it first is presentation rather than semantics.

    /**
     * CONTROL PLANE. What this project sells — the catalog, with the entitlement keys each product grants.
     *
     * **The read that makes a comp control possible.** Without it a management client offering "give this
     * person an entitlement" has nothing to populate a list from, so it offers a text box — and a text box
     * beside a free-text key is how an operator who means `pro` types `pr` and gets a success. The
     * validation on `entitlements/grant` is the other half, and it is the half that matters: this makes a
     * good control possible, that makes a bad one impossible.
     *
     * Its own scope. Reading what a project sells is not reading what anybody bought — it names no account
     * and no transaction, and would answer identically against a database with no rows in it — so a tool
     * that needs a dropdown can hold this and nothing else.
     *
     * No query at all, and none to add: the catalog is small, fixed at deploy, and has no page. What
     * crosses is decided by `adminCatalogView` and asserted as an invariant rather than as a field list.
     */
    app.get(`${base}/admin/catalog`, requireControlPlane(PAYMENTS_CATALOG_READ_SCOPE), async (c) => {
      const view = adminCatalogView(config);
      await recordRead(c, PaymentsAuditActions.catalogRead, null, {
        products: view.enabled ? view.products.length : 0,
      });
      return c.json(view satisfies PaymentsAdminCatalogResponse, 200);
    });

    /**
     * CONTROL PLANE. The purchase log, paged, newest first.
     *
     * The filters narrow and never widen: there is no shape of this request that reaches a column the
     * projection does not return, and no filter that turns the response into something a wider scope
     * would have been needed for. `environment` is unfiltered by default on purpose — hiding sandbox
     * transactions would hide the single thing an operator most needs to notice on a production board.
     */
    app.get(
      `${base}/admin/purchases`,
      requireControlPlane(PAYMENTS_PURCHASES_READ_SCOPE),
      zValidator("query", AdminPurchasesQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const subject = subjectFilter(query);
        const page = await listPurchases(database(c), { ...query, subject });
        // The audit row's `resourceId` is one column, so the pair is encoded for it — the same encoding a
        // store's single-field slot gets, and the only place in this file one is written. The **filters** stay
        // two keys, because those are what a trail is queried by.
        await recordRead(
          c,
          PaymentsAuditActions.purchasesRead,
          subject === undefined ? null : encodeSubjectReference(subject),
          {
            returned: page.items.length,
            resumed: query.cursor !== undefined,
            filters: {
              subjectType: subject?.subjectType ?? null,
              subjectId: subject?.subjectId ?? null,
              rail: query.rail ?? null,
              status: query.status ?? null,
              environment: query.environment ?? null,
            },
          },
        );
        return c.json(
          {
            purchases: page.items.map(adminPurchaseView),
            nextCursor: page.nextCursor,
          } satisfies PaymentsAdminPurchasesResponse,
          200,
        );
      },
    );

    /**
     * CONTROL PLANE. The purchases that renew, paged, newest first.
     *
     * Its own scope, granted separately from the purchase log's. A renewal or churn tool needs to know who
     * is still paying and when their period ends; it has no business reading what everybody ever bought,
     * and an adopter who wants to hand out only the narrower half must have a way to say so. The narrowing
     * is applied by `listSubscriptions` rather than by a `type` filter the request could name, so the
     * wider read is not reachable through this scope by construction.
     */
    app.get(
      `${base}/admin/subscriptions`,
      requireControlPlane(PAYMENTS_SUBSCRIPTIONS_READ_SCOPE),
      zValidator("query", AdminSubscriptionsQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const subject = subjectFilter(query);
        const page = await listSubscriptions(database(c), { ...query, subject });
        await recordRead(
          c,
          PaymentsAuditActions.subscriptionsRead,
          subject === undefined ? null : encodeSubjectReference(subject),
          {
            returned: page.items.length,
            resumed: query.cursor !== undefined,
            filters: {
              subjectType: subject?.subjectType ?? null,
              subjectId: subject?.subjectId ?? null,
              status: query.status ?? null,
            },
          },
        );
        return c.json(
          {
            subscriptions: page.items.map(adminPurchaseView),
            nextCursor: page.nextCursor,
          } satisfies PaymentsAdminSubscriptionsResponse,
          200,
        );
      },
    );

    /**
     * CONTROL PLANE. The entitlement model, paged — what accounts hold, and why.
     *
     * `granted` is resolved here against `expiresAt`, exactly as the gate the adopter's own app calls
     * resolves it. A dashboard that recomputed it from the stored flag would eventually disagree with that
     * gate, and the customer would believe the dashboard.
     */
    app.get(
      `${base}/admin/entitlements`,
      requireControlPlane(PAYMENTS_ENTITLEMENTS_READ_SCOPE),
      zValidator("query", AdminEntitlementsQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const now = clock();
        const subject = subjectFilter(query);
        const page = await listEntitlements(database(c), { ...query, subject });
        await recordRead(
          c,
          PaymentsAuditActions.entitlementsRead,
          subject === undefined ? null : encodeSubjectReference(subject),
          {
            returned: page.items.length,
            resumed: query.cursor !== undefined,
            filters: {
              subjectType: subject?.subjectType ?? null,
              subjectId: subject?.subjectId ?? null,
              entitlement: query.entitlement ?? null,
            },
          },
        );
        return c.json(
          {
            entitlements: page.items.map((row) => adminEntitlementView(row, now)),
            nextCursor: page.nextCursor,
          } satisfies PaymentsAdminEntitlementsResponse,
          200,
        );
      },
    );

    /**
     * CONTROL PLANE. Everything one subject is entitled to, resolved now.
     *
     * **Two path segments, because the address is a pair.** The table is keyed
     * `UNIQUE (subjectType, subjectId, entitlement)`, and nothing in the kit keeps an organization id from
     * equalling some user's — so a route addressed by the id alone would answer about whichever holder
     * happened to carry it. Both segments are validated: an unknown kind is a 400 naming the two that exist,
     * which is what a malformed address deserves, where the encoded-reference form would have been a 404
     * reading as a holder who is simply not here.
     *
     * Unpaginated, because the key above admits at most one row per entitlement. A subject holding nothing is
     * an empty list rather than a 404: an entitlement row appears with the first purchase that grants one, so
     * its absence is not a missing holder — and a 404 would make this surface an existence oracle for user and
     * organization ids alike.
     */
    app.get(
      `${base}/admin/entitlements/:subjectType/:subjectId`,
      requireControlPlane(PAYMENTS_ENTITLEMENTS_READ_SCOPE),
      zValidator("param", AdminSubjectParam, validationHook),
      async (c) => {
        const subject = c.req.valid("param");
        const now = clock();
        const rows = await readEntitlements(database(c), subject);
        await recordRead(c, PaymentsAuditActions.entitlementsRead, encodeSubjectReference(subject), {
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          returned: rows.length,
        });
        return c.json(
          {
            ...subject,
            entitlements: rows.map((row) => adminEntitlementView(row, now)),
          } satisfies PaymentsAdminSubjectEntitlementsResponse,
          200,
        );
      },
    );

    /**
     * CONTROL PLANE. What reconciliation has done — the passes this deployment has run, newest first.
     *
     * The compensating control for a delivery mechanism that is known to fail leaves a trace, so an adopter
     * can tell a healthy integration from one whose cron stopped firing. An empty page is a real answer and
     * the loudest one this route gives.
     *
     * Its own scope: a run names no account, no transaction and no amount, so a health monitor can be granted
     * exactly this without acquiring the purchase log.
     */
    app.get(
      `${base}/admin/reconcile-runs`,
      requireControlPlane(PAYMENTS_RECONCILE_READ_SCOPE),
      zValidator("query", AdminReconcileRunsQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const page = await listReconcileRuns(database(c), query);
        await recordRead(c, PaymentsAuditActions.reconcileRunsRead, null, {
          returned: page.items.length,
          resumed: query.cursor !== undefined,
          filters: { rail: query.rail ?? null, environment: query.environment ?? null },
        });
        return c.json(
          {
            runs: page.items.map(adminReconcileRunView),
            nextCursor: page.nextCursor,
          } satisfies PaymentsAdminReconcileRunsResponse,
          200,
        );
      },
    );

    /**
     * AUTHED WRITE. The purchaser's own app submitting what the store SDK gave it, so the buyer sees their
     * entitlement immediately rather than waiting for the webhook. A replay by its own owner is a 200 with the
     * existing purchase — the write path is idempotent, so a repeat is not an error. A receipt belonging to
     * somebody else is a 409, audited as denied.
     */
    app.post(`${base}/purchases`, requireAuth(), zValidator("json", PurchaseSubmission, validationHook), async (c) => {
      const input = c.req.valid("json");
      // Resolved before the store is called: a caller acting for nobody has no row to write, so refusing here
      // costs no round trip and cannot leave a charged customer with an unattributed purchase.
      const subject = await requirePaymentsSubject(c, seam);
      try {
        const projection = await submit(c, subject, input.rail, input.receipt);
        await c.var.emit({
          action: PaymentsAuditActions.purchaseVerified,
          outcome: "success",
          // The person who submitted, always — the subject they act for rides in the metadata below. Under
          // organization billing the two differ, and collapsing them would answer "who did this" with a
          // company rather than with somebody who can be asked.
          actorType: "user",
          actorId: c.var.auth?.userId,
          sessionId: c.var.auth?.sessionId,
          resourceType: "purchase",
          resourceId: projection.purchase.id,
          // Identifiers and outcomes only. Never the receipt: the trail is long-lived and queryable, and a
          // receipt is a bearer artifact. The holder is two keys, never one joined string.
          metadata: {
            rail: input.rail,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            productId: projection.product.id,
            status: projection.purchase.status,
            outcome: projection.outcome,
          },
        });
        return c.json(
          {
            purchase: purchaseView(projection),
            entitlements: projection.entitlements.map((row) =>
              entitlementView({ key: row.entitlement, active: row.active, expiresAt: row.expiresAt }),
            ),
          } satisfies PaymentsPurchaseResponse,
          200,
        );
      } catch (cause) {
        // A refused submission is the security-relevant event, so it is recorded before the error propagates.
        await c.var.emit({
          action: PaymentsAuditActions.purchaseVerified,
          outcome: "denied",
          severity: "warning",
          actorType: "user",
          actorId: c.var.auth?.userId,
          sessionId: c.var.auth?.sessionId,
          metadata: {
            rail: input.rail,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            reason: cause instanceof PithyError ? cause.payload.code : "unknown",
          },
        });
        throw cause;
      }
    });

    /**
     * AUTHED READ. Always the caller's own holder — the subject comes from the seam, never the request, so
     * there is no shape of this route that reads somebody else's entitlements. A pure read: repairing a stale
     * row is the reconciliation Workflow's job, and `expiresAt` is rechecked here on every request.
     *
     * **Nobody resolved is an empty list, not a refusal**, and that is the read half of the seam's rule. A
     * signed-in person with no organization selected holds nothing, which is what every gate in the kit
     * already answers for somebody who has bought nothing — and a 403 here would make a paywall render an
     * error where it should render the paywall.
     */
    app.get(`${base}/entitlements`, requireAuth(), async (c) => {
      const subject = await resolvePaymentsSubject(c, seam);
      if (subject === undefined) {
        return c.json({ entitlements: [] } satisfies PaymentsEntitlementsResponse, 200);
      }
      const entitlements = await resolveEntitlements(paymentsDatabase(database(c)), subject, clock());
      return c.json({ entitlements: entitlements.map(entitlementView) } satisfies PaymentsEntitlementsResponse, 200);
    });

    /**
     * AUTHED WRITE. Restore Purchases, client-driven because only the device can enumerate what its store
     * account owns.
     *
     * One bad receipt fails the whole request rather than being skipped. That is deliberate: a client submits
     * *its own* history, so a receipt belonging to another account in the batch is an attack and a partial
     * success would hide it. Every receipt that did project stays projected — the writer is idempotent, so the
     * client simply retries.
     */
    app.post(`${base}/restore`, requireAuth(), zValidator("json", RestoreRequest, validationHook), async (c) => {
      const input = c.req.valid("json");
      // One resolution for the whole batch. A client submits *its own* history, so every receipt in it is
      // filed against one holder or the request is refused — asking the seam per receipt would let the answer
      // change mid-batch and split one store account across two.
      const subject = await requirePaymentsSubject(c, seam);
      const purchases: ReturnType<typeof purchaseView>[] = [];
      for (const receipt of input.receipts) purchases.push(purchaseView(await submit(c, subject, input.rail, receipt)));

      const entitlements = await resolveEntitlements(paymentsDatabase(database(c)), subject, clock());
      await c.var.emit({
        action: PaymentsAuditActions.purchaseRestored,
        outcome: "success",
        actorType: "user",
        actorId: c.var.auth?.userId,
        sessionId: c.var.auth?.sessionId,
        metadata: {
          rail: input.rail,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          restored: purchases.length,
        },
      });
      return c.json(
        { purchases, entitlements: entitlements.map(entitlementView) } satisfies PaymentsRestoreResponse,
        200,
      );
    });

    /**
     * SIGNED WEBHOOK — Apple. App Store Server Notifications V2, signed as a JWS against Apple's pinned chain.
     */
    app.post(
      `${base}/webhooks/apple`,
      requireSignedWebhook("apple", { config, now: clock, trust }),
      zValidator("json", AppleWebhookNotification, validationHook),
      webhookHandler("apple"),
    );

    /**
     * SIGNED WEBHOOK — Google. A Pub/Sub push whose OIDC token the guard verified, audience and all.
     *
     * The handler is the same one Apple's route uses, and that is the point: by the time it runs, the rail has
     * already turned Play's pointer into a normalized event through the Play Developer API, so there is nothing
     * Google-shaped left to branch on.
     */
    app.post(
      `${base}/webhooks/google`,
      requireSignedWebhook("google", { config, now: clock, trust }),
      zValidator("json", GoogleWebhookNotification, validationHook),
      webhookHandler("google"),
    );

    /**
     * SIGNED WEBHOOK — Stripe. An HMAC in `Stripe-Signature`, over the exact received bytes and dated, which the
     * guard has checked inside the replay window before this validator ever parses the body.
     *
     * The same handler again. Stripe is the rail with no client-submission path of its own in the common case, so
     * this is where most Stripe purchases enter the system — and it is still nothing but a verified notification
     * by the time the handler runs.
     */
    app.post(
      `${base}/webhooks/stripe`,
      requireSignedWebhook("stripe", { config, now: clock, trust }),
      zValidator("json", StripeWebhookNotification, validationHook),
      webhookHandler("stripe"),
    );

    /**
     * SIGNED WEBHOOK — Lemon Squeezy. A bare HMAC in `X-Signature`, over the exact received bytes, which the
     * guard has checked before this validator ever parses the body.
     *
     * **No timestamp, so no freshness window**, and that is a true fact about the scheme rather than an omission
     * here — `rails/lemonSqueezy/signature.ts` says so in its type by taking no clock. Replay protection is
     * entirely the guard's `UNIQUE (rail, providerEventId)` insert, and the projection's monotonic rule behind
     * it.
     *
     * The same handler again. This is where every Lemon Squeezy purchase enters the system, because that rail
     * has no client-submission path at all: its order ids are sequential integers, so no submitted receipt
     * could be trusted.
     */
    app.post(
      `${base}/webhooks/lemon-squeezy`,
      requireSignedWebhook("lemonSqueezy", { config, now: clock, trust }),
      zValidator("json", LemonSqueezyWebhookNotification, validationHook),
      webhookHandler("lemonSqueezy"),
    );

    /**
     * SIGNED WEBHOOK — Paddle. `Paddle-Signature: ts=…;h1=…`, an HMAC-SHA256 over `${ts}:${exact received
     * bytes}`, which the guard has checked inside the freshness window before this validator ever parses the
     * body.
     *
     * **A different scheme from Stripe's, and a second verifier rather than a widened core primitive.** Core's
     * `signed-webhook` splits its header on `,` and joins its signed payload with `.`; Paddle uses `;` and
     * `:`. Neither is a parameter there, deliberately — `rails/paddle/signature.ts` says why at length, and
     * says it out loud because a verifier that "fits an existing shape" it does not fit is a verifier that
     * returns without comparing anything.
     *
     * The same handler again. Paddle purchases enter through here and through `/purchases`: unlike Lemon
     * Squeezy this rail has a submittable receipt, because a `txn_…` checked against a *proven* ownership
     * stamp is safe where an unguessable order id is not.
     */
    app.post(
      `${base}/webhooks/paddle`,
      requireSignedWebhook("paddle", { config, now: clock, trust }),
      zValidator("json", PaddleWebhookNotification, validationHook),
      webhookHandler("paddle"),
    );

    /**
     * AUTHED WRITE — Stripe only. Create a hosted Checkout Session and hand back where to send the browser.
     *
     * Everything that decides what is bought and where the buyer is returned to comes from config or from the
     * seam, never from the body: the **price** from the catalog entry the product id resolves to, the **return
     * URLs** from `config.stripe`, and the **purchaser** from the subject seam. A client that could name a price
     * could buy Pro for the price of a coin pack; one that could name a return URL could send a paying customer
     * to a page it controls; one that could name a purchaser could attach its purchase to another account.
     *
     * The subject is resolved first, ahead of the catalog lookup: a caller acting for no holder has nothing to
     * be charged as, and refusing before the 404 keeps this from answering what a project sells to somebody it
     * cannot bill.
     */
    app.post(`${base}/checkout`, requireAuth(), zValidator("json", CheckoutRequest, validationHook), async (c) => {
      const input = c.req.valid("json");
      const subject = await requirePaymentsSubject(c, seam);
      const entry = product(config, input.productId);
      const rail = checkoutRailFor(entry, input.rail);
      const settings = returnUrls(rail);
      const sku = providerProductId(entry.product, rail);
      if (sku === undefined) {
        // In the catalog, but not sold here. A 404 on the product rather than on the rail: the rail is
        // available, this product simply is not one of the things it sells.
        throw new PaymentsProductNotFoundError({
          detail: `Product "${entry.id}" declares no ${rail} SKU, so it cannot be bought through hosted checkout.`,
        });
      }

      const provider = await checkoutRail(c, rail);
      const handoff = await provider.createCheckoutSession(
        {
          providerProductId: sku,
          subscription: entry.product.type === "subscription",
          // The pair, so the rail stamps `encodeSubjectReference(subject)` into the checkout it creates and
          // the webhook that follows already names a holder this server chose.
          subject,
          // Reuse the buyer's existing store customer, so one buyer keeps one account and their billing portal
          // shows every purchase rather than only the last one's.
          providerAccountId: await accountFor(c, rail, subject),
          successUrl: settings.successUrl,
          cancelUrl: settings.cancelUrl,
          // Passed to the store unchanged. Pithy never computes a discounted amount and never checks a code
          // against anything of its own — the provider is the authority on what is owed.
          discountCode: input.discountCode,
        },
        { now: clock(), deployment: deploymentName(c) },
      );

      await c.var.emit({
        action: PaymentsAuditActions.checkoutStarted,
        outcome: "success",
        actorType: "user",
        actorId: c.var.auth?.userId,
        sessionId: c.var.auth?.sessionId,
        resourceType: "product",
        resourceId: entry.id,
        metadata: {
          rail,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          productId: entry.id,
          subscription: entry.product.type === "subscription",
          // Whether one was used, never which. The trail is long-lived and a code is a commercial fact.
          discounted: input.discountCode !== undefined,
        },
      });
      // The handoff, verbatim. A `redirect` carries a URL; a `paddle` handoff carries the transaction the
      // browser opens in place, because that rail's overlay and inline modes never leave this page.
      return c.json(handoff satisfies PaymentsCheckoutHandoffResponse, 200);
    });

    /**
     * AUTHED WRITE — Stripe only. Open the Billing Portal for the caller's own store account.
     *
     * No body at all, and that is the request contract: there is exactly one customer this caller may manage,
     * and it comes from the provider-account map. A `customer` field here would be the whole vulnerability —
     * any signed-in caller could open a session against somebody else's billing history and cancel it.
     */
    app.post(`${base}/portal`, requireAuth(), async (c) => {
      const subject = await requirePaymentsSubject(c, seam);

      // Which rail this caller actually bought on, found by asking the account map rather than by taking it
      // from the request. Still no body: the caller names neither the customer nor the rail, so there is
      // nothing here anyone could point at somebody else's billing.
      const enabled = PAYMENTS_HOSTED_RAILS.filter((rail) => railEnabled(config, rail));
      // No hosted rail at all is a fact about the deployment, not about this caller — a mobile-only project
      // has no billing portal to open. Same refusal `/checkout` gives, rather than a 404 that reads as "you
      // have no account" to somebody who could never have had one.
      if (enabled.length === 0) {
        throw new PaymentsRailNotConfiguredError({
          detail:
            "No hosted-checkout rail is on in this project's config, so there is no billing portal to open. Enable `rails.stripe`, `rails.lemonSqueezy`, or `rails.paddle`.",
        });
      }

      let found: { rail: PaymentsRail; providerAccountId: string } | undefined;
      for (const rail of enabled) {
        const providerAccountId = await accountFor(c, rail, subject);
        if (providerAccountId !== null) {
          found = { rail, providerAccountId };
          break;
        }
      }

      if (found === undefined) {
        // Nothing has ever been bought through a hosted rail by this caller, so there is no billing to
        // manage. Not a payments-domain refusal: the rail is configured and working, the resource simply
        // does not exist.
        throw new NotFoundError({
          message: "No billing account yet.",
          action: "Buy a subscription first, then manage it here.",
          detail: `No hosted-rail provider account is linked to ${encodeSubjectReference(subject)}.`,
        });
      }

      const provider = await checkoutRail(c, found.rail);
      const session = await provider.createPortalSession(
        {
          providerAccountId: found.providerAccountId,
          // Undefined for a rail whose portal takes no return parameter — Lemon Squeezy's is a signed,
          // expiring link with nowhere to go back to, and Paddle's takes none at all. The contract admits
          // that rather than have the rail silently drop a URL an adopter configured.
          returnUrl: found.rail === "stripe" ? stripeSettings().portalReturnUrl : undefined,
          // **From the caller's own rows, never from a body.** A store that mints per-subscription deep
          // links mints authenticated ones, so naming a subscription is naming somebody's cancel button.
          // There is still no request field: the route reads what this caller owns.
          subscriptionIds: await ownSubscriptionIds(c, found.rail, subject),
        },
        { now: clock(), deployment: deploymentName(c) },
      );

      await c.var.emit({
        action: PaymentsAuditActions.portalOpened,
        outcome: "success",
        actorType: "user",
        actorId: c.var.auth?.userId,
        sessionId: c.var.auth?.sessionId,
        resourceType: "provider_account",
        resourceId: found.providerAccountId,
        metadata: { rail: found.rail, subjectType: subject.subjectType, subjectId: subject.subjectId },
      });
      return c.json(
        {
          url: session.url,
          ...(session.subscriptions === undefined ? {} : { subscriptions: [...session.subscriptions] }),
        } satisfies PaymentsPortalHandoffResponse,
        200,
      );
    });

    /**
     * CONTROL PLANE. Grant an entitlement by hand — a comped account, or the repair of a purchase that
     * verified and never projected.
     *
     * Support needs this on day one, and it is the more dangerous of the two: a caller that could reach it
     * could give itself anything the product sells. So it is a control-plane route and nothing else.
     * `requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE)` establishes authenticity — signature, registered
     * key, connection, environment, token lifetime, body digest, single use — before anything below runs, and
     * denies unless the adopter granted *that* operation. Holding the revoke scope confers nothing here: the
     * seam matches scopes exactly, with no prefix rule. The validator sits behind the gate, so a well-formed
     * body is never confirmed to a caller who may not send one.
     *
     * The write is a repair of the read model, not a purchase: null provenance, no purchase row, and the
     * projection stays authoritative for any key the catalog sells. See `entitlement/manual.ts`.
     */
    /**
     * AUTHED READ — what the caller's own subscription pays, and when that changes.
     *
     * The half that stops a bill changing unannounced. A discount that lapses with nothing having said so
     * is, from a customer's seat, indistinguishable from a billing error — so a screen offering a
     * twelve-month rate has to be able to say when the twelve months end.
     *
     * The caller's own holder, always: the subscription is found from rows keyed on the subject the seam
     * resolved, and there is no request field naming one. Answers `null` when that holder has no subscription
     * a rail can price, which is a fact rather than a failure.
     *
     * **`quotedFrom` rides here because a browser cannot price a customer it cannot name.** Paddle quotes
     * in the browser — `PricePreview` runs from the visitor's own page — and with no customer id it
     * quotes from the visitor's IP, which is where a browser connected from and not where a card is
     * registered. The charge settles on the billing address, so `POST /payments/checkout` hands the rail
     * the customer id from the provider-account map; this publishes **the same read of the same row** so
     * the quote and the charge cannot resolve location differently. A caller with no store customer yet
     * gets null, quotes from their IP, and is told the figure is an estimate.
     *
     * Beside `pricing` rather than inside it, because the two are independent: somebody who has never
     * bought anything has no pricing and may still have no customer, and somebody mid-subscription has
     * both. Nesting one in the other would make the common case unreachable.
     */
    app.get(`${base}/pricing`, requireAuth(), async (c) => {
      const subject = await resolvePaymentsSubject(c, seam);
      // A read, so nobody resolved is the empty answer rather than a refusal — the same direction
      // `GET {base}/entitlements` takes, and for the same reason: a screen with no billing account selected
      // is quoting from nothing, which is a fact rather than a failure.
      if (subject === undefined)
        return c.json({ pricing: null, quotedFrom: null } satisfies PaymentsPricingEnvelope, 200);
      const db = paymentsDatabase(database(c));

      // The one read, shared with `/checkout`. `accountFor` is what that route calls to decide who is
      // charged, so a screen quoting from this answer is quoting from the row that will be billed.
      const paddleCustomer = await accountFor(c, "paddle", subject);
      const quotedFrom: PaymentsQuotedFrom | null =
        paddleCustomer === null ? null : { rail: "paddle", providerAccountId: paddleCustomer };
      /** The envelope, so every exit below carries both facts rather than three of them carrying one. */
      const answer = (pricing: PaymentsPricingResponse | null) =>
        c.json({ pricing, quotedFrom } satisfies PaymentsPricingEnvelope, 200);

      // The newest subscription row this caller holds on a rail that can price one. `role` matters: a money
      // row records a closed period and has no "next".
      const rows = await db
        .selectFrom(PAYMENTS_PURCHASES_TABLE)
        .selectAll()
        .where("subjectType", "=", subject.subjectType)
        .where("subjectId", "=", subject.subjectId)
        .where("type", "=", "subscription")
        .orderBy("providerEventAt", "desc")
        .execute();
      // The row that carries the subscription's *standing*, preferred over any receipt.
      //
      // On Lemon Squeezy a subscriber's newest rows are `charge` receipts — one per invoice — and a receipt
      // names a closed period no rail can price. Taking the newest of any role therefore returned null for
      // every LS subscriber while looking like it had worked. Every other rail writes `charge` for
      // everything and has no `state` row, so the fallback is what serves them.
      const row = rows.find((candidate) => candidate.role === "state") ?? rows[0];
      if (row === undefined) return answer(null);

      const purchase = PaymentsPurchase.parse(row);
      const provider = resolveRailProvider(purchase.rail, config, await credentials(c), trust);
      if (!isPricingRail(provider)) return answer(null);

      const pricing = await provider.readPricing(purchase, { now: clock(), deployment: deploymentName(c) });
      if (pricing === undefined) return answer(null);

      return answer({
        currency: pricing.currency,
        currentAmountMinor: pricing.currentAmountMinor,
        listAmountMinor: pricing.listAmountMinor,
        discountCode: pricing.discountCode,
        discountEndsAt: pricing.discountEndsAt === null ? null : pricing.discountEndsAt.toISOString(),
      });
    });

    /**
     * AUTHED READ — where the caller's own subscription stands, read live from the store.
     *
     * **This route ships before the four verbs beside it, and that ordering is the lesson of #247**, which
     * the module doc above records verbatim: payments shipped `entitlements/grant` and
     * `entitlements/revoke` with no read beside them, and a dashboard's panes computed *absent* against a
     * live manifest and dropped out of the rail entirely. A capability that can cancel a subscription and
     * cannot report the cancellation ships the half that creates the support ticket.
     *
     * **Live, never from the projected row, because the one fact this exists to report is the one a row
     * does not carry.** With a cancellation scheduled Paddle answers `status: "active"`, `canceled_at:
     * null` and `next_billed_at: null` (recorded 2026-08-28, #465): two of the three say the subscription
     * is fine and the third says nothing at all. The end date lives only on `scheduled_change.effective_at`,
     * and the webhook that would have announced it can be dropped.
     *
     * **`null` is a real answer and a common one** — somebody who has never bought anything, and somebody
     * whose store has nothing to say about the row. Not a 404: that would make this an existence oracle and
     * would read, to a screen, exactly like a Worker that could not be reached.
     *
     * The subject comes from the seam and the subscription from that subject's own rows, so there is no
     * shape of this request that reads somebody else's. Nobody resolved is the empty answer rather than a
     * refusal, which is the read half of the seam's rule and what `GET {base}/entitlements` already does.
     */
    app.get(`${base}/subscription`, requireAuth(), async (c) => {
      const subject = await resolvePaymentsSubject(c, seam);
      if (subject === undefined) return c.json({ subscription: null } satisfies PaymentsSubscriptionResponse, 200);

      const target = await changeableSubscription(database(c), subject, clock());
      // Two subscriptions have no encoding in an envelope that holds one, and picking is the defect the
      // whole resolver exists to prevent. The refusal is the same one every verb gives.
      if (target.found === "many") throw tooManySubscriptions(target.purchases);
      if (target.found === "none") return c.json({ subscription: null } satisfies PaymentsSubscriptionResponse, 200);

      const provider = await subscriptionRail(c, target.purchase.rail);
      const standing = await provider.readStanding(target.purchase, { now: clock(), deployment: deploymentName(c) });
      // A rail that cannot address this purchase, or a store that no longer knows it. A fact about the
      // purchase rather than a failure — a store that could not be *reached* raises
      // `payments/provider_unavailable` instead, so a screen distinguishes the two.
      if (standing === undefined) return c.json({ subscription: null } satisfies PaymentsSubscriptionResponse, 200);

      return c.json(
        {
          subscription: subscriptionView(target.purchase.productId, standing),
        } satisfies PaymentsSubscriptionResponse,
        200,
      );
    });

    /**
     * AUTHED READ — what moving to one catalog product would cost, as the store previews it.
     *
     * **A read that discloses a price, and a `POST` only because it carries a body.** It commits nothing,
     * stores nothing and writes no audit row: a quote goes stale the moment the billing period moves, and a
     * persisted one is a price nobody is bound by.
     *
     * **The no-op rule does not apply to a preview.** Asking what the plan already held would cost is a
     * question with an honest answer, and a second preview is free. Borrowing the writes' short-circuit
     * would mean inventing a recurring figure to fill the quote with, which is the one thing this package
     * will not do.
     *
     * The subscription comes from the caller's own rows and the price from the catalog, exactly as on
     * `change` — the two routes share {@link SubscriptionPreviewRequest}, which *is*
     * {@link SubscriptionChangeRequest}, so a preview cannot quote a figure the commit then refuses.
     *
     * `requirePaymentsSubject`, not `resolvePaymentsSubject`, even though this is a read. The seam's rule
     * gives a read two honest answers — empty or denied — and a quote has no empty form: a figure is what
     * this route exists to produce. With no holder selected there is no subscription to quote, and
     * `payments/subject_unresolved` says exactly that, where a 404 would claim the caller has no
     * subscription anywhere.
     */
    app.post(
      `${base}/subscription/preview`,
      requireAuth(),
      zValidator("json", SubscriptionPreviewRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const subject = await requirePaymentsSubject(c, seam);
        const purchase = requireOneSubscription(await changeableSubscription(database(c), subject, clock()));
        const entry = product(config, input.productId);
        const sku = subscriptionPrice(entry, purchase.rail);

        const provider = await subscriptionRail(c, purchase.rail);
        const quote = await provider.previewChange(
          // The row, never an id off it: what identifies a subscription at its store differs per rail and
          // some of it survives only in the payload. See `SubscriptionChangeInput.purchase`.
          { purchase, providerProductId: sku },
          // The only rail call carrying a locale, because it is the only one whose answer carries money a
          // person reads. See `RailRequestContext.locale`.
          { now: clock(), deployment: deploymentName(c), locale: readerLocale(c) },
        );
        return c.json({ quote: quoteView(quote) } satisfies PaymentsSubscriptionQuoteResponse, 200);
      },
    );

    /**
     * AUTHED WRITE — move the caller's own subscription onto one catalog product.
     *
     * **Nothing this route needs comes from the request but the product.** The subscription is resolved
     * from the caller's own purchase rows ({@link changeableSubscription}), the rail from that row, and the
     * store's price from the catalog. A body-named subscription moves somebody else's; a body-named price
     * moves a customer onto a plan this project does not sell; a body-named rail is the wrong store asked
     * about a subscription that does not live there. None of the three is refused by a check — each is
     * unreachable because there is nowhere to write it.
     *
     * **No proration mode and no `on_payment_failure`, for the same reason.** The rail picks the mode from
     * the *direction* of the change — up charges now, down defers the credit to the next invoice — and
     * always prevents a change that cannot be paid for. A mode a client could set is a mode a client would
     * eventually set to Paddle's `do_not_bill`, which is a free upgrade.
     *
     * **This route writes no purchase row.** The webhook owns that row; a route that also wrote it would be
     * a second producer of one row, and the two disagree the first time a webhook is late. So the response
     * is the store's own answer to where the subscription now stands, and the plan named on it is the one
     * the store just confirmed rather than the one the stale row still carries.
     *
     * **The no-op is a success and leaves no trail.** A change to the plan already held returns the current
     * standing without calling the provider — the rail's rule, and the route must not turn it into a 409.
     * The audit row is withheld with it: a retried write must not become a second proration, and it must
     * not become a second row asserting a change that did not happen either. The route decides that from
     * its own row rather than from the rail, which reports no such flag, and the residual gap is stated at
     * {@link changedPlan}.
     */
    app.post(
      `${base}/subscription/change`,
      requireAuth(),
      zValidator("json", SubscriptionChangeRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const subject = await requirePaymentsSubject(c, seam);
        const purchase = requireOneSubscription(await changeableSubscription(database(c), subject, clock()));
        const entry = product(config, input.productId);
        const sku = subscriptionPrice(entry, purchase.rail);
        // Decided *before* the call, from the row as it stands. See {@link changedPlan}.
        const changed = changedPlan(purchase, entry.id);

        const provider = await subscriptionRail(c, purchase.rail);
        const standing = await provider.changePlan(
          { purchase, providerProductId: sku },
          { now: clock(), deployment: deploymentName(c) },
        );

        if (changed) {
          await c.var.emit({
            action: PaymentsAuditActions.subscriptionPlanChanged,
            outcome: "success",
            // The person who asked, always — the holder they act for rides in the metadata. Under
            // organization billing the two differ, and collapsing them answers "who did this" with a
            // company rather than with somebody who can be asked about it.
            actorType: "user",
            actorId: c.var.auth?.userId,
            sessionId: c.var.auth?.sessionId,
            resourceType: "purchase",
            resourceId: purchase.id,
            // Both plans, in both vocabularies, and no money. A quote is not what was charged, and copying
            // an amount here would make a second, weaker ledger beside the purchases table.
            metadata: {
              rail: purchase.rail,
              subjectType: subject.subjectType,
              subjectId: subject.subjectId,
              productId: entry.id,
              fromProductId: purchase.productId,
              providerProductId: sku,
              fromProviderProductId: purchase.providerProductId,
            },
          });
        }

        return c.json(
          // `entry.id`, not the row's product: the store has applied the move and the row has not caught up.
          { subscription: subscriptionView(entry.id, standing) } satisfies PaymentsSubscriptionStandingResponse,
          200,
        );
      },
    );

    /**
     * AUTHED WRITE — stop the caller's own subscription renewing.
     *
     * **`at_period_end` is the settled policy and the timing is still stated, never defaulted.** The two
     * timings are different things to buy — keep the period already paid for, or lose it today — and a body
     * that omitted the field would be choosing one of them by silence. `now` exists because support
     * occasionally has to end a subscription today, and because a policy with no legitimate exit gets
     * departed from by a direct provider call nothing audits.
     *
     * The subscription is the caller's own, resolved from their rows; nothing in the body names one. The
     * customer's word is what crosses, and the rail translates it — Paddle's `next_billing_period` does not
     * parse here, so a client that stopped translating fails loudly rather than sending a string Paddle
     * happens to accept.
     *
     * **The no-op is a success and is not audited.** A cancellation already scheduled for the timing asked
     * for is the state the caller wanted, so there is nothing to refuse; and a retried cancel must not
     * leave a trail claiming two of them. The standing is read before the write and compared afterwards —
     * see {@link standingMoved} for why that is the honest test and not a second copy of the rail's rule.
     *
     * Writes no purchase row, as every route here does not: the webhook owns it.
     */
    app.post(
      `${base}/subscription/cancel`,
      requireAuth(),
      zValidator("json", SubscriptionCancelRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const subject = await requirePaymentsSubject(c, seam);
        const purchase = requireOneSubscription(await changeableSubscription(database(c), subject, clock()));

        const provider = await subscriptionRail(c, purchase.rail);
        const context = { now: clock(), deployment: deploymentName(c) };
        // Read before written, because a scheduled cancellation is the one fact the purchase row cannot
        // carry and therefore the one thing that decides whether this request changed anything.
        const before = await provider.readStanding(purchase, context);
        const standing = await provider.cancelSubscription({ purchase, timing: input.timing }, context);

        if (standingMoved(before, standing)) {
          await c.var.emit({
            action: PaymentsAuditActions.subscriptionCanceled,
            outcome: "success",
            actorType: "user",
            actorId: c.var.auth?.userId,
            sessionId: c.var.auth?.sessionId,
            resourceType: "purchase",
            resourceId: purchase.id,
            // The timing asked for, and the day it lands. That day is the answer to "when does this person
            // lose access", and on a scheduled cancellation it exists nowhere else — the status still says
            // active and the next billing date has gone blank.
            metadata: {
              rail: purchase.rail,
              subjectType: subject.subjectType,
              subjectId: subject.subjectId,
              productId: purchase.productId,
              timing: input.timing,
              effectiveAt: standing.scheduledChange?.effectiveAt.toISOString() ?? null,
            },
          });
        }

        return c.json(
          {
            subscription: subscriptionView(purchase.productId, standing),
          } satisfies PaymentsSubscriptionStandingResponse,
          200,
        );
      },
    );

    /**
     * AUTHED WRITE — withdraw a scheduled cancellation, so the caller's subscription renews after all.
     *
     * **No body at all, and no validator, exactly as `POST {base}/portal` has none.** Which subscription is
     * the server's answer, and there is nothing to say about it but *do not*. A `z.object({})` would read as
     * a refusal of everything and be neither — Zod strips rather than refuses — while making a POST with no
     * body a 400 on a route that wants none.
     *
     * **It withdraws a cancellation and only a cancellation, and that check is the rail's.** Paddle offers
     * no narrower verb: the update clears `scheduled_change` wholesale, and that field also holds a
     * scheduled pause and a scheduled resume — so a rail that simply sent the clear would restart billing
     * on a paused account, on a request that said nothing about pausing. The rail re-reads and refuses
     * anything but a pending `cancel`. **The check cannot move here:** this route holds a projected row, and
     * the pending action lives only at the store.
     *
     * **Its own route and its own audit action, not an outcome on the cancellation.** The two are separate
     * acts by possibly separate actors, and the pair is what a dispute is reconstructed from. Folded
     * together, the trail asserts a cancellation and holds nothing saying it was taken back.
     *
     * A subscription with nothing scheduled is the no-op rather than a refusal — it already renews, which
     * is what the caller asked for — and it writes no audit row, for {@link standingMoved}'s reason.
     */
    app.post(`${base}/subscription/keep`, requireAuth(), async (c) => {
      const subject = await requirePaymentsSubject(c, seam);
      const purchase = requireOneSubscription(await changeableSubscription(database(c), subject, clock()));

      const provider = await subscriptionRail(c, purchase.rail);
      const context = { now: clock(), deployment: deploymentName(c) };
      const before = await provider.readStanding(purchase, context);
      const standing = await provider.keepSubscription(purchase, context);

      if (standingMoved(before, standing)) {
        await c.var.emit({
          action: PaymentsAuditActions.subscriptionCancelWithdrawn,
          outcome: "success",
          actorType: "user",
          actorId: c.var.auth?.userId,
          sessionId: c.var.auth?.sessionId,
          resourceType: "purchase",
          resourceId: purchase.id,
          metadata: {
            rail: purchase.rail,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            productId: purchase.productId,
          },
        });
      }

      return c.json(
        { subscription: subscriptionView(purchase.productId, standing) } satisfies PaymentsSubscriptionStandingResponse,
        200,
      );
    });

    /**
     * AUTHED WRITE — ask the store to give this subscription's payments back.
     *
     * **A request, and the response never says otherwise.** Paddle holds most live refunds at
     * `pending_approval` until a person there reviews them, so nothing here revokes an entitlement, writes a
     * purchase row, or touches a projection. The approval, when it comes, arrives as a webhook, and
     * `rails/paddle/adjustments.ts` and the projection writer are the only things that act on it. Revoking
     * on the *request* would take access from a customer whose refund the store then rejects, leaving them
     * with neither the money nor the product.
     *
     * **No body, exactly as `keep` has none.** Which subscription is the server's answer, which payments is
     * the server's answer, and how much is not a question anyone may ask: every refund raised here is for a
     * transaction's whole total. A body naming a transaction refunds a stranger's money; a body naming an
     * amount is a self-service withdrawal; a body naming a reason writes free text into the adopter's own
     * back office. None of the three is refused by a check — each is unreachable because there is nowhere to
     * write it.
     *
     * **It refunds every payment on the subscription, and applies no window.** How many days a customer has
     * to ask is the *adopter's* commercial policy, and a kit that hard-coded fourteen would be wrong for the
     * second adopter. The kit makes the refund possible; the adopter's screen decides which button exists.
     * See {@link refundablePayments}.
     *
     * **A partial cannot be silent.** The rail refuses the whole request before it writes anything and
     * reports every outcome once it has — {@link RefundRail} holds the argument — and the response carries
     * one entry per payment, so a caller counting entries and a caller counting their own payments get the
     * same number.
     *
     * **The audit row is the only record that a refund was asked for**, until and unless the store approves
     * one. It is withheld when nothing was raised, which is the retry: a request repeated against refunds
     * already standing is the state the caller wanted, and a trail claiming two of them is worse than one
     * claiming none.
     */
    app.post(`${base}/subscription/refund`, requireAuth(), async (c) => {
      const subject = await requirePaymentsSubject(c, seam);
      const purchase = requireOneSubscription(await changeableSubscription(database(c), subject, clock()));
      // The rail is narrowed **before** the payments are resolved, and the order is the answer a caller
      // gets. "This store does not refund from the server" is true of every payment on the subscription and
      // is what an Apple or Google subscriber needs to hear; "there is no payment to refund" would be the
      // same 409 they would get if they had never paid, and it would send them looking for the wrong thing.
      const provider = await refundRail(c, purchase.rail);
      const payments = await refundablePayments(database(c), subject, purchase);
      if (payments.length === 0) {
        // A 409 rather than an empty report, and rather than a 404. The subscription is there and the
        // request is well-formed; what is absent is a payment to refund, which is a fact about the account's
        // present state. An empty report would read as "refunded, nothing to do".
        throw new PaymentsSubscriptionChangeRefusedError({
          message: "There is no payment on this subscription to refund.",
          action: "Check the subscription's payment history. A refund attaches to a payment, not to a plan.",
          detail: `No charge rows resolved on ${purchase.rail} for the family this subscription heads.`,
        });
      }

      const refund = await provider.requestRefunds(
        {
          purchases: payments,
          // Composed here and never read from a body: it is written into the adopter's own store console,
          // where a person reads it as a statement about their business. The catalog product and nothing
          // else — no customer text, no identifier a store does not already hold.
          reason: `Refund requested by the subscriber for "${purchase.productId}".`,
        },
        { now: clock(), deployment: deploymentName(c) },
      );

      const raised = refund.outcomes.filter((outcome) => outcome.outcome === "requested");
      if (raised.length > 0) {
        await c.var.emit({
          action: PaymentsAuditActions.subscriptionRefundRequested,
          outcome: "success",
          // The person who asked, always — the holder they act for rides in the metadata.
          actorType: "user",
          actorId: c.var.auth?.userId,
          sessionId: c.var.auth?.sessionId,
          resourceType: "purchase",
          resourceId: purchase.id,
          // Counts and the store's own handles on the money in flight. **No amount**: how much anybody is
          // getting back is the store's later decision, and a figure here would assert something nobody has
          // agreed to, in the one table nothing corrects.
          metadata: {
            rail: purchase.rail,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            productId: purchase.productId,
            payments: refund.outcomes.length,
            requested: raised.length,
            alreadyRequested: refund.outcomes.filter((outcome) => outcome.outcome === "already_requested").length,
            failed: refund.outcomes.filter((outcome) => outcome.outcome === "failed").length,
            adjustmentIds: raised.map((outcome) => outcome.adjustmentId),
          },
        });
      }

      return c.json({ refund: refundView(refund) } satisfies PaymentsRefundResponse, 200);
    });

    /**
     * CONTROL PLANE. The discount codes this project has issued.
     *
     * Read from the store rather than from a table of ours: the store is where a code actually exists, and a
     * local mirror would be a second answer that drifts the first time somebody uses the dashboard.
     *
     * Its own scope, narrower than minting. A pane that lists what was issued does not need the power to
     * issue. Never reaches a browser — the set of codes an adopter has issued is a commercial fact, and the
     * client projection draws the same line here it draws for SKUs.
     */
    app.get(
      `${base}/admin/discounts`,
      requireControlPlane(PAYMENTS_DISCOUNT_READ_SCOPE),
      zValidator("query", AdminDiscountsQuery, validationHook),
      async (c) => {
        const { rail } = c.req.valid("query");
        const provider = resolveRailProvider(rail, config, await credentials(c), trust);
        if (!isDiscountRail(provider)) {
          throw new PaymentsRailNotConfiguredError({ detail: `The ${provider.rail} rail does not mint discounts.` });
        }

        const discounts = await provider.listDiscounts({ now: clock(), deployment: deploymentName(c) });

        // Through `recordRead`, like every other management read: its own action, the caller's `sub` as the
        // actor, and a count rather than the rows.
        await recordRead(c, PaymentsAuditActions.discountsRead, rail, { rail, count: discounts.length });

        return c.json({ discounts: [...discounts] } satisfies PaymentsAdminDiscountsResponse, 200);
      },
    );

    /**
     * CONTROL PLANE. Mint a discount code at one store.
     *
     * **Its own scope**, `payments:discounts:create`, granted separately from the entitlement writes.
     * Comping somebody an entitlement and creating a code that reduces what everybody holding it pays are
     * different powers with different blast radii, and a tool that needs one must not acquire the other.
     *
     * **The kit provides the verb; the adopter provides the policy.** This creates the object at the store
     * and answers with what it made. Who may be offered a code, what it is worth, where that offer is
     * recorded and when it stops being advertised are commercial decisions with a company's pricing behind
     * them — a capability that guessed at them would be wrong for the second adopter.
     *
     * Applying a code does **not** go through here and does not require this scope. An adopter whose codes
     * are minted by hand in a provider dashboard is fully served by `/checkout`'s `discountCode`.
     */
    app.post(
      `${base}/admin/discounts`,
      requireControlPlane(PAYMENTS_DISCOUNT_CREATE_SCOPE),
      zValidator("json", DiscountCreateRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const provider = resolveRailProvider(input.rail, config, await credentials(c), trust);
        if (!isDiscountRail(provider)) {
          // Structural, so a rail that gains the ability needs no edit here and one that never will can
          // never be asked.
          throw new PaymentsRailNotConfiguredError({
            detail: `The ${provider.rail} rail does not mint discounts.`,
          });
        }

        const created = await provider.createDiscount(input.terms, { now: clock() });

        const who = controlPlaneCaller(c);
        await c.var.emit({
          action: PaymentsAuditActions.discountCreated,
          outcome: "success",
          // The token's `sub`, so the trail names which person at the dashboard minted it rather than merely
          // "the dashboard" — one connection is normally shared by everybody using that console.
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "discount",
          resourceId: created.providerDiscountId,
          // What was minted and what it is worth, and the **store's id** rather than the code itself. The
          // code is a live bearer value: anyone who can read the trail could redeem it, and an audit trail
          // is queryable, long-lived, and read by more people than can mint. The id finds it in the
          // dashboard, which is where somebody entitled to see the code already is.
          metadata: {
            rail: input.rail,
            connectionId: who.connectionId,
            amount:
              created.terms.amount.kind === "percent"
                ? `${created.terms.amount.percent}%`
                : `${created.terms.amount.amountMinor} ${created.terms.amount.currency}`,
            duration: created.terms.duration.kind,
          },
        });

        return c.json(
          {
            code: created.code,
            providerDiscountId: created.providerDiscountId,
            rail: input.rail,
          } satisfies PaymentsDiscountResponse,
          200,
        );
      },
    );

    app.post(
      `${base}/entitlements/grant`,
      requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE),
      zValidator("json", EntitlementGrantRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        // **A grant under the kind this project does not bill is refused here**, and this is the one check
        // that genuinely belongs at the edge rather than at the write. `grantEntitlement` reads a config to
        // check the entitlement key against the catalog; the kind is a different question with a different
        // answer, and `revokeEntitlement` takes no config at all — so pushing this down would either grow a
        // parameter the revoke must never have, or apply to both. The asymmetry is deliberate and is the
        // same one the catalog check makes: a grant is constrained, a revoke stays legal forever, because a
        // revoke that a config edit made impossible would strand whoever still holds the row.
        //
        // The failure it prevents is the invisible kind #300 exists for. A comp written as `user:ada` in a
        // project that bills organizations lands in the table, answers 200, and is read by nothing: every
        // gate resolves the caller's *organization*, so the person is still locked out and the row says
        // otherwise. Not audited as a denial, unlike the catalog miss — there is nothing to enumerate here,
        // because `billingSubject` is one bit, fixed at deploy, and the message names it outright.
        if (input.subjectType !== config.billingSubject) {
          throw new ValidationError({
            message: `This project bills ${config.billingSubject}s, not ${input.subjectType}s.`,
            action: "Send `subjectType` as the kind this project bills, or change `billingSubject` in pithy.config.ts.",
            detail: `A grant to a ${input.subjectType} here writes a row keyed on a kind no read path resolves, so the holder stays unentitled and the table says otherwise.`,
          });
        }
        // The catalog check lives in `grantEntitlement`, at the write (#305). This route no longer decides
        // whether a key means something — it reports the refusal, which is a different job and the only one
        // an edge should have. Anything else here would be a second copy of the rule, and a second copy is
        // how the first one stops being the rule.
        let granted: PaymentsEntitlement;
        try {
          granted = await grantEntitlement(
            database(c),
            config,
            {
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              entitlement: input.entitlement,
              expiresAt: input.expiresAt ?? null,
            },
            { now: clock() },
          );
        } catch (cause) {
          // The refusal is the outcome worth recording here, and it was the only one not recorded. A
          // credential scoped only to grant can otherwise enumerate this project's entitlement vocabulary
          // one key at a time — 400 for a miss, 200 for a hit — and leave the customer nothing to read
          // afterwards. One refusal is a typo; a run of them against one connection is somebody mapping
          // what a project sells.
          //
          // `safeEmit` for the same reason the webhook guard uses it: the 400 is already decided, and an
          // audit write that threw would answer 500 for a failing store and 400 for a healthy one.
          if (cause instanceof PaymentsEntitlementNotInCatalogError) {
            await safeEmit(
              c.var.emit,
              {
                action: PaymentsAuditActions.entitlementGranted,
                outcome: "denied",
                severity: "warning",
                actorType: "service",
                actorId: c.var.controlPlane?.connectionId ?? "control-plane",
                resourceType: "entitlement",
                resourceId: input.entitlement,
                // The route and the submitted key, and nothing else the caller supplied. The key is safe to
                // record — `EntitlementKey` has already bounded it to `^[a-z][a-z0-9_]*$` at 64 characters —
                // and it is the only field that makes a run of refusals legible. Never the catalog: the
                // defined set goes in `detail`, which the codec strips, and must not be copied into a
                // queryable, long-lived trail.
                metadata: { route: "entitlements/grant", entitlement: input.entitlement },
              },
              c.var.log,
            );
          }
          throw cause;
        }
        await c.var.emit({
          action: PaymentsAuditActions.entitlementGranted,
          outcome: "success",
          // Notable, not routine: nothing else in this package writes an entitlement no store paid for.
          severity: "warning",
          // A management client, not a user of this app — so `control-plane`, and the actor is the token's
          // `sub`: which person at the dashboard did this, not merely "the dashboard". No `sessionId`, because
          // a control-plane call creates none and a null one would read as a correlation that got lost.
          actorType: "control-plane",
          actorId: caller.subject,
          resourceType: "entitlement",
          resourceId: granted.id,
          // The holder is the queryable fact — "what has been comped to this subject" is the question the
          // trail gets asked. The connection joins it to *which* management client, per adopter and per
          // environment, which the actor's own id space cannot answer on its own.
          metadata: {
            connectionId: caller.connectionId,
            // Two keys, never one joined string: "what has been comped to this holder" is a query, and a
            // trail is queried by equality on a column.
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            entitlement: input.entitlement,
            expiresAt: granted.expiresAt?.toISOString() ?? null,
          },
        });
        return c.json(
          {
            entitlement: entitlementView({
              key: granted.entitlement,
              active: granted.active,
              expiresAt: granted.expiresAt,
            }),
          } satisfies PaymentsEntitlementResponse,
          200,
        );
      },
    );

    /**
     * CONTROL PLANE. Revoke an entitlement by hand — a chargeback, an abuse decision, a comp withdrawn.
     *
     * Immediate, because the read model is what every gate hits: the account loses access on its next
     * request. Idempotent, and legal against an account that never held the key — the inactive row is the
     * record that somebody decided it, and support tooling should not have to ask first.
     *
     * Its own scope, `payments:entitlements:revoke`, granted separately from grant's. Taking paid access away
     * from a live customer and handing product out for free are different mistakes with different victims, and
     * an adopter's refund tooling has no business being able to make the second one.
     */
    app.post(
      `${base}/entitlements/revoke`,
      requireControlPlane(PAYMENTS_ENTITLEMENT_REVOKE_SCOPE),
      zValidator("json", EntitlementRevokeRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        // **No billing-mode check here, and its absence is the design.** `revokeEntitlement` takes no config,
        // deliberately — see `entitlement/manual.ts` — so it has nothing to check a kind against, and giving
        // it one would make a `billingSubject` change as irreversible as a catalog edit: every row written
        // under the old kind would become unrevokable, on accounts that still hold it. A grant is
        // constrained and a revoke is not, exactly as with the catalog key.
        const revoked = await revokeEntitlement(
          database(c),
          { subjectType: input.subjectType, subjectId: input.subjectId, entitlement: input.entitlement },
          { now: clock() },
        );
        await c.var.emit({
          action: PaymentsAuditActions.entitlementRevoked,
          outcome: "success",
          severity: "warning",
          // Same attribution as the grant: the management client's own subject, and the connection it called
          // on. See that handler for why neither is a user id and why there is no session.
          actorType: "control-plane",
          actorId: caller.subject,
          resourceType: "entitlement",
          resourceId: revoked.id,
          metadata: {
            connectionId: caller.connectionId,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            entitlement: input.entitlement,
          },
        });
        return c.json(
          {
            entitlement: entitlementView({
              key: revoked.entitlement,
              active: revoked.active,
              expiresAt: revoked.expiresAt,
            }),
          } satisfies PaymentsEntitlementResponse,
          200,
        );
      },
    );
  };

  /**
   * The webhook handler, once, for every rail.
   *
   * By the time it runs the guard has verified authenticity, recorded the delivery, and short-circuited a
   * redelivery it already processed — and the rail has produced a normalized event or explained why it could
   * not. So this is entirely about what to do with a verified notification, and none of it is rail-specific:
   * three stores, three unrelated proofs, one projection.
   *
   * **Always 200 once authenticity is established.** Every provider retries a non-2xx, and every refusal that
   * can be reached here is deterministic — an unmapped SKU, a sandbox transaction against production, a
   * notification with nobody to project it against. Retrying those produces the identical refusal forever, so a
   * 5xx would buy a retry storm and no repair. The recorded row with its reason is what makes the failure
   * visible, queryable, and replayable instead. A failure that is *not* deterministic never gets here: the guard
   * lets `payments/provider_unavailable` through with its own status, so an unreachable store is a non-2xx the
   * provider will redeliver.
   */
  function webhookHandler(rail: PaymentsRail) {
    return async (c: Context<PithyHonoEnv>) => {
      const { notification, eventRowId } = verifiedWebhook(c);
      const now = clock();
      const d1 = database(c);

      /**
       * Record the delivery's outcome and put it on the audit trail. One shape for every non-projecting path.
       *
       * **`note` and `error` are the same sentence to an operator and opposite states in the row**, so the
       * call sites below say which they mean rather than letting the presence of a reason decide. A note is
       * why nothing was *ever* going to project — the row is finished. An error is why this attempt did not
       * — the row stays repairable. See {@link completeWebhook}; #339 is what happens when the two are one.
       */
      const acknowledge = async (outcome: {
        note?: string;
        error?: string;
        reason?: string;
        severity?: "warning";
      }): Promise<Response> => {
        await completeWebhook(
          d1,
          eventRowId,
          outcome.error !== undefined
            ? { at: now, error: outcome.error }
            : outcome.note !== undefined
              ? { at: now, note: outcome.note }
              : { at: now },
        );
        await c.var.emit({
          action: PaymentsAuditActions.webhookReceived,
          outcome: outcome.reason === undefined ? "success" : "failure",
          ...(outcome.severity === undefined ? {} : { severity: outcome.severity }),
          actorType: "service",
          actorId: rail,
          metadata: {
            rail,
            providerEventId: notification.providerEventId,
            projected: false,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          },
        });
        return c.json({ received: true, projected: false }, 200);
      };

      // Bind the store account to a user, when the notification carried both halves — before anything else,
      // because the pairing is worth keeping even for a delivery that projects nothing. On a rail Pithy
      // initiates, this is the *only* place the map is ever written: a Stripe webhook arrives carrying `cus_…`,
      // and the `client_reference_id` beside it is the reference `/checkout` set from the authenticated buyer.
      // `linkProviderAccount` never rebinds, so the first pairing wins and a later session cannot steal it.
      //
      // **The reference decodes or it names nobody.** It is a string that made a round trip through somebody
      // else's system, so a bare id — the shape every pre-subject client sent — and a kind this build does
      // not know both answer `undefined`, and `undefined` writes no link at all. Reading a bare id as a user
      // would bind a store account to whoever happens to hold that id, which is the one guess this whole
      // design exists to refuse.
      const stamped =
        notification.accountReference === null || notification.accountReference === undefined
          ? undefined
          : decodeSubjectReference(notification.accountReference);
      if (notification.providerAccountId && stamped) {
        await linkProviderAccount(d1, rail, notification.providerAccountId, stamped, { now });
        await repairOrphans(c, rail, now);
        // And the pairing is worth acting on, not only keeping. An orphan is a purchase that arrived before
        // its owner was knowable, and this link is the event that makes it knowable — the one signal no
        // store redelivers on. See `projection/orphans.ts`; #341 is the ten sweeps that never projected.
      }

      /**
       * A refund reported by order id alone — Play's voided-purchase notification, the only one shaped this way.
       *
       * The rail cannot resolve it: Play's one-time lookup wants a product id the notification does not carry.
       * But the product is not Play's to supply. A Google purchase is keyed by its order id, so the row this
       * refund is about is one indexed read away, and it already knows its own product, owner, and family. The
       * notification is authentic and says the order was voided; that is the same statement Apple's `REFUND`
       * makes, and it needs no second opinion from the store.
       *
       * A void naming an order we never projected is genuinely unresolvable — a purchase from before this
       * capability was installed, or one that never reached us — so it is recorded with its reason, which is
       * what makes it findable later.
       */
      if (!notification.event && notification.voidedOrderId) {
        const voided = await paymentsDatabase(d1)
          .selectFrom(PAYMENTS_PURCHASES_TABLE)
          .selectAll()
          .where("rail", "=", rail)
          .where("providerTransactionId", "=", notification.voidedOrderId)
          .executeTakeFirst();
        if (voided) {
          const row = PaymentsPurchase.parse(voided);
          const projection = await projectPurchase(
            d1,
            {
              ...row,
              status: "refunded",
              revokedAt: now,
              // The store's own event time, so the monotonic rule orders this against whatever else arrives.
              providerEventAt: now,
              payload: notification.payload,
            },
            { config, environment: deploymentEnvironment(c), now },
          );
          await fulfill(c, projection);
          await completeWebhook(d1, eventRowId, { at: now });
          await c.var.emit({
            action: PaymentsAuditActions.webhookReceived,
            outcome: "success",
            actorType: "service",
            actorId: rail,
            resourceType: "purchase",
            resourceId: projection.purchase.id,
            metadata: {
              rail,
              providerEventId: notification.providerEventId,
              productId: projection.product.id,
              status: projection.purchase.status,
              outcome: projection.outcome,
              projected: true,
            },
          });
          return c.json({ received: true, projected: true, outcome: projection.outcome }, 200);
        }
        return await acknowledge({
          error: `${noteText(notification.note) ?? "voided purchase"} — no purchase is stored under that order id.`,
          reason: "orphaned",
          severity: "warning",
        });
      }

      // Authentic, and about no transaction. A test notification, a consumption request, a type the store
      // shipped after this package did. Where that needs an explanation the rail supplies one as a note.
      //
      // **A `note`, never an `error`, and these two branches are one state.** The rail has read the
      // notification and reported there is no transaction in it; a redelivery of the same bytes gets the
      // same answer, so the row is finished whether or not the rail explained itself. Recording the
      // explanation as an error was #339 — it left the row outstanding, which is this table's drift signal
      // and the guard's short-circuit both, on the deliveries that had nothing to repair.
      if (!notification.event) {
        const note = notification.note;
        if (note === null || note === undefined) return await acknowledge({});
        // **Which kind of note decides the state, and that is #341.** A note the delivered bytes state is
        // terminal, because the same bytes get the same answer from this build for ever. A note a *read*
        // produced is not: the read could have raced the purchase it asked about, or been made with a
        // credential that has since rotated, and finishing the row on it answered the redelivery that would
        // have carried the better answer with `duplicate`. See `NotificationNote`.
        return "stated" in note
          ? await acknowledge({ note: note.stated, reason: "unresolvable", severity: "warning" })
          : await acknowledge({ error: note.read, reason: "unresolvable", severity: "warning" });
      }

      const subject = await resolveNotificationOwner(paymentsDatabase(d1), rail, {
        providerAccountId: notification.providerAccountId,
        providerTransactionId: notification.event.providerTransactionId,
        originalTransactionId: notification.event.originalTransactionId,
      });
      if (!subject) {
        // Orphaned: nothing this server established names a holder, and no reference the store echoed back
        // decoded to one. No number of retries will conjure a link, so the row is what makes it repairable —
        // and nothing is projected, because the alternative to knowing is guessing, and a guess here grants
        // one customer's subscription to another.
        return await acknowledge({
          // The marker, not prose. An account linking has to be able to find exactly the rows that were
          // waiting on it, and this is the one condition it repairs — see `WEBHOOK_EVENT_ORPHANED`.
          error: `${WEBHOOK_EVENT_ORPHANED} no subject could be resolved for this notification`,
          reason: "orphaned",
          severity: "warning",
        });
      }

      let projection: PurchaseProjection;
      try {
        projection = await projectPurchase(
          d1,
          { ...notification.event, ...subject },
          { config, environment: deploymentEnvironment(c), now },
        );
      } catch (cause) {
        const reason = cause instanceof PithyError ? cause.payload.code : "unknown";
        return await acknowledge({
          error:
            cause instanceof PithyError
              ? `${reason}: ${cause.payload.detail ?? cause.payload.message}`
              : "projection failed",
          reason,
          severity: "warning",
        });
      }

      // A second event the same notification implied — the subscription's standing, where the one above was a
      // charge. Only Lemon Squeezy sends one, and only on a refund: the invoice row goes `refunded` so the
      // ledger claws back, and this stops the subscription granting, because the buyer has their money back.
      //
      // Projected with the same owner, and outside the catch above on purpose: it is the half that revokes
      // access, so a failure must reach the store as a non-2xx and be redelivered rather than be acknowledged
      // as handled. Never fulfilled — a `state` row refuses both credit and clawback by role.
      if (notification.stateEvent) {
        await projectPurchase(
          d1,
          { ...notification.stateEvent, ...subject },
          { config, environment: deploymentEnvironment(c), now },
        );
      }

      // Fulfillment sits outside that catch, and the asymmetry is deliberate. Every refusal the catch answers
      // is deterministic — an unmapped SKU, a sandbox transaction — so a retry reproduces it and a 200 is the
      // only sane answer. A fulfillment fault is transient by construction: a refused clawback is an outcome
      // rather than a throw, and a missing ledger fails at assembly. So it must reach the provider as a
      // non-2xx and be redelivered, which the stable grant ref makes free.
      await fulfill(c, projection);

      await completeWebhook(d1, eventRowId, { at: now });
      await c.var.emit({
        action: PaymentsAuditActions.webhookReceived,
        outcome: "success",
        actorType: "service",
        actorId: rail,
        resourceType: "purchase",
        resourceId: projection.purchase.id,
        metadata: {
          rail,
          providerEventId: notification.providerEventId,
          productId: projection.product.id,
          status: projection.purchase.status,
          outcome: projection.outcome,
          projected: true,
        },
      });
      return c.json({ received: true, projected: true, outcome: projection.outcome }, 200);
    };
  }
}
