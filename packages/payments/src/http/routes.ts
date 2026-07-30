import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { InternalError, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { Context, Hono } from "hono";
import { PaymentsAuditActions } from "../audit/actions";
import {
  type PaymentsCatalogEntry,
  type PaymentsConfig,
  type PaymentsStripeSettings,
  providerProductId,
  resolveProduct,
} from "../config/config";
import type { PurchaseEnvironment } from "../data/purchase";
import { PaymentsPurchase } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
import { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } from "../data/tables";
import { grantEntitlement, revokeEntitlement } from "../entitlement/manual";
import {
  PaymentsProductNotFoundError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
} from "../error/errors";
import { fulfillPurchase } from "../grants/apply";
import { linkProviderAccount, providerAccountForUser, resolveNotificationOwner } from "../projection/owner";
import { resolveEntitlements } from "../projection/resolve";
import { type PurchaseProjection, projectPurchase } from "../projection/writer";
import { type CheckoutRail, isCheckoutRail, type PaymentsRailProvider } from "../rails/contract";
import { type RailTrustOptions, resolveRailProvider } from "../rails/providers";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";
import { PAYMENTS_ENTITLEMENT_GRANT_SCOPE, PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, requireAuth } from "./guards";
import {
  AppleWebhookNotification,
  CheckoutRequest,
  EntitlementGrantRequest,
  EntitlementRevokeRequest,
  GoogleWebhookNotification,
  PurchaseSubmission,
  RestoreRequest,
  StripeWebhookNotification,
} from "./schemas";
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
 * Only a Worker that says it is production is production. Every other value — `staging`, `dev`, a var nobody
 * set — is sandbox, because the failure directions are not symmetric: treating production as sandbox loses a
 * purchase that reconciliation repairs, while treating sandbox as production hands out real entitlements for
 * test transactions. That is the single most common in-app-purchase security defect there is, and the default
 * is what decides it.
 */
function deploymentEnvironment(c: Context<PithyHonoEnv>): PurchaseEnvironment {
  return (c.env as Record<string, unknown>).ENVIRONMENT === "production" ? "production" : "sandbox";
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
 * A purchase as a client may see it. Deliberately not the row: the stored `payload` is the whole provider
 * response, and a client has no use for its own receipt read back to it.
 */
function purchaseView(projection: PurchaseProjection) {
  const { purchase } = projection;
  return {
    id: purchase.id,
    rail: purchase.rail,
    productId: purchase.productId,
    type: purchase.type,
    status: purchase.status,
    environment: purchase.environment,
    purchasedAt: purchase.purchasedAt.toISOString(),
    expiresAt: purchase.expiresAt?.toISOString() ?? null,
    outcome: projection.outcome,
  };
}

/** Entitlements as a client reads them: the key, whether it grants right now, and when it lapses. */
function entitlementView(entitlement: { key: string; active: boolean; expiresAt: Date | null }) {
  return { key: entitlement.key, granted: entitlement.active, expiresAt: entitlement.expiresAt?.toISOString() ?? null };
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

  /** The Stripe rail, narrowed to the interface that creates hosted sessions. */
  async function checkoutRail(c: Context<PithyHonoEnv>): Promise<PaymentsRailProvider & CheckoutRail> {
    const provider = resolveRailProvider("stripe", config, await credentials(c), trust);
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

  return (app) => {
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
          },
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
      return c.json({ entitlements: entitlements.map(entitlementView) }, 200);
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
      return c.json({ purchases, entitlements: entitlements.map(entitlementView) }, 200);
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
     * AUTHED WRITE — Stripe only. Create a hosted Checkout Session and hand back where to send the browser.
     *
     * Everything that decides what is bought and where the buyer is returned to comes from config or from the
     * seam, never from the body: the **price** from the catalog entry the product id resolves to, the **return
     * URLs** from `config.stripe`, and the **purchaser** from `c.var.auth`. A client that could name a price
     * could buy Pro for the price of a coin pack; one that could name a return URL could send a paying customer
     * to a page it controls; one that could name a purchaser could attach its purchase to another account.
     */
    app.post(`${base}/checkout`, requireAuth(), zValidator("json", CheckoutRequest, validationHook), async (c) => {
      const settings = stripeSettings();
      const input = c.req.valid("json");
      const entry = product(config, input.productId);
      const priceId = providerProductId(entry.product, "stripe");
      if (priceId === undefined) {
        // In the catalog, but not sold here. A 404 on the product rather than on the rail: Stripe is available,
        // this product simply is not one of the things it sells.
        throw new PaymentsProductNotFoundError({
          detail: `Product "${entry.id}" declares no stripe price, so it cannot be bought through hosted Checkout.`,
        });
      }

      const userId = callerId(c);
      const provider = await checkoutRail(c);
      const session = await provider.createCheckoutSession(
        {
          providerProductId: priceId,
          subscription: entry.product.type === "subscription",
          userId,
          // Reuse the buyer's existing Stripe customer, so one buyer keeps one account and their billing portal
          // shows every purchase rather than only the last one's.
          providerAccountId: await accountFor(c, "stripe", userId),
          successUrl: settings.successUrl,
          cancelUrl: settings.cancelUrl,
        },
        { now: clock() },
      );

      await c.var.emit({
        action: PaymentsAuditActions.checkoutStarted,
        outcome: "success",
        actorType: "user",
        actorId: userId,
        sessionId: c.var.auth?.sessionId,
        resourceType: "product",
        resourceId: entry.id,
        metadata: { rail: "stripe", productId: entry.id, subscription: entry.product.type === "subscription" },
      });
      return c.json({ url: session.url }, 200);
    });

    /**
     * AUTHED WRITE — Stripe only. Open the Billing Portal for the caller's own store account.
     *
     * No body at all, and that is the request contract: there is exactly one customer this caller may manage,
     * and it comes from the provider-account map. A `customer` field here would be the whole vulnerability —
     * any signed-in caller could open a session against somebody else's billing history and cancel it.
     */
    app.post(`${base}/portal`, requireAuth(), async (c) => {
      const settings = stripeSettings();
      const userId = callerId(c);
      const providerAccountId = await accountFor(c, "stripe", userId);
      if (providerAccountId === null) {
        // Nothing has ever been bought through Stripe by this caller, so there is no billing to manage. Not a
        // payments-domain refusal: the rail is configured and working, the resource simply does not exist.
        throw new NotFoundError({
          message: "No billing account yet.",
          action: "Buy a subscription first, then manage it here.",
          detail: `No stripe provider account is linked to ${userId}.`,
        });
      }

      const provider = await checkoutRail(c);
      const session = await provider.createPortalSession(
        { providerAccountId, returnUrl: settings.portalReturnUrl },
        { now: clock() },
      );

      await c.var.emit({
        action: PaymentsAuditActions.portalOpened,
        outcome: "success",
        actorType: "user",
        actorId: userId,
        sessionId: c.var.auth?.sessionId,
        resourceType: "provider_account",
        resourceId: providerAccountId,
        metadata: { rail: "stripe" },
      });
      return c.json({ url: session.url }, 200);
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
    app.post(
      `${base}/entitlements/grant`,
      requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE),
      zValidator("json", EntitlementGrantRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
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
          },
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
          },
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
