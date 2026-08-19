// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import {
  type Capability,
  type CapabilityComposeContext,
  defineCapability,
} from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { KvNamespaceSpecMap } from "@pithy-sh/core/src/kv/namespaces";
import { workflowBindings } from "@pithy-sh/core/src/workflow/bindings";
import type { Migration } from "kysely/migration";
import type { PaymentsClientProduct, PaymentsClientProjection } from "./client/projection";
import { PaymentsConfig, type PaymentsConfigInput } from "./config/config";
import { paymentsTables } from "./data/tables";
import { installEntitlementResolver } from "./entitlement/resolver";
import type { PaymentsSubjectResolver, PaymentsSubjectSeam } from "./entitlement/subjectSeam";
import { registerPaymentsRoutes } from "./http/routes";
import { paymentsAdminRoutes } from "./http/scopes";
import { payments_0001_purchases } from "./migrations/0001_purchases";
import { paymentsSecretsRegistry } from "./secret/registry";
import { paymentsExampleSeed } from "./seeds/example";
import { PACKAGE_VERSION } from "./version.generated";
import { paymentsWorkflows } from "./workflows/specs";

/**
 * Where payments' migrations sort in the app database. Unique per database; the registry composes keys
 * like `1000_payments_0001_purchases`. Sits after vector (900), and was `NEXT_FREE_ORDER` when it was
 * taken — see `packages/cli/src/migrations/orders.test.ts`, which is the only place an order is allocated.
 */
export const PAYMENTS_MIGRATION_ORDER = 1000;

/** The database name every capability sharing the app D1 coordinates on. `DB` is the binding. */
const PAYMENTS_DATABASE_NAME = "app" as const;

/**
 * The options `payments()` takes: the catalog, plus the one thing that cannot live in it.
 *
 * **`resolveSubject` rides here rather than in `PaymentsConfig`, and the split is forced rather than
 * stylistic.** The config is serializable by contract: `provision/resolvePaymentsConfig.ts`
 * `JSON.stringify`s it into the reconcile worker's `PAYMENTS_CONFIG` var, and `workflows/worker.ts` parses
 * it back with `PaymentsConfig.parse` at boot. A function does not survive that round trip — `JSON.stringify`
 * drops it, and the field is simply gone in the one deployment that has no human to ask. So the decision is
 * split along the line the round trip draws: the **serializable** half (`billingSubject`, a two-value enum)
 * is config, diffable in git and carried into the var, and the **callable** half is a composition-time
 * option, handed to the factory alongside it.
 *
 * The consequence is worth stating rather than leaving to be discovered: **the reconcile and paddleSweep
 * Workflows always run with no adopter resolver.** They have no request to hand one, so anything in a
 * Workflow that needs a subject reads it from the rows it is already reconciling — never from the seam.
 *
 * An intersection rather than a field on the config schema for the same reason a Zod object cannot hold it:
 * everything in `PaymentsConfig` is data, and this is not.
 */
export type PaymentsOptions = PaymentsConfigInput & {
  /**
   * Which subject this caller is acting for. Required in practice under `billingSubject: "organization"`,
   * where the capability has no way to answer on its own — see `entitlement/subjectSeam.ts`. Under `"user"`
   * it is optional and the authenticated caller is the answer.
   */
  resolveSubject?: PaymentsSubjectResolver;
};

/**
 * The slice of `@pithy-sh/ledger`'s capability the grants check reads — its declared currency codes.
 *
 * Structural, and recognised by a copied three-line predicate rather than by importing the ledger's own
 * `isLedgerCapability`. Two reasons, and both are binding. `compose` is **synchronous**, so the guarded
 * dynamic import that keeps the ledger optional everywhere else is not available here. And a static import
 * would make an optional peer a hard one for every project, including the great majority whose catalogs sell
 * features and never name a currency. This is the same trade `guards.ts` documents for `requireAuth`.
 */
interface LedgerPeer extends Capability {
  ledgerConfig: { currencies: readonly { code: string }[] };
}

/** Whether a composed capability is the ledger, carrying its parsed currency set. */
function isLedgerPeer(capability: Capability): capability is LedgerPeer {
  return capability.name === "ledger" && "ledgerConfig" in capability;
}

/**
 * Validate every `grants.currency` against the composed ledger, at assembly.
 *
 * `openLedger` validates nothing — it is a primitive, and `credit()` on an unconfigured currency happily
 * opens a real account row. Nobody can reach that row: the ledger's own routes resolve a currency from config
 * and 404 an unknown code, so the balance exists, is correct, and is invisible. The player is told their
 * purchase worked. A typo in a currency code is therefore a defect that produces no error anywhere at
 * runtime, which makes the deploy the only place left to catch it.
 *
 * Every mismatch is reported in one message rather than the first, because an operator fixing one typo per
 * deploy is a bad afternoon.
 */
function checkLedgerGrants({ capabilities }: CapabilityComposeContext, config: PaymentsConfig): void {
  const granting = Object.entries(config.products).flatMap(([id, product]) =>
    product.grants?.ledger === undefined ? [] : [{ id, currency: product.grants.ledger.currency }],
  );
  if (granting.length === 0) return;

  // **A per-user ledger and an organization-billed catalog do not compose**, and the refusal belongs here
  // rather than at the first purchase. `@pithy-sh/ledger` is a per-user model by design: it keys an account
  // `(userId, currency)` and every read it owns addresses a user — the authenticated balance route, the
  // `:userId` management segment, its seeds. There is no honest address for an organization in it. Writing
  // one anyway would put a non-user in a column that means user, and the balance would be invisible to every
  // route the ledger ships; refusing at the purchase instead would take the customer's money first.
  //
  // So this is a catalog that has to change, not a runtime state to handle: either the project bills people,
  // or the products that credit a balance are not the ones it sells to companies.
  if (config.billingSubject !== "user") {
    throw new ValidationError({
      message: "This catalog credits a balance, and this project bills organizations.",
      action: 'Set `billingSubject: "user"`, or drop the `grants` clause from the products that credit a balance.',
      detail: `@pithy-sh/ledger keys every account on a user id and every route it serves reads one, so there is no account an organization's credit could land in that anything would read. Products with a \`grants.ledger\` clause: ${granting.map((entry) => entry.id).join(", ")}.`,
    });
  }

  const peer = capabilities.find(isLedgerPeer);
  if (!peer) {
    throw new ValidationError({
      message: "This catalog credits a balance, and no ledger is composed.",
      action: "Add `ledger(...)` to this Worker's capabilities, or drop the `grants` clause from the product.",
      detail: `Products with a \`grants.ledger\` clause: ${granting.map((entry) => entry.id).join(", ")}. Crediting needs @pithy-sh/ledger composed in the same Worker.`,
    });
  }

  const declared = new Set(peer.ledgerConfig.currencies.map((currency) => currency.code));
  const unknown = granting.filter((entry) => !declared.has(entry.currency));
  if (unknown.length === 0) return;
  throw new ValidationError({
    message: "A product grants a currency the ledger does not have.",
    action: "Add the currency to the ledger's `currencies`, or correct the product's `grants.ledger.currency`.",
    detail: `${unknown
      .map((entry) => `product "${entry.id}" grants "${entry.currency}"`)
      .join("; ")}. The ledger declares: ${[...declared].sort().join(", ") || "nothing"}.`,
  });
}

/**
 * Refuse the one composition that can never entitle anybody: organization billing with no resolver.
 *
 * **A throw at assembly, not a `pithy doctor` finding**, and the difference from the entitlement-gap check
 * is where the evidence lives. That check must read the adopter's *route code* to know whether anything
 * gates at all, which is a question no capability can ask about itself — so it belongs to a tool that reads
 * the project. This one needs nothing but the two arguments already in hand: `billingSubject` from the
 * config being parsed on the line above, and `resolveSubject` from the same call. Where a capability can
 * see the whole fault by itself, it says so at the deploy, which is what `checkLedgerGrants` does two
 * functions down and for the same reason.
 *
 * And the fault is total. Under `"organization"` there is no default resolver — deliberately, because a
 * capability that guessed would key a company's plan to whoever logged in first — so with none supplied
 * `resolvePaymentsSubject` answers nobody for every request. Every entitlement gate denies, every write
 * raises `payments/subject_unresolved`, and both look exactly like a customer who has not paid. There is no
 * request that ever works, so there is nothing to lose by refusing to boot, and a Worker that boots into
 * that state is one whose first symptom is a support ticket from a paying company.
 */
function requireResolvableSubject(config: PaymentsConfig, resolveSubject: PaymentsSubjectResolver | undefined): void {
  if (config.billingSubject !== "organization" || resolveSubject !== undefined) return;
  throw new ValidationError({
    message: "This project bills organizations, and nothing can say which one a caller is acting for.",
    action:
      'Pass `resolveSubject` to `payments(...)` in this Worker\'s pithy.config.ts, or set `billingSubject: "user"`.',
    detail:
      'billingSubject is "organization" and no subject resolver was supplied. Payments has no members table and never guesses a holder, so every entitlement gate would deny and every write would raise payments/subject_unresolved, for every caller, forever.',
  });
}

/**
 * What a browser may know about this project's payments — the `virtual:pithy/payments` module.
 *
 * The list is short and each entry earns its place. **Enabled rails**, so a paywall can show an Apple-only
 * product as owned-elsewhere rather than offering a buy button nothing on the web can honour. **The base
 * path**, because the client calls these routes. And **per product** its id, type, entitlement keys,
 * display name, and its SKU on each web rail — a price id is publishable by design, since it is the thing
 * a checkout names and the store's own page shows back to the buyer. Plus, for Paddle, the three facts
 * Paddle.js needs to initialize: the publishable client token, the account, and the display mode.
 *
 * **Nothing else can cross, and not merely by discipline.** Apple's issuer id and key, Google's
 * service-account credentials, and Stripe's secret and webhook signing keys live in the secrets store
 * behind `paymentsSecretsRegistry` — they are not in the config this closure can see, so there is no
 * expression here that would reach them. What discipline does cover is the rest of the catalog: a
 * product's Apple and Google SKUs stay server-side because a browser has no use for them, and the
 * `grants` block stays server-side because a currency code and an amount describe the economy.
 * `capability.test.ts` locks the key set and sweeps the serialized result for every credential shape.
 *
 * `?? null`, never `undefined`: the projection is inlined into a bundle with `JSON.stringify`, which
 * drops an undefined value and leaves the screen reading a key that is simply absent.
 *
 * An empty catalog projects `{ enabled: false }`. A screen branches on `enabled` rather than guarding, so
 * "composed with nothing to sell" must read the same as "not composed" — both are a paywall with nothing
 * on it.
 *
 * The return type is {@link PaymentsClientProjection}, and the catalog's element type is
 * {@link PaymentsClientProduct} — **declared, not inferred**. `ClientProjection` is `{ enabled: boolean }`
 * plus a JSON catchall, which accepts anything this function could return. The declared types are what
 * make a dropped field a compile error here rather than a browser's problem, and what make a fourth
 * product kind or a fourth Paddle checkout mode in `PaymentsConfig` a red line here rather than a silent
 * widening of what every adopter's bundle carries. The element type is annotated
 * separately because the `.map` is where inference is weakest: it would take the shape of whatever the
 * first product happened to be.
 */
function clientProjection(config: PaymentsConfig, environment: string): PaymentsClientProjection {
  const products = Object.entries(config.products).map(
    ([id, product]): PaymentsClientProduct => ({
      id,
      type: product.type,
      entitlements: [...product.entitlements],
      name: product.name,
      // **Keyed by rail, not one field per rail.** Two flat fields were already one too many, and a third
      // would have made `purchasable()` a growing chain of `&&`s that a fourth rail silently falls out of.
      // A screen now asks `skus[rail]`, which is the same question it was already asking and cannot go
      // stale when a rail is added. Every id here is publishable by design: each is what a checkout names,
      // so each may reach a browser. The API keys and the signing secrets never do.
      skus: {
        stripe: product.stripe?.priceId ?? null,
        lemonSqueezy: product.lemonSqueezy?.variantId ?? null,
        paddle: product.paddle?.priceId ?? null,
      },
    }),
  );
  if (products.length === 0) return { enabled: false };

  return {
    enabled: true,
    environment,
    rails: {
      apple: config.rails.apple,
      google: config.rails.google,
      stripe: config.rails.stripe,
      lemonSqueezy: config.rails.lemonSqueezy,
      paddle: config.rails.paddle,
    },
    basePath: config.basePath,
    // The three facts Paddle.js needs to initialize, and no more. The client token is publishable — it is
    // designed to reach a browser — and the checkout mode decides whether a screen renders a container.
    // Null when the rail is off, so a screen branches on one value rather than on three absences.
    paddle:
      config.paddle === undefined
        ? null
        : {
            clientToken: config.paddle.clientToken,
            environment: config.paddle.environment,
            checkout: config.paddle.checkout,
          },
    // Catalog order, not sorted: the order an adopter wrote their products in is the order a paywall
    // should list them, and it is stable for a given config either way.
    products,
  };
}

/** The payments capability, with its resolved catalog attached for other tooling to read. */
export interface PaymentsCapability
  extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, "payments", typeof paymentsWorkflows> {
  /** The resolved catalog. */
  paymentsConfig: PaymentsConfig;
}

/**
 * Three rails — Apple, Google, Stripe — projecting onto one cross-rail entitlement, in the adopter's own
 * D1. The catalog is config, not rows: a product's entitlement mapping is policy, so it is diffable in
 * git and not mutable at runtime.
 *
 * `providesEntitlements` is what makes payments the seam's provider, and it is read in two places. At
 * runtime the middleware below replaces core's fail-closed `noEntitlementProvider` with the D1-backed
 * resolver. At development time `pithy doctor` and `pithy dev` read the flag to answer a question no
 * amount of runtime care can: a Worker whose routes call `requireEntitlement()` while composing no
 * provider is not broken, it is silently paywalled shut, and the seam's own fail-closed default makes
 * that indistinguishable from a user who has not bought anything.
 *
 * `dependsOn: ["secrets"]` is real. Every rail's credentials are read through the aggregated secret
 * registry, so a project composing payments without `@pithy-sh/secrets` must fail at assembly rather
 * than at the first receipt. Auth is *not* listed — it is a seam: under `billingSubject: "user"` a purchase
 * scopes to the authenticated caller, so with no auth capability composed every route denies, which is the
 * right failure and needs no dependency edge. `@pithy-sh/ledger` is likewise a seam, reached through one
 * guarded dynamic import and only for products whose catalog entry declares `grants`. Both belong in the
 * manifest's `optionalCapabilities`.
 *
 * Under `billingSubject: "organization"` the holder is not the caller and cannot be derived from them, so
 * the adopter supplies `resolveSubject` and a composition without one is refused outright — see
 * {@link requireResolvableSubject}.
 */
export function payments(options: PaymentsOptions): PaymentsCapability {
  // Split before parsing rather than letting Zod strip it. `PaymentsConfig` would drop `resolveSubject`
  // silently — it is an unknown key on a stripping object — and silence is the wrong outcome for the field
  // whose whole hazard is being serialized by accident. Separated here, the config that reaches
  // `JSON.stringify` in `provision/resolvePaymentsConfig.ts` provably holds no function, because no function
  // was ever in it.
  const { resolveSubject, ...catalog } = options;

  // Parse the catalog at assembly — a product naming a disabled rail, a duplicate provider SKU, or a
  // ledger grant on a non-consumable fails on deploy, not on the first webhook. `billingSubject` is required
  // and has no default: what a project bills is a decision, and a default would make it an accident.
  const resolved = PaymentsConfig.parse(catalog);
  requireResolvableSubject(resolved, resolveSubject);

  // The one seam, built once. Both halves come from different places by construction (see
  // {@link PaymentsOptions}), and every asker — the entitlement gate through the middleware, the routes
  // through their own factory — is handed this object rather than reassembling it. A second construction is
  // a second policy, and the two disagree the day one of them is edited.
  //
  // Spread rather than writing the key outright, so an absent resolver leaves an absent key rather than one
  // holding `undefined`. Nothing reads it by presence today — `resolvePaymentsSubject` coalesces and
  // `requirePaymentsSubject` tests truthiness — but a seam that has to be inspected (a doctor check, a log
  // line saying whether one is wired) then reads the fact rather than a placeholder for it.
  const subject: PaymentsSubjectSeam = {
    billingSubject: resolved.billingSubject,
    ...(resolveSubject ? { resolveSubject } : {}),
  };

  const migrations: Record<string, Migration> = {
    "0001_purchases": payments_0001_purchases,
  };
  const requiredBindings: BindingSpecInput[] = [
    // The app database — all four pithy_payments_* tables live here.
    { type: "d1", name: "DB" },
    // The reconciliation Workflow's binding, derived from the spec rather than written again — one
    // declaration, so a binding rename cannot leave the two disagreeing. `optional` because the binding
    // exists only once `pithy payments provision` has deployed the host, and an unprovisioned project must
    // still verify receipts, accept webhooks, and resolve entitlements.
    ...workflowBindings(paymentsWorkflows),
  ];

  const capability = defineCapability({
    name: "payments",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    dependsOn: ["secrets"],
    providesEntitlements: true,
    // One secret holds every rail's credentials. Declaring the slice here is what lets `sharedSecretsStore`
    // resolve it — a read of a name no composed capability declared throws.
    secretRegistry: paymentsSecretsRegistry,
    // The one durable job: the nightly reconciliation pass. Declared here so `createBackend` derives its
    // binding and types `c.var.workflows.trigger("payments/reconcile", …)` precisely.
    workflows: paymentsWorkflows,
    // The one thing this capability cannot check on its own: whether the ledger it credits agrees the
    // currency exists. See `checkLedgerGrants` for why the failure is otherwise invisible.
    compose: (context) => checkLedgerGrants(context, resolved),
    // What a browser may know. See `clientProjection` for why the list is what it is.
    client: ({ environment }): PaymentsClientProjection => clientProjection(resolved, environment),
    requiredBindings,
    config: PaymentsConfig,
    databases: {
      [PAYMENTS_DATABASE_NAME]: {
        binding: "DB",
        tables: paymentsTables(),
        migrationOrder: PAYMENTS_MIGRATION_ORDER,
        migrations,
      },
    },
    // Replaces core's fail-closed `noEntitlementProvider` with the D1-backed resolver, over the seam that
    // says who to resolve for.
    middleware: [installEntitlementResolver(PAYMENTS_DATABASE_NAME, subject)],
    // The management surface, described for `GET /control-plane/manifest`. Built from the resolved
    // `basePath` rather than the default, so an adopter who mounted payments at `/billing` gets a
    // manifest naming `/billing/entitlements/grant` — the whole point of describing rather than
    // assuming. `routeContract.test.ts` checks these against the routes actually registered.
    adminRoutes: paymentsAdminRoutes(resolved.basePath),
    // The routes ask the same question the gate does — a checkout, a restore and a portal all need a holder
    // to key a row to — so they are handed the same seam rather than building one from the config alone.
    routes: registerPaymentsRoutes({ config: resolved, subject }),
    seeds: [paymentsExampleSeed],
  });

  return Object.assign(capability, { paymentsConfig: resolved });
}

/** Whether a capability is the payments capability — carries its resolved catalog. */
export function isPaymentsCapability(capability: Capability): capability is PaymentsCapability {
  return capability.name === "payments" && "paymentsConfig" in capability;
}
