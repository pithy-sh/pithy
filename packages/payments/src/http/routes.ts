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
import { listEntitlements, listPurchases, listSubscriptions, readEntitlements } from "../admin/read";
import { type PaymentsAuditAction, PaymentsAuditActions } from "../audit/actions";
import {
  grantableEntitlements,
  type PaymentsCatalogEntry,
  type PaymentsConfig,
  type PaymentsStripeSettings,
  providerProductId,
  railEnabled,
  resolveProduct,
} from "../config/config";
import type { PurchaseEnvironment } from "../data/purchase";
import { PaymentsPurchase } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
import { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } from "../data/tables";
import { grantEntitlement, revokeEntitlement } from "../entitlement/manual";
import {
  PaymentsEntitlementNotInCatalogError,
  PaymentsProductNotFoundError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
} from "../error/errors";
import { fulfillPurchase } from "../grants/apply";
import { linkProviderAccount, providerAccountForUser, resolveNotificationOwner } from "../projection/owner";
import { resolveEntitlements } from "../projection/resolve";
import { type PurchaseProjection, projectPurchase } from "../projection/writer";
import {
  type CheckoutRail,
  isCheckoutRail,
  isDiscountRail,
  isPricingRail,
  type PaymentsRailProvider,
} from "../rails/contract";
import { type RailTrustOptions, resolveRailProvider } from "../rails/providers";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
  requireAuth,
} from "./guards";
import type {
  PaymentsAdminCatalogResponse,
  PaymentsAdminDiscountsResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminSubscriptionsResponse,
  PaymentsAdminUserEntitlementsResponse,
  PaymentsDiscountResponse,
  PaymentsEntitlementResponse,
  PaymentsEntitlementsResponse,
  PaymentsHostedSessionResponse,
  PaymentsPricingResponse,
  PaymentsPurchaseResponse,
  PaymentsRestoreResponse,
} from "./responses";
import {
  AdminDiscountsQuery,
  AdminEntitlementsQuery,
  AdminPurchasesQuery,
  AdminSubscriptionsQuery,
  AdminUserParam,
  AppleWebhookNotification,
  CheckoutRequest,
  DiscountCreateRequest,
  EntitlementGrantRequest,
  EntitlementRevokeRequest,
  GoogleWebhookNotification,
  LemonSqueezyWebhookNotification,
  PurchaseSubmission,
  RestoreRequest,
  StripeWebhookNotification,
} from "./schemas";
import { adminCatalogView, adminEntitlementView, adminPurchaseView, entitlementView, purchaseView } from "./view";
import { completeWebhook, requireSignedWebhook, verifiedWebhook } from "./webhookGuard";

/**
 * The payments routes, their declared verification strategies, and what each accepts.
 *
 *   POST /payments/purchases            → verify a receipt, project it   (bearer | session)  json: PurchaseSubmission
 *   GET  /payments/entitlements         → the caller's entitlements      (bearer | session)  —
 *   POST /payments/restore              → rebind store history           (bearer | session)  json: RestoreRequest
 *   POST /payments/checkout             → Stripe Checkout Session        (bearer | session)  json: CheckoutRequest
 *   POST /payments/portal               → Stripe Billing Portal          (bearer | session)  —
 *   POST /payments/webhooks/apple       → ASSN V2                        (signed-webhook)    json: AppleWebhookNotification
 *   POST /payments/webhooks/google      → Play RTDN via Pub/Sub push     (signed-webhook)    json: GoogleWebhookNotification
 *   POST /payments/webhooks/stripe      → Stripe events                  (signed-webhook)    json: StripeWebhookNotification
 *   POST /payments/entitlements/grant   → comp or repair an entitlement  (control-plane)     json: EntitlementGrantRequest
 *   POST /payments/entitlements/revoke  → take one back                  (control-plane)     json: EntitlementRevokeRequest
 *
 *   GET  /payments/admin/catalog                → what this project sells        (control-plane: payments:catalog:read)        —
 *   GET  /payments/admin/purchases              → the purchase log, paged        (control-plane: payments:purchases:read)      query: AdminPurchasesQuery
 *   GET  /payments/admin/subscriptions          → the purchases that renew       (control-plane: payments:subscriptions:read)  query: AdminSubscriptionsQuery
 *   GET  /payments/admin/entitlements           → the entitlement model, paged   (control-plane: payments:entitlements:read)   query: AdminEntitlementsQuery
 *   GET  /payments/admin/entitlements/:userId   → one account's entitlements     (control-plane: payments:entitlements:read)   param: AdminUserParam
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
 * **Read-only, with no `POST` among them, and that is not an oversight.** The two writes this capability
 * offers are the ones support needs and each is separately scoped; nothing here widens them.
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
 * **Validators sit after the guards on every route line.** A validator ahead of a guard turns a 401 into a 400
 * and tells an unauthenticated caller which of its requests were well-formed. Config-backed resolution stays in
 * the handler and raises its own domain 404 — a schema constrains a string, it never replaces a lookup.
 *
 * ## What the handlers never trust
 *
 * The **product** comes from the verified payload's SKU, never from the request. A client-supplied product id
 * would let a caller present a cheap receipt as an expensive product. The **owner** comes from the
 * `AuthContext` seam on the authed routes and from the provider-account map on the webhook, never from a body.
 * The **environment** comes from this deployment's own `ENVIRONMENT` var, never from the payload: inferring it
 * from what the store said is exactly what lets a sandbox purchase grant a real entitlement.
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
 * The caller's own id. `requireAuth()` has run on every route that calls this, so a null `auth` is a wiring
 * mistake rather than an unauthenticated request — hence `InternalError`, not a 401.
 */
function callerId(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) throw new InternalError({ detail: "requireAuth() must run before a payments handler reads the caller." });
  return auth.userId;
}

/**
 * The verified management client behind a control-plane call. `requireControlPlane()` has run on every route
 * that calls this, so a null context is a wiring mistake rather than an unverified request — hence
 * `InternalError`, not a 401.
 *
 * Deliberately not {@link callerId}. A management client has no user row and no session, so there is nothing
 * here to read off `c.var.auth`; keeping the two accessors apart is what stops a control-plane caller from
 * being recorded as, or mistaken for, a user of this app.
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
   * The rails that create hosted sessions, in the order a product's blocks are considered.
   *
   * Order matters only when a product sells on both and the caller named neither — and in that case the
   * request is refused rather than resolved by this order, so nothing here is a silent policy. It exists to
   * make the refusal's message deterministic.
   */
  const CHECKOUT_RAILS: readonly PaymentsRail[] = ["stripe", "lemonSqueezy"];

  /**
   * Which hosted-checkout rail this request is for.
   *
   * A product declares its rails by carrying their blocks, so the candidates are the checkout-capable rails
   * this project has enabled *and* this product is listed on. One candidate is the common case and needs no
   * request field. Two, with the caller naming neither, is refused: picking one would decide who takes a
   * customer's money on their behalf, and an adopter selling on two rails means to offer the choice.
   */
  function checkoutRailFor(entry: PaymentsCatalogEntry, requested: PaymentsRail | undefined): PaymentsRail {
    const enabled = CHECKOUT_RAILS.filter((rail) => railEnabled(config, rail));

    // No hosted-checkout rail at all. That is a fact about the deployment rather than about the product —
    // a mobile-only project sells through Apple and Google and has no browser flow to start — so it is the
    // rail refusal, and it costs no credential read and no round-trip to give.
    if (enabled.length === 0) {
      throw new PaymentsRailNotConfiguredError({
        detail:
          "No hosted-checkout rail is on in this project's config, so there are no hosted flows to start. Enable `rails.stripe` or `rails.lemonSqueezy`.",
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

  /** The caller's store account on a rail, or null. What keeps one buyer to one Stripe customer. */
  async function accountFor(c: Context<PithyHonoEnv>, rail: PaymentsRail, userId: string): Promise<string | null> {
    return (await providerAccountForUser(paymentsDatabase(database(c)), rail, userId)) ?? null;
  }

  /** Verify one receipt through its rail and project it against the caller. Shared by submit and restore. */
  async function submit(c: Context<PithyHonoEnv>, rail: PaymentsRail, receipt: string): Promise<PurchaseProjection> {
    const now = clock();
    const d1 = database(c);
    const provider = resolveRailProvider(rail, config, await credentials(c), trust);
    const verified = await provider.verify(receipt, { now });
    const userId = callerId(c);

    // A purchase this deployment initiated names its own purchaser, and a submission from anyone else is refused
    // before it is projected. Only Stripe sets this — see `VerifiedPurchase.accountReference` for why an
    // app-supplied identifier like Apple's `appAccountToken` deliberately does not.
    if (verified.accountReference && verified.accountReference !== userId) {
      throw new PaymentsReceiptAlreadyOwnedError({
        detail: `${rail} purchase ${verified.event.providerTransactionId} was started for ${verified.accountReference}; ${userId} submitted it.`,
      });
    }

    // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt* the
    // rejection instead of raising it, and the workerd runtime then reports the adopted promise as an
    // unhandled rejection even though Hono's `onError` answers the request correctly. A refusal here is normal
    // traffic — a stale receipt, a sandbox transaction — so it must not read as a runtime fault in a log.
    const projection = await projectPurchase(
      d1,
      { ...verified.event, userId },
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
      const bound = await linkProviderAccount(d1, rail, verified.providerAccountId, userId, { now });
      // The binding never rebinds, so a disagreement means somebody else claimed this store account first.
      // That is legitimate often enough (a shared device, a reinstall against a new Pithy account) that
      // refusing would hand an attacker a way to lock the real owner out — so the first binding stands, this
      // caller keeps the purchase they just projected, and the collision is recorded for somebody to look at.
      if (bound !== userId) {
        await c.var.emit({
          action: PaymentsAuditActions.providerAccountContested,
          outcome: "denied",
          severity: "warning",
          actorType: "user",
          actorId: userId,
          resourceType: "provider_account",
          resourceId: `${rail}:${verified.providerAccountId}`,
          metadata: { rail, boundTo: bound, claimedBy: userId },
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
  async function fulfill(c: Context<PithyHonoEnv>, projection: PurchaseProjection): Promise<void> {
    await fulfillPurchase(database(c), projection, {
      config,
      emit: c.var.emit,
      now: () => clock().getTime(),
    });
  }

  /**
   * Every entitlement key a manual grant may name, computed once.
   *
   * The catalog is config and cannot change under a running Worker, so this is a constant of the
   * composition rather than something to recompute per request. It is also the set the catalog read
   * publishes, which is what keeps "what a client may offer" and "what a grant will accept" from being two
   * lists that drift.
   */
  const grantable = grantableEntitlements(config);

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
        const page = await listPurchases(database(c), query);
        await recordRead(c, PaymentsAuditActions.purchasesRead, query.userId ?? null, {
          returned: page.items.length,
          resumed: query.cursor !== undefined,
          filters: {
            userId: query.userId ?? null,
            rail: query.rail ?? null,
            status: query.status ?? null,
            environment: query.environment ?? null,
          },
        });
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
        const page = await listSubscriptions(database(c), query);
        await recordRead(c, PaymentsAuditActions.subscriptionsRead, query.userId ?? null, {
          returned: page.items.length,
          resumed: query.cursor !== undefined,
          filters: { userId: query.userId ?? null, status: query.status ?? null },
        });
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
        const page = await listEntitlements(database(c), query);
        await recordRead(c, PaymentsAuditActions.entitlementsRead, query.userId ?? null, {
          returned: page.items.length,
          resumed: query.cursor !== undefined,
          filters: { userId: query.userId ?? null, entitlement: query.entitlement ?? null },
        });
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
     * CONTROL PLANE. Everything one account is entitled to, resolved now.
     *
     * Unpaginated, because the table is keyed `UNIQUE (userId, entitlement)` and this is at most one row
     * per key. An account holding nothing is an empty list rather than a 404: an entitlement row appears
     * with the first purchase that grants one, so its absence is not a missing person — and a 404 would
     * make this surface an existence oracle for user ids.
     */
    app.get(
      `${base}/admin/entitlements/:userId`,
      requireControlPlane(PAYMENTS_ENTITLEMENTS_READ_SCOPE),
      zValidator("param", AdminUserParam, validationHook),
      async (c) => {
        const { userId } = c.req.valid("param");
        const now = clock();
        const rows = await readEntitlements(database(c), userId);
        await recordRead(c, PaymentsAuditActions.entitlementsRead, userId, { userId, returned: rows.length });
        return c.json(
          {
            userId,
            entitlements: rows.map((row) => adminEntitlementView(row, now)),
          } satisfies PaymentsAdminUserEntitlementsResponse,
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
      try {
        const projection = await submit(c, input.rail, input.receipt);
        await c.var.emit({
          action: PaymentsAuditActions.purchaseVerified,
          outcome: "success",
          actorType: "user",
          actorId: callerId(c),
          sessionId: c.var.auth?.sessionId,
          resourceType: "purchase",
          resourceId: projection.purchase.id,
          // Identifiers and outcomes only. Never the receipt: the trail is long-lived and queryable, and a
          // receipt is a bearer artifact.
          metadata: {
            rail: input.rail,
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
          metadata: { rail: input.rail, reason: cause instanceof PithyError ? cause.payload.code : "unknown" },
        });
        throw cause;
      }
    });

    /**
     * AUTHED READ. Always the caller's own — the id comes from the seam, never the request, so there is no
     * shape of this route that reads somebody else's entitlements. A pure read: repairing a stale row is the
     * reconciliation Workflow's job, and `expiresAt` is rechecked here on every request.
     */
    app.get(`${base}/entitlements`, requireAuth(), async (c) => {
      const entitlements = await resolveEntitlements(paymentsDatabase(database(c)), callerId(c), clock());
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
      const purchases: ReturnType<typeof purchaseView>[] = [];
      for (const receipt of input.receipts) purchases.push(purchaseView(await submit(c, input.rail, receipt)));

      const entitlements = await resolveEntitlements(paymentsDatabase(database(c)), callerId(c), clock());
      await c.var.emit({
        action: PaymentsAuditActions.purchaseRestored,
        outcome: "success",
        actorType: "user",
        actorId: callerId(c),
        sessionId: c.var.auth?.sessionId,
        metadata: { rail: input.rail, restored: purchases.length },
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
     * AUTHED WRITE — Stripe only. Create a hosted Checkout Session and hand back where to send the browser.
     *
     * Everything that decides what is bought and where the buyer is returned to comes from config or from the
     * seam, never from the body: the **price** from the catalog entry the product id resolves to, the **return
     * URLs** from `config.stripe`, and the **purchaser** from `c.var.auth`. A client that could name a price
     * could buy Pro for the price of a coin pack; one that could name a return URL could send a paying customer
     * to a page it controls; one that could name a purchaser could attach its purchase to another account.
     */
    app.post(`${base}/checkout`, requireAuth(), zValidator("json", CheckoutRequest, validationHook), async (c) => {
      const input = c.req.valid("json");
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

      const userId = callerId(c);
      const provider = await checkoutRail(c, rail);
      const session = await provider.createCheckoutSession(
        {
          providerProductId: sku,
          subscription: entry.product.type === "subscription",
          userId,
          // Reuse the buyer's existing store customer, so one buyer keeps one account and their billing portal
          // shows every purchase rather than only the last one's.
          providerAccountId: await accountFor(c, rail, userId),
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
        actorId: userId,
        sessionId: c.var.auth?.sessionId,
        resourceType: "product",
        resourceId: entry.id,
        metadata: {
          rail,
          productId: entry.id,
          subscription: entry.product.type === "subscription",
          // Whether one was used, never which. The trail is long-lived and a code is a commercial fact.
          discounted: input.discountCode !== undefined,
        },
      });
      return c.json({ url: session.url } satisfies PaymentsHostedSessionResponse, 200);
    });

    /**
     * AUTHED WRITE — Stripe only. Open the Billing Portal for the caller's own store account.
     *
     * No body at all, and that is the request contract: there is exactly one customer this caller may manage,
     * and it comes from the provider-account map. A `customer` field here would be the whole vulnerability —
     * any signed-in caller could open a session against somebody else's billing history and cancel it.
     */
    app.post(`${base}/portal`, requireAuth(), async (c) => {
      const userId = callerId(c);

      // Which rail this caller actually bought on, found by asking the account map rather than by taking it
      // from the request. Still no body: the caller names neither the customer nor the rail, so there is
      // nothing here anyone could point at somebody else's billing.
      const enabled = CHECKOUT_RAILS.filter((rail) => railEnabled(config, rail));
      // No hosted rail at all is a fact about the deployment, not about this caller — a mobile-only project
      // has no billing portal to open. Same refusal `/checkout` gives, rather than a 404 that reads as "you
      // have no account" to somebody who could never have had one.
      if (enabled.length === 0) {
        throw new PaymentsRailNotConfiguredError({
          detail:
            "No hosted-checkout rail is on in this project's config, so there is no billing portal to open. Enable `rails.stripe` or `rails.lemonSqueezy`.",
        });
      }

      let found: { rail: PaymentsRail; providerAccountId: string } | undefined;
      for (const rail of enabled) {
        const providerAccountId = await accountFor(c, rail, userId);
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
          detail: `No hosted-rail provider account is linked to ${userId}.`,
        });
      }

      const provider = await checkoutRail(c, found.rail);
      const session = await provider.createPortalSession(
        {
          providerAccountId: found.providerAccountId,
          // Undefined for a rail whose portal takes no return parameter — Lemon Squeezy's is a signed,
          // expiring link with nowhere to go back to. The contract admits that rather than have the rail
          // silently drop a URL an adopter configured.
          returnUrl: found.rail === "stripe" ? stripeSettings().portalReturnUrl : undefined,
        },
        { now: clock(), deployment: deploymentName(c) },
      );

      await c.var.emit({
        action: PaymentsAuditActions.portalOpened,
        outcome: "success",
        actorType: "user",
        actorId: userId,
        sessionId: c.var.auth?.sessionId,
        resourceType: "provider_account",
        resourceId: found.providerAccountId,
        metadata: { rail: found.rail },
      });
      return c.json({ url: session.url } satisfies PaymentsHostedSessionResponse, 200);
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
     * The caller's own, always: the subscription is found from the provider-account map keyed on the
     * authenticated user, and there is no request field naming one. Answers `null` when this caller has no
     * subscription a rail can price, which is a fact rather than a failure.
     */
    app.get(`${base}/pricing`, requireAuth(), async (c) => {
      const userId = callerId(c);
      const db = paymentsDatabase(database(c));

      // The newest subscription row this caller holds on a rail that can price one. `role` matters: a money
      // row records a closed period and has no "next".
      const rows = await db
        .selectFrom(PAYMENTS_PURCHASES_TABLE)
        .selectAll()
        .where("userId", "=", userId)
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
      if (row === undefined) return c.json({ pricing: null }, 200);

      const purchase = PaymentsPurchase.parse(row);
      const provider = resolveRailProvider(purchase.rail, config, await credentials(c), trust);
      if (!isPricingRail(provider)) return c.json({ pricing: null }, 200);

      const pricing = await provider.readPricing(purchase, { now: clock(), deployment: deploymentName(c) });
      if (pricing === undefined) return c.json({ pricing: null }, 200);

      return c.json(
        {
          pricing: {
            currency: pricing.currency,
            currentAmountMinor: pricing.currentAmountMinor,
            listAmountMinor: pricing.listAmountMinor,
            discountCode: pricing.discountCode,
            discountEndsAt: pricing.discountEndsAt === null ? null : pricing.discountEndsAt.toISOString(),
          } satisfies PaymentsPricingResponse,
        },
        200,
      );
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
        // The key is checked against what this project defines, and the check is here rather than on the
        // route line for the reason every config-backed resolution in this package is: a request schema
        // constrains a string, it is never built from a configured key set. `EntitlementKey` has already
        // said the key is well-formed; this says it means something.
        if (!grantable.has(input.entitlement)) {
          // The refusal is the outcome worth recording here, and it was the only one not recorded. A
          // credential scoped only to grant can otherwise enumerate this project's entitlement vocabulary
          // one key at a time — 400 for a miss, 200 for a hit — and leave the customer nothing to read
          // afterwards. One refusal is a typo; a run of them against one connection is somebody mapping
          // what a project sells.
          //
          // `safeEmit` for the same reason the webhook guard uses it: the 400 is already decided, and an
          // audit write that threw would answer 500 for a failing store and 400 for a healthy one.
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
              // and it is the only field that makes a run of refusals legible. Never the catalogue: the
              // defined set goes in `detail`, which the codec strips, and must not be copied into a
              // queryable, long-lived trail.
              metadata: { route: "entitlements/grant", entitlement: input.entitlement },
            },
            c.var.log,
          );

          throw new PaymentsEntitlementNotInCatalogError({
            message: `No entitlement "${input.entitlement}" is defined here.`,
            // The set goes in `detail`, which the HTTP codec strips. An operator reading the customer's
            // logs gets the near miss spelled out; the caller learns only which key it sent, because what
            // this project sells is a separate disclosure behind `payments:catalog:read`.
            detail: `No product grants "${input.entitlement}" and \`manualEntitlements\` does not declare it. Defined: ${[...grantable].sort().join(", ") || "nothing"}.`,
          });
        }
        const caller = controlPlaneCaller(c);
        const granted = await grantEntitlement(
          database(c),
          { userId: input.userId, entitlement: input.entitlement, expiresAt: input.expiresAt ?? null },
          { now: clock() },
        );
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
          // The subject account is the queryable fact — "what has been comped to this account" is the question
          // the trail gets asked. The connection joins it to *which* management client, per adopter and per
          // environment, which the actor's own id space cannot answer on its own.
          metadata: {
            connectionId: caller.connectionId,
            userId: input.userId,
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
        const revoked = await revokeEntitlement(
          database(c),
          { userId: input.userId, entitlement: input.entitlement },
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
          metadata: { connectionId: caller.connectionId, userId: input.userId, entitlement: input.entitlement },
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

      /** Record the delivery's outcome and put it on the audit trail. One shape for every non-projecting path. */
      const acknowledge = async (outcome: {
        error?: string;
        reason?: string;
        severity?: "warning";
      }): Promise<Response> => {
        await completeWebhook(d1, eventRowId, { at: now, error: outcome.error });
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
      if (notification.providerAccountId && notification.accountReference) {
        await linkProviderAccount(d1, rail, notification.providerAccountId, notification.accountReference, { now });
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
          error: `${notification.note ?? "voided purchase"} — no purchase is stored under that order id.`,
          reason: "orphaned",
          severity: "warning",
        });
      }

      // Authentic, and about no transaction. A test notification, a consumption request, a type the store
      // shipped after this package did. Where that needs an explanation the rail supplies one as a note.
      if (!notification.event) {
        return notification.note
          ? await acknowledge({ error: notification.note, reason: "unresolvable", severity: "warning" })
          : await acknowledge({});
      }

      const userId = await resolveNotificationOwner(paymentsDatabase(d1), rail, {
        providerAccountId: notification.providerAccountId,
        providerTransactionId: notification.event.providerTransactionId,
        originalTransactionId: notification.event.originalTransactionId,
      });
      if (!userId) {
        // Orphaned: the app set no account identifier and no purchase in this subscription's family has ever
        // been submitted. No number of retries will conjure a link, so the row is what makes it repairable.
        return await acknowledge({
          error: "no Pithy user could be resolved for this notification",
          reason: "orphaned",
          severity: "warning",
        });
      }

      let projection: PurchaseProjection;
      try {
        projection = await projectPurchase(
          d1,
          { ...notification.event, userId },
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
          { ...notification.stateEvent, userId },
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
