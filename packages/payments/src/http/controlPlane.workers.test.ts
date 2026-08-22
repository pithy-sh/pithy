// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { leavesIn, unpublishedIn } from "@pithy-sh/core/src/projection/published";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { recordReconcileRun } from "../data/reconcileRun";
import type { PaymentsSubject } from "../data/subject";
import { grantEntitlement } from "../entitlement/manual";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { projectPurchase } from "../projection/writer";
import {
  PaymentsAdminCatalogProduct,
  PaymentsAdminCatalogResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminEntitlementView,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminPurchaseView,
  PaymentsAdminReconcileRunsResponse,
  PaymentsAdminReconcileRunView,
  PaymentsAdminSubjectEntitlementsResponse,
  PaymentsAdminSubscriptionsResponse,
} from "./responses";
import { registerPaymentsRoutes } from "./routes";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./scopes";

/**
 * The management reads, executed — against real D1, over the real control-plane seam, with a real
 * EdDSA-signed single-use token minted for one connection in one environment (#247).
 *
 * **Nothing here is a mock, and that is the point.** Every defect this kit has shipped passed a green
 * suite first, and the ones that hurt were the ones no test made a real call for. So the credential is
 * minted by `mintControlPlaneToken` and verified by `createControlPlaneVerifier` against a registered
 * public key; the rows are written by the same `projectPurchase` a webhook uses; and every response is
 * parsed back through the schema a dashboard would parse it with, so a field either side forgot fails
 * here rather than in somebody's browser.
 *
 * What survives only in this file: the keyset pagination (an offset passes every test that never fetches
 * a second page), the projection's refusals, the audit event on a read, and — the reason #247 existed —
 * that a connection *without* a read scope is refused rather than being handed the rows.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

/** A catalog with one subscription and one consumable, so "the log" and "the ones that renew" differ. */
const CONFIG = PaymentsConfig.parse({
  // Required. Every fixture here bills people, so the subject a row is keyed on is `user:<id>` — and the
  // organization cases below exist to prove the *other* half of the pair is genuinely part of the address.
  billingSubject: "user",
  rails: { apple: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
    },
    coins_100: {
      type: "consumable",
      name: "100 Coins",
      entitlements: ["coins"],
      apple: { productId: "com.acme.coins.100" },
    },
  },
});

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

/** The app, with a live control-plane verifier and a capturing audit seam. */
function makeApp(scopes: readonly ControlPlaneScope[], config: PaymentsConfig = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    // Null on purpose: the seam never populates `auth` for a management client, which is exactly why an
    // ordinary `requireAuth()` must not sit on a control-plane route.
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerPaymentsRoutes({ config, now: () => NOW })(app);
  return app;
}

/** A GET carrying a freshly minted, single-use control-plane token bound to one scope. */
async function call(app: Hono<PithyHonoEnv>, path: string, scope: ControlPlaneScope): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    { ...env, ENVIRONMENT },
  );
}

/** A user subject, written the way every fixture below names one. Both halves, always — see `data/subject.ts`. */
const user = (id: string): PaymentsSubject => ({ subjectType: "user", subjectId: id });

/**
 * An organization subject carrying the same id shape.
 *
 * Nothing in the kit makes the two id spaces disjoint, so `organization:ada` and `user:ada` are two holders
 * that a filter reading the id alone would merge. The cases below use this to prove they do not.
 */
const organization = (id: string): PaymentsSubject => ({ subjectType: "organization", subjectId: id });

/** One purchase, written by the real projection so the rows are the ones a webhook would have left. */
async function purchase(options: {
  holder: PaymentsSubject;
  sku: string;
  transaction: string;
  at: Date;
  status?: "active" | "refunded" | "expired" | "paused";
  expires?: Date | null;
  resumes?: Date | null;
  amount?: number;
}): Promise<void> {
  await projectPurchase(
    env.DB,
    {
      rail: "apple",
      providerTransactionId: options.transaction,
      providerProductId: options.sku,
      ...options.holder,
      status: options.status ?? "active",
      environment: "production",
      purchasedAt: options.at,
      expiresAt: options.expires ?? null,
      resumesAt: options.resumes ?? null,
      providerEventAt: options.at,
      amountMinor: options.amount ?? 999,
      currency: "USD",
      // The receipt, as a rail hands it over. Every assertion about what a management read discloses is
      // made against a row that actually holds one.
      payload: {
        transactionId: options.transaction,
        appAccountToken: `token-${options.holder.subjectId}`,
        secret: "s3cret",
      },
    },
    { config: CONFIG, environment: "production", now: options.at },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

beforeEach(async () => {
  for (const table of [
    "pithy_payments_webhook_events",
    "pithy_payments_reconcile_runs",
    "pithy_payments_sync_cursors",
    "pithy_payments_provider_accounts",
    "pithy_payments_entitlements",
    "pithy_payments_purchases",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await payments_0001_purchases.up(db);
  emitted = [];
});

/**
 * The catalog read (#300), and the invariant that keeps it narrow.
 *
 * `SENTINEL_CATALOG` loads every field the catalog has that must **not** cross with a value nothing else
 * in this file could produce — a Stripe price, three store SKUs, a ledger currency and amount, three
 * return URLs, and a `clawback` flag. The assertion is not a list of banned field names. It is two
 * statements, and both are needed because either alone lets the mistake through: *every leaf in the
 * response is one of the four facts this surface publishes about some product, a key the adopter
 * declared grantable, or the `true` that `enabled` is* — and *every key in the response is one of the
 * seven written out by hand below.*
 *
 * **The key list is a frozen literal, not `Object.keys(PaymentsAdminCatalogProduct.shape)`.** It was the
 * latter, which made the gate read its own subject: adding `apple: boolean` to the schema and to
 * `adminCatalogView` in one edit widened the permitted set by the same edit, and the test whose entire
 * job is to catch that passed. A gate derived from what it polices cannot fail when what it polices
 * changes. So the permitted keys are typed out here, and widening this response means editing that line
 * deliberately, in a test, beside the sentence saying why it is narrow.
 *
 * **The sweep itself is `@pithy-sh/core`'s {@link unpublishedIn}, not a copy.** It was a pair of walkers
 * in this file, and the moment three more surfaces wanted the same invariant that would have been four
 * copies of a function whose first draft was silently blind to booleans and nulls. One producer, and its
 * blindness is planted against on every run in `packages/core/src/projection/published.test.ts`.
 */
const SENTINEL_CATALOG = PaymentsConfig.parse({
  billingSubject: "user",
  rails: { apple: true, google: true, stripe: true },
  stripe: {
    successUrl: "https://sentinel.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://sentinel.example/pricing",
    portalReturnUrl: "https://sentinel.example/account",
  },
  manualEntitlements: ["founder"],
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.sentinel.pro.monthly" },
      google: { productId: "sentinel_pro_monthly" },
      stripe: { priceId: "price_1Sentinel" },
    },
    coins_100: {
      type: "consumable",
      name: "100 Coins",
      entitlements: ["coins"],
      grants: { ledger: { currency: "sentinelcoin", amount: 4242 } },
      clawback: true,
      apple: { productId: "com.sentinel.coins.100" },
    },
  },
});

/**
 * Every key the catalog response is permitted to carry. Seven: the envelope's three, and a product's four.
 *
 * Written out, on purpose, and never read off `PaymentsAdminCatalogResponse` — see the note above
 * `SENTINEL_CATALOG` for the failure that cost.
 */
const PUBLISHED_CATALOG_KEYS = ["enabled", "products", "manualEntitlements", "id", "type", "name", "entitlements"];

describe("GET /payments/admin/catalog", () => {
  test("answers a connection holding the scope, and the body is what the schema says it is", async () => {
    const response = await call(
      makeApp([PAYMENTS_CATALOG_READ_SCOPE]),
      "/payments/admin/catalog",
      PAYMENTS_CATALOG_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = PaymentsAdminCatalogResponse.parse(await response.json());
    expect(body.enabled).toBe(true);
    if (!body.enabled) throw new Error("unreachable");
    // Catalog order, not sorted: the order the adopter wrote is the order a list should show.
    expect(body.products).toEqual([
      { id: "pro_monthly", type: "subscription", name: "Pro", entitlements: ["pro"] },
      { id: "coins_100", type: "consumable", name: "100 Coins", entitlements: ["coins"] },
    ]);
    expect(body.manualEntitlements).toEqual([]);
  });

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    // The invariant, stated rather than enumerated. Two halves, because either alone permits the mistake:
    // a value the catalog carries must not appear under *any* key, and a key must be one of the seven
    // named by hand — the second is what stops a field arriving with a value from somewhere else.
    const app = makeApp([PAYMENTS_CATALOG_READ_SCOPE], SENTINEL_CATALOG);
    const raw = await (await call(app, "/payments/admin/catalog", PAYMENTS_CATALOG_READ_SCOPE)).json();

    // The published facts, plus the one leaf that is envelope rather than fact: the `true` of `enabled`.
    // `true`, `false` and `null` belong to every JSON document's vocabulary, so this half can never police
    // a boolean or a null on its own. The key half is what does, which is why there are two of them.
    const published: (string | number | boolean | null)[] = [true, ...SENTINEL_CATALOG.manualEntitlements];
    for (const [id, product] of Object.entries(SENTINEL_CATALOG.products)) {
      published.push(id, product.type, product.name, ...product.entitlements);
    }
    const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_CATALOG_KEYS });
    expect(
      escaped,
      `These reached a management client and are not a product's id, kind, display name, or entitlement key:\n  ${escaped.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the response schema declares nothing the hand-written key list does not name", () => {
    // The second place a widening fails, and the earlier one: it fails on the schema edit, before any view
    // has been written to fill the new field. The list polices the schema; the schema never polices itself.
    const declared = ["enabled", "products", "manualEntitlements", ...Object.keys(PaymentsAdminCatalogProduct.shape)];
    expect(declared.filter((key) => !PUBLISHED_CATALOG_KEYS.includes(key))).toEqual([]);
    // And in the other direction, so a field removed from the schema does not leave a permission behind it.
    expect(PUBLISHED_CATALOG_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("the sweep is running against a catalog that really carries all of it", async () => {
    // A gate over nothing passes perfectly. The config the assertion above reads must genuinely hold a
    // price, three SKUs, a currency, an amount, three return URLs and a flag, or that test proves nothing.
    const serialized = JSON.stringify(SENTINEL_CATALOG);
    for (const secret of [
      "price_1Sentinel",
      "com.sentinel.pro.monthly",
      "sentinel_pro_monthly",
      "com.sentinel.coins.100",
      "sentinelcoin",
      "4242",
      "https://sentinel.example/pricing",
      // A boolean the catalog carries and the response must not. The leaf sweep was blind to this whole
      // JSON type, so the sentinel now holds one and the assertion above has something to be blind to.
      '"clawback":true',
    ]) {
      expect(serialized, secret).toContain(secret);
    }
    // And what is meant to cross does cross — as **leaves**, not as substrings. `"coins"` sits inside
    // `"coins_100"`, so a `toContain` over the response text was satisfied by the product id alone and said
    // nothing about the entitlement key. The same slack #332 found on the run log, one read over.
    const app = makeApp([PAYMENTS_CATALOG_READ_SCOPE], SENTINEL_CATALOG);
    const carried = leavesIn(await (await call(app, "/payments/admin/catalog", PAYMENTS_CATALOG_READ_SCOPE)).json());
    for (const published of ["pro_monthly", "subscription", "Pro", "coins", "founder"]) {
      expect(carried, published).toContain(published);
    }
  });

  test("declared manual keys are offered beside the products", async () => {
    // The escape has to be visible to the client that would otherwise never offer it — a comp control
    // omitting `founder` would refuse the grant it then submitted.
    const body = PaymentsAdminCatalogResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_CATALOG_READ_SCOPE], SENTINEL_CATALOG),
          "/payments/admin/catalog",
          PAYMENTS_CATALOG_READ_SCOPE,
        )
      ).json(),
    );
    expect(body.enabled && body.manualEntitlements).toEqual(["founder"]);
  });

  test("a project that defines nothing answers { enabled: false }, not an empty list", async () => {
    // The same modeled answer `clientProjection` gives, and for the same reason: a client branches on
    // `enabled`, so "composed with nothing to sell" reads as its own state rather than as a dropdown that
    // came back broken. A catalog that failed to *load* is a non-200 or a body that does not parse, which
    // no branch on `enabled` can be confused by.
    const body = PaymentsAdminCatalogResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_CATALOG_READ_SCOPE], PaymentsConfig.parse({ billingSubject: "user" })),
          "/payments/admin/catalog",
          PAYMENTS_CATALOG_READ_SCOPE,
        )
      ).json(),
    );
    expect(body).toEqual({ enabled: false });
  });

  test("its own scope — the entitlement reads do not open it, and it opens neither of them", async () => {
    // Reading what a project sells is not reading what anybody bought, in both directions. `scopeCovers`
    // matches exactly, with no prefix rule, which is what makes the split real rather than documentary.
    const withEntitlements = await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/catalog",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    expect(withEntitlements.status).toBe(403);
    expect(await errorCode(withEntitlements)).toBe("controlplane/insufficient_scope");

    const withCatalog = await call(
      makeApp([PAYMENTS_CATALOG_READ_SCOPE]),
      "/payments/admin/entitlements",
      PAYMENTS_CATALOG_READ_SCOPE,
    );
    expect(withCatalog.status).toBe(403);
    const purchases = await call(
      makeApp([PAYMENTS_CATALOG_READ_SCOPE]),
      "/payments/admin/purchases",
      PAYMENTS_CATALOG_READ_SCOPE,
    );
    expect(purchases.status).toBe(403);
  });

  test("no credential at all is refused", async () => {
    const response = await makeApp([PAYMENTS_CATALOG_READ_SCOPE]).request(
      "http://x/payments/admin/catalog",
      { method: "GET" },
      { ...env, ENVIRONMENT },
    );
    expect(response.status).toBe(401);
  });

  test("the read is audited, with the operator and the connection recorded", async () => {
    await call(makeApp([PAYMENTS_CATALOG_READ_SCOPE]), "/payments/admin/catalog", PAYMENTS_CATALOG_READ_SCOPE);
    const event = emitted.find((e) => e.action === "payments/catalog_read");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect((event?.metadata as { connectionId?: string; products?: number } | undefined)?.connectionId).toBe(
      CONNECTION_ID,
    );
    expect((event?.metadata as { products?: number } | undefined)?.products).toBe(2);
  });

  test("it reads no database at all — a catalog is config", async () => {
    // The `DB` binding is not even consulted, which is why this is the one management read that answers
    // on a Worker whose migrations have never run.
    const app = makeApp([PAYMENTS_CATALOG_READ_SCOPE]);
    for (const table of ["pithy_payments_entitlements", "pithy_payments_purchases"]) {
      await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    const response = await call(app, "/payments/admin/catalog", PAYMENTS_CATALOG_READ_SCOPE);
    expect(response.status).toBe(200);
  });
});

/** The one purchase every row-projection sweep below is run against. */
const PURCHASED_AT = new Date("2026-06-01T00:00:00.000Z");

/**
 * Every key `GET {base}/admin/purchases` may carry, at any depth. Eighteen: the envelope's two, and a
 * purchase's sixteen. `GET {base}/admin/subscriptions` returns the same view under one other envelope
 * key, so widening the row is refused here whichever route a client reached it through.
 *
 * **The owner is two keys, `subjectType` and `subjectId`,** and both are permitted deliberately. A view
 * publishing the id alone would read as a person the moment an adopter's organization ids and user ids met
 * on a value, so the pair crosses whole or the row names no holder at all.
 *
 * **Written out, never `Object.keys(PaymentsAdminPurchaseView.shape)`.** See the note above
 * `SENTINEL_CATALOG`: a gate derived from what it polices cannot fail when what it polices changes, and
 * that is not a hypothetical here — it is what the catalog read's first version did.
 */
const PUBLISHED_PURCHASE_KEYS = [
  "purchases",
  "nextCursor",
  "id",
  "subjectType",
  "subjectId",
  "rail",
  "providerTransactionId",
  "originalTransactionId",
  "productId",
  "type",
  "status",
  "environment",
  "amountMinor",
  "currency",
  "purchasedAt",
  "expiresAt",
  "revokedAt",
  "resumesAt",
  "updatedAt",
];

/** Every key the two entitlement reads may carry. Ten: two envelopes' four, and an entitlement's seven. */
const PUBLISHED_ENTITLEMENT_KEYS = [
  "entitlements",
  "nextCursor",
  "subjectType",
  "subjectId",
  "key",
  "granted",
  "expiresAt",
  "manual",
  "source",
];

describe("GET /payments/admin/purchases", () => {
  test("answers a connection holding the scope, and the body is what the schema says it is", async () => {
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });

    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    // Parsed, not merely shaped. The dashboard validates every response from a customer's Worker before a
    // character of it renders, so the schema is the contract and this is where the two are bound together.
    const body = PaymentsAdminPurchasesResponse.parse(await response.json());
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0]).toMatchObject({
      subjectType: "user",
      subjectId: "ada",
      rail: "apple",
      productId: "pro_monthly",
      type: "subscription",
      status: "active",
      environment: "production",
      amountMinor: 999,
      currency: "USD",
      providerTransactionId: "t1",
    });
    expect(body.nextCursor).toBeNull();
  });

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    // This read was guarded by three `not.toContain` calls — `payload`, `s3cret`, `appAccountToken` —
    // which is complete only against the three strings somebody thought of, and a projection widens by
    // gaining a *field*. The invariant is stated instead: every leaf is one of the facts a management
    // client is shown about this purchase, and every key is one of the seventeen written out by hand.
    //
    // The row it runs against carries five things this response must not publish, each a real column:
    // the provider payload (a bearer artifact, and on Stripe a document holding the buyer's address),
    // the rail's own SKU, the row's role, and two ms-epoch timestamps that are published nowhere and as
    // ISO-8601 everywhere.
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: PURCHASED_AT });
    const raw = await (
      await call(makeApp([PAYMENTS_PURCHASES_READ_SCOPE]), "/payments/admin/purchases", PAYMENTS_PURCHASES_READ_SCOPE)
    ).json();

    // The row's UUID is minted at write time, so it is read back from the column that holds it — named,
    // one column, never the whole row. Deriving the permitted values from the row would publish every
    // column by construction, which is the same mistake as deriving the keys from the schema.
    const id = await env.DB.prepare("SELECT id FROM pithy_payments_purchases").first<{ id: string }>();
    const published = [
      id?.id ?? "",
      // Both halves of the holder. `"user"` is a published leaf now, and it has to be: the kind is half the
      // address, and a response that carried the id without it would name whoever else holds the id.
      "user",
      "ada",
      "apple",
      "t1",
      "pro_monthly",
      "subscription",
      "active",
      "production",
      999,
      "USD",
      PURCHASED_AT.toISOString(),
      // Never expired, never revoked, and not a renewal of anything.
      null,
    ];
    const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_PURCHASE_KEYS });
    expect(escaped, `The purchase log published this:\n  ${escaped.join("\n  ")}`).toEqual([]);
  });

  test("the row really holds everything the sweep is meant to refuse", async () => {
    // A gate over nothing passes perfectly. Every value the assertion above must refuse has to be on the
    // row it read, or that test says only that an empty response discloses nothing.
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: PURCHASED_AT });
    const stored = await env.DB.prepare(
      "SELECT payload, provider_product_id, role, provider_event_at, created_at FROM pithy_payments_purchases",
    ).first<{
      payload: string;
      provider_product_id: string;
      role: string;
      provider_event_at: number;
      created_at: number;
    }>();
    expect(stored?.payload).toContain("s3cret");
    expect(stored?.payload).toContain("appAccountToken");
    expect(stored?.provider_product_id).toBe("com.acme.pro.monthly");
    expect(stored?.role).toBe("charge");
    expect(stored?.provider_event_at).toBe(PURCHASED_AT.getTime());
    expect(stored?.created_at).toBeTypeOf("number");
  });

  test("the response schema declares nothing the hand-written key list does not name", () => {
    // The earlier of the two places a widening fails: on the schema edit, before a view has been written
    // to fill the new field. The list polices the schema; the schema never polices itself.
    const declared = ["purchases", "nextCursor", ...Object.keys(PaymentsAdminPurchaseView.shape)];
    expect(declared.filter((key) => !PUBLISHED_PURCHASE_KEYS.includes(key))).toEqual([]);
    expect(PUBLISHED_PURCHASE_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("a connection without the scope is refused, and is told which scope it lacks", async () => {
    // The state #247 described, made a test. Before the read existed there was no route to refuse at all:
    // a pane computed `absent` and vanished, which no grant could repair. Now the refusal is a 403 that
    // names the missing grant, which is a thing an adopter can act on.
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    const response = await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/purchases",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
  });

  test("no credential at all is refused before the query schema is ever consulted", async () => {
    // A validator ahead of a guard would turn this into a 400 and tell an unauthenticated caller which of
    // its requests were well-formed. The malformed `limit` is the probe.
    const response = await makeApp([PAYMENTS_PURCHASES_READ_SCOPE]).request(
      "http://x/payments/admin/purchases?limit=nonsense",
      { method: "GET" },
      { ...env, ENVIRONMENT },
    );
    expect(response.status).toBe(401);
  });

  test("pages by keyset, so a purchase landing mid-read neither repeats nor disappears", async () => {
    // The bug an offset would have. A reconciliation pass backfilling a purchase at the head shifts the
    // whole window, so page 2 repeats a row page 1 already showed. Only a second page can catch it.
    for (const [index, day] of ["01", "02", "03", "04"].entries()) {
      await purchase({
        holder: user(`u${index + 1}`),
        sku: "com.acme.coins.100",
        transaction: `t-${day}`,
        at: new Date(`2026-06-${day}T00:00:00.000Z`),
      });
    }
    const app = makeApp([PAYMENTS_PURCHASES_READ_SCOPE]);

    const first = PaymentsAdminPurchasesResponse.parse(
      await (await call(app, "/payments/admin/purchases?limit=2", PAYMENTS_PURCHASES_READ_SCOPE)).json(),
    );
    expect(first.purchases.map((p) => p.providerTransactionId)).toEqual(["t-04", "t-03"]);
    expect(first.nextCursor).toBeTypeOf("string");

    // A fifth purchase lands between the two requests, at the head of the ordering.
    await purchase({
      holder: user("u5"),
      sku: "com.acme.coins.100",
      transaction: "t-05",
      at: new Date("2026-06-05T00:00:00.000Z"),
    });

    const second = PaymentsAdminPurchasesResponse.parse(
      await (
        await call(
          app,
          `/payments/admin/purchases?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          PAYMENTS_PURCHASES_READ_SCOPE,
        )
      ).json(),
    );
    expect(second.purchases.map((p) => p.providerTransactionId)).toEqual(["t-02", "t-01"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a malformed cursor is a first page, not a 500", async () => {
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases?cursor=not-a-cursor",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect(PaymentsAdminPurchasesResponse.parse(await response.json()).purchases).toHaveLength(1);
  });

  test("filters narrow on holder, store, status and store environment", async () => {
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    await purchase({
      holder: user("grace"),
      sku: "com.acme.coins.100",
      transaction: "t2",
      at: new Date("2026-06-02"),
      status: "refunded",
    });
    const app = makeApp([PAYMENTS_PURCHASES_READ_SCOPE]);

    const mine = PaymentsAdminPurchasesResponse.parse(
      await (
        await call(app, "/payments/admin/purchases?subjectType=user&subjectId=ada", PAYMENTS_PURCHASES_READ_SCOPE)
      ).json(),
    );
    expect(mine.purchases.map((p) => p.subjectId)).toEqual(["ada"]);

    const refunded = PaymentsAdminPurchasesResponse.parse(
      await (await call(app, "/payments/admin/purchases?status=refunded", PAYMENTS_PURCHASES_READ_SCOPE)).json(),
    );
    expect(refunded.purchases.map((p) => p.providerTransactionId)).toEqual(["t2"]);

    const sandbox = PaymentsAdminPurchasesResponse.parse(
      await (await call(app, "/payments/admin/purchases?environment=sandbox", PAYMENTS_PURCHASES_READ_SCOPE)).json(),
    );
    expect(sandbox.purchases).toEqual([]);
  });

  test("a filter value outside the kit's own vocabulary is a 400 naming the accepted set", async () => {
    // The deliberate difference from a currency or a product id. A rail is payments' own enum, so an
    // unknown one is a malformed request rather than a missing resource — and an empty pane would read to
    // an operator as "nobody bought anything through that store".
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases?rail=paypal",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });

  test("half a subject filter is a 400 on every listing, never a narrowing on the id alone", async () => {
    // The dangerous half is `subjectId` with no kind: a listing narrowed on `subject_id` alone hands a
    // client asking about a person the rows of an organization that happens to share the id, and renders as
    // *this holder bought all of it*. So the schema refuses the pair broken either way, and refuses it
    // rather than ignoring it — a filter that silently did nothing is the same wrong page with no warning.
    const app = makeApp([
      PAYMENTS_PURCHASES_READ_SCOPE,
      PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    ]);
    for (const [path, scope] of [
      ["purchases", PAYMENTS_PURCHASES_READ_SCOPE],
      ["subscriptions", PAYMENTS_SUBSCRIPTIONS_READ_SCOPE],
      ["entitlements", PAYMENTS_ENTITLEMENTS_READ_SCOPE],
    ] as const) {
      for (const half of ["subjectId=ada", "subjectType=user"]) {
        const response = await call(app, `/payments/admin/${path}?${half}`, scope);
        expect(response.status, `${path}?${half}`).toBe(400);
        expect(await errorCode(response)).toBe("validation/invalid_input");
      }
    }
  });

  test("the filter is the pair — the same id under the other kind does not cross", async () => {
    // Two holders, one id. The listing must answer about the one that was asked for, and nothing in the kit
    // makes an adopter's two id spaces disjoint, so this is the case a `WHERE subject_id = ?` gets wrong.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "t-user",
      at: new Date("2026-06-01"),
    });
    await purchase({
      holder: organization("ada"),
      sku: "com.acme.coins.100",
      transaction: "t-org",
      at: new Date("2026-06-02"),
    });
    const app = makeApp([PAYMENTS_PURCHASES_READ_SCOPE]);

    const asUser = PaymentsAdminPurchasesResponse.parse(
      await (
        await call(app, "/payments/admin/purchases?subjectType=user&subjectId=ada", PAYMENTS_PURCHASES_READ_SCOPE)
      ).json(),
    );
    expect(asUser.purchases.map((p) => p.providerTransactionId)).toEqual(["t-user"]);

    const asOrganization = PaymentsAdminPurchasesResponse.parse(
      await (
        await call(
          app,
          "/payments/admin/purchases?subjectType=organization&subjectId=ada",
          PAYMENTS_PURCHASES_READ_SCOPE,
        )
      ).json(),
    );
    expect(asOrganization.purchases.map((p) => p.providerTransactionId)).toEqual(["t-org"]);
  });

  test("the read is audited, with the operator and the connection recorded and no row in the trail", async () => {
    await purchase({ holder: user("ada"), sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases?subjectType=user&subjectId=ada",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    const event = emitted.find((e) => e.action === "payments/purchases_read");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    const metadata = event?.metadata as { connectionId?: string; returned?: number } | undefined;
    expect(metadata?.connectionId).toBe(CONNECTION_ID);
    expect(metadata?.returned).toBe(1);
    // The holder the read was narrowed to, as two keys and once more as the row's single-column resource id.
    expect(event?.resourceId).toBe("user:ada");
    expect((event?.metadata as { filters?: Record<string, unknown> } | undefined)?.filters).toMatchObject({
      subjectType: "user",
      subjectId: "ada",
    });
    // Counts and filters, never the rows: a trail that copied the purchase log would be a second purchase
    // log with weaker access rules than the first.
    expect(JSON.stringify(event?.metadata)).not.toContain("t1");
  });
});

describe("GET /payments/admin/subscriptions", () => {
  test("returns only the purchases that renew", async () => {
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
      expires: new Date("2026-07-01"),
    });
    await purchase({
      holder: user("ada"),
      sku: "com.acme.coins.100",
      transaction: "coins-1",
      at: new Date("2026-06-02"),
    });

    const body = PaymentsAdminSubscriptionsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_SUBSCRIPTIONS_READ_SCOPE]),
          "/payments/admin/subscriptions",
          PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
        )
      ).json(),
    );
    expect(body.subscriptions.map((s) => s.providerTransactionId)).toEqual(["sub-1"]);
    // The forward-looking fact a subscriptions pane is opened to find out.
    expect(body.subscriptions[0]?.expiresAt).toBe(new Date("2026-07-01").toISOString());
  });

  test("a paused subscription says when it comes back, and an indefinite one says it does not (#369)", async () => {
    // The read the first adopter's letter is written from. Before this, a paused subscription reached a
    // management client with `status: "paused"` and no date anywhere — the value was in the row's payload,
    // which no management query selects, so the letter could only say we do not hold it.
    //
    // The rail here is this file's Apple fixture, and it is beside the point: the read is rail-agnostic,
    // and which stores can produce a paused row at all is `data/pause.ts`'s question, asserted there.
    const RESUMES = new Date("2026-10-01T00:00:00.000Z");
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-paused",
      at: new Date("2026-06-01"),
      status: "paused",
      resumes: RESUMES,
    });
    await purchase({
      holder: user("grace"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-indefinite",
      at: new Date("2026-06-02"),
      status: "paused",
    });

    const body = PaymentsAdminSubscriptionsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_SUBSCRIPTIONS_READ_SCOPE]),
          "/payments/admin/subscriptions",
          PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
        )
      ).json(),
    );
    const dated = body.subscriptions.find((s) => s.providerTransactionId === "sub-paused");
    const indefinite = body.subscriptions.find((s) => s.providerTransactionId === "sub-indefinite");
    expect(dated?.resumesAt).toBe(RESUMES.toISOString());
    // Both are paused. The date is what separates "paused until the 1st" from "paused indefinitely", and
    // an adopter writing either sentence needs both halves to survive the trip.
    expect(indefinite?.status).toBe("paused");
    expect(indefinite?.resumesAt).toBeNull();
  });

  test("the subscription scope does not open the purchase log", async () => {
    // The split is only real if holding the narrower grant genuinely denies the wider one. `scopeCovers`
    // matches exactly, with no prefix rule, and this is where that is worth more than a comment.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.coins.100",
      transaction: "coins-1",
      at: new Date("2026-06-02"),
    });
    const response = await call(
      makeApp([PAYMENTS_SUBSCRIPTIONS_READ_SCOPE]),
      "/payments/admin/purchases",
      PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("and the purchase-log scope does not open the subscriptions read", async () => {
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/subscriptions",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /payments/admin/entitlements", () => {
  test("resolves `granted` against the clock rather than trusting the stored flag", async () => {
    // A subscription can lapse with no notification arriving at all, so a row can say `active` with an
    // expiry in the past. The gate the adopter's own app calls applies the timestamp on every request; a
    // dashboard that rendered the flag would disagree with it, and the customer would believe us.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-05-01"),
      expires: new Date("2026-06-01T00:00:00.000Z"),
    });
    const stored = await env.DB.prepare(
      "SELECT active FROM pithy_payments_entitlements WHERE subject_type = 'user' AND subject_id = 'ada'",
    ).first<{
      active: number;
    }>();
    expect(stored?.active).toBe(1);

    const body = PaymentsAdminEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    // Lapsed on 1 June; `NOW` is the 10th. Returned rather than hidden, with its date, because a paywall
    // and an operator both need to say "your Pro ended on the 1st".
    expect(body.entitlements).toEqual([
      expect.objectContaining({ subjectType: "user", subjectId: "ada", key: "pro", granted: false, manual: false }),
    ]);
    expect(body.entitlements[0]?.expiresAt).toBe(new Date("2026-06-01T00:00:00.000Z").toISOString());
  });

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    // The entitlement row holds four things this response must not publish, and all four are the kind
    // nobody writes a `not.toContain` for: its own UUID, the stored `active` flag whose whole point is
    // that it is *not* the answer `granted` gives, and two ms-epoch timestamps. Enumeration would never
    // have named them; the invariant refuses them without being told they exist.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: PURCHASED_AT,
      expires: new Date("2026-07-01T00:00:00.000Z"),
    });
    const raw = await (
      await call(
        makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
        "/payments/admin/entitlements",
        PAYMENTS_ENTITLEMENTS_READ_SCOPE,
      )
    ).json();

    // The granting purchase's id is published as `source`, so it is read from the column that holds it.
    const purchaseId = await env.DB.prepare("SELECT id FROM pithy_payments_purchases").first<{ id: string }>();
    const published = [
      "user",
      "ada",
      "pro",
      purchaseId?.id ?? "",
      new Date("2026-07-01T00:00:00.000Z").toISOString(),
      // `granted` and `manual`, and the null of a page with nothing after it.
      true,
      false,
      null,
    ];
    const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_ENTITLEMENT_KEYS });
    expect(escaped, `The entitlement model published this:\n  ${escaped.join("\n  ")}`).toEqual([]);

    // And the row really carries what the sweep is meant to refuse.
    const stored = await env.DB.prepare(
      "SELECT id, active, created_at, updated_at FROM pithy_payments_entitlements WHERE subject_id = 'ada'",
    ).first<{ id: string; active: number; created_at: number; updated_at: number }>();
    expect(stored?.id).toBeTypeOf("string");
    expect(stored?.id).not.toBe(purchaseId?.id);
    expect(stored?.active).toBe(1);
    expect(stored?.created_at).toBeTypeOf("number");
  });

  test("the entitlement schema declares nothing the hand-written key list does not name", () => {
    const declared = [
      "entitlements",
      "nextCursor",
      "subjectType",
      "subjectId",
      ...Object.keys(PaymentsAdminEntitlementView.shape),
    ];
    expect(declared.filter((key) => !PUBLISHED_ENTITLEMENT_KEYS.includes(key))).toEqual([]);
    expect(PUBLISHED_ENTITLEMENT_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("shows which grants a human wrote and which a purchase produced", async () => {
    // The question the grant and revoke writes made unanswerable on their own: a console could comp an
    // entitlement and never see that it had. `manual` and `source` are what close that loop.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
    });
    await grantEntitlement(env.DB, CONFIG, { ...user("grace"), entitlement: "pro", expiresAt: null }, { now: NOW });

    const body = PaymentsAdminEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    const grace = body.entitlements.find((e) => e.subjectId === "grace");
    const ada = body.entitlements.find((e) => e.subjectId === "ada");
    expect(grace).toMatchObject({ key: "pro", granted: true, manual: true, source: null });
    expect(ada).toMatchObject({ key: "pro", granted: true, manual: false });
    expect(ada?.source).toBeTypeOf("string");
  });

  test("filters to one entitlement key — the “who holds pro” question", async () => {
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
    });
    await purchase({
      holder: user("ada"),
      sku: "com.acme.coins.100",
      transaction: "coins-1",
      at: new Date("2026-06-02"),
    });
    const body = PaymentsAdminEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements?entitlement=pro",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    expect(body.entitlements.map((e) => e.key)).toEqual(["pro"]);
  });

  test("pages by keyset and stops at the end", async () => {
    for (const [index, day] of ["01", "02", "03"].entries()) {
      await purchase({
        holder: user(`u${index + 1}`),
        sku: "com.acme.pro.monthly",
        transaction: `t-${day}`,
        at: new Date(`2026-06-${day}T00:00:00.000Z`),
      });
    }
    const app = makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]);
    const first = PaymentsAdminEntitlementsResponse.parse(
      await (await call(app, "/payments/admin/entitlements?limit=2", PAYMENTS_ENTITLEMENTS_READ_SCOPE)).json(),
    );
    expect(first.entitlements).toHaveLength(2);
    const second = PaymentsAdminEntitlementsResponse.parse(
      await (
        await call(
          app,
          `/payments/admin/entitlements?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    expect(second.entitlements).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // No row appears in both pages, which is the property an offset silently loses.
    const ids = [...first.entitlements, ...second.entitlements].map((e) => `${e.subjectType}:${e.subjectId}:${e.key}`);
    expect(new Set(ids).size).toBe(3);
  });

  test("a grant scope is not a read scope", async () => {
    // Payments' whole surface used to be the two writes. A connection holding one must not thereby be able
    // to page every account's entitlements.
    const response = await call(
      makeApp([PAYMENTS_ENTITLEMENT_GRANT_SCOPE]),
      "/payments/admin/entitlements",
      PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /payments/admin/entitlements/:subjectType/:subjectId", () => {
  test("resolves everything one subject holds, by key", async () => {
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
    });
    await purchase({
      holder: user("ada"),
      sku: "com.acme.coins.100",
      transaction: "coins-1",
      at: new Date("2026-06-02"),
    });
    await purchase({
      holder: user("grace"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-2",
      at: new Date("2026-06-03"),
    });

    const body = PaymentsAdminSubjectEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements/user/ada",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    // The address, echoed back whole, so a response stands on its own in a log or a client's cache.
    expect(body.subjectType).toBe("user");
    expect(body.subjectId).toBe("ada");
    expect(body.entitlements.map((e) => e.key)).toEqual(["coins", "pro"]);
    // Never somebody else's, whatever else is in the table.
    expect(body.entitlements.every((e) => e.subjectId === "ada")).toBe(true);
  });

  test("the kind is half the address — the same id under the other one holds nothing", async () => {
    // The whole reason the route carries two segments. `organization:ada` and `user:ada` are two holders,
    // and a read keyed on the id alone would hand one of them the other's entitlements. Nothing in the kit
    // makes an adopter's organization ids and their user ids disjoint, so this is a collision waiting for a
    // deployment rather than a hypothetical.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
    });

    const mine = PaymentsAdminSubjectEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements/organization/ada",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    expect(mine.subjectType).toBe("organization");
    expect(mine.entitlements).toEqual([]);
  });

  test("a kind that is not one of the two is a 400, not a 404", async () => {
    // A malformed address, refused by the param validator behind the guard. A 404 would read as "that holder
    // has nothing here", which is a different and wrong sentence — and one that would make this surface an
    // existence oracle by accident.
    const response = await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/entitlements/tenant/ada",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });

  test("no credential at all is refused before the param schema is ever consulted", async () => {
    // The validator sits behind the guard, so a malformed address from an unverified caller is a 401 rather
    // than a 400. A 400 here would tell a stranger which of their requests were well-formed.
    const response = await makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]).request(
      "http://x/payments/admin/entitlements/tenant/ada",
      { method: "GET" },
      { ...env, ENVIRONMENT },
    );
    expect(response.status).toBe(401);
  });

  test("a subject holding nothing is an empty list, not a 404", async () => {
    // An entitlement row appears with the first purchase that grants one, so its absence is not a missing
    // holder — and a 404 would make this an existence oracle for user and organization ids alike.
    const response = await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/entitlements/user/nobody",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect(PaymentsAdminSubjectEntitlementsResponse.parse(await response.json()).entitlements).toEqual([]);
  });

  test("the read is audited against the subject it named, both halves", async () => {
    await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/entitlements/user/ada",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    const event = emitted.find((e) => e.action === "payments/entitlements_read");
    // `resourceId` is one column, so the pair is encoded for it — the one single-field slot of ours.
    expect(event?.resourceId).toBe("user:ada");
    // And the metadata carries the halves apart, because that is what a trail is queried by.
    expect(event?.metadata?.subjectType).toBe("user");
    expect(event?.metadata?.subjectId).toBe("ada");
    expect(event?.actorType).toBe("control-plane");
  });
});

describe("the reads never widen into the player surface, and never write", () => {
  test("a management credential cannot reach the buyer's own entitlements route", async () => {
    // `GET /payments/entitlements` is a bearer route reading `c.var.auth.userId`, and the seam leaves
    // `auth` null for a management client — so the bare path denies however good the token is. This is why
    // the reads live under `admin/` rather than sharing the address.
    const response = await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/entitlements",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    expect(response.status).toBe(401);
  });

  test("a read changes nothing", async () => {
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
    });
    const before = await env.DB.prepare("SELECT * FROM pithy_payments_purchases").all();
    const app = makeApp([PAYMENTS_PURCHASES_READ_SCOPE, PAYMENTS_ENTITLEMENTS_READ_SCOPE]);
    await call(app, "/payments/admin/purchases", PAYMENTS_PURCHASES_READ_SCOPE);
    await call(app, "/payments/admin/entitlements", PAYMENTS_ENTITLEMENTS_READ_SCOPE);
    const after = await env.DB.prepare("SELECT * FROM pithy_payments_purchases").all();
    // Including `updatedAt`: a read that repaired a stale row would be the reconciliation Workflow's job
    // done in the hot path, and would make every pane load a write against a customer's database.
    expect(after.results).toEqual(before.results);
    expect(after.results).toHaveLength(1);
  });
});

/**
 * The reconciliation run log (#316), and the invariant that keeps it operational rather than commercial.
 *
 * This is the one management read here that is not about a customer. A run says whether the compensating
 * control for a delivery mechanism that is known to fail has been firing, and how much it had to repair —
 * so it goes behind its own scope, and an adopter can hand a health monitor exactly that.
 *
 * **The disclosure assertion is a positive invariant, never a list of forbidden strings.** A negative sweep
 * is a list somebody has to keep, and the field that leaks is the one nobody thought to forbid. So the claim
 * is stated the other way round, in two halves that are each insufficient alone: *every key in the response
 * is one written out below*, and *every leaf is one of the facts the run itself recorded* — its own id, its
 * two timestamps, its rail, its environment, one of its counts, or a boolean.
 *
 * The rows the pass ran over carry a sentinel payload (`purchase()` above writes one), so a projection that
 * reached anything of a store's would have a value with nowhere to belong.
 *
 * **Two things about the sweep were wrong when this shipped, and #328 fixed both.**
 *
 * It ran over `PaymentsAdminReconcileRunsResponse.parse(body)`. **Zod strips unknown keys**, so the copy it
 * examined had already had any undeclared field removed: both halves of the invariant were computed against
 * a document the widening could not appear in, and the gate was structurally incapable of failing for its
 * own reason. It reads the raw body now, and the planted case below proves the difference rather than
 * asserting it. The catalog and purchase sweeps above always read `raw` — this one alone did not.
 *
 * And the walkers were a private pair here, added in the same wave in which `@pithy-sh/core`'s
 * {@link unpublishedIn} was extracted precisely because four hand-rolled copies existed and one was blind
 * to booleans and nulls. A fifth copy in the file the consolidation had just cleaned. There is one producer
 * now, and its blindness is planted against on every run in `packages/core/src/projection/published.test.ts`.
 */
describe("the reconciliation run log", () => {
  /**
   * Every key this response is permitted to carry. Written out by hand, never read off
   * `PaymentsAdminReconcileRunView.shape` — a gate derived from what it polices cannot fail when what it
   * polices changes, which is exactly how the catalog's own sweep passed while widening (#308).
   */
  const PERMITTED_KEYS = [
    "runs",
    "nextCursor",
    "id",
    "startedAt",
    "finishedAt",
    "environment",
    "rail",
    "pages",
    "scanned",
    "unchanged",
    "drifted",
    "superseded",
    "skipped",
    "failed",
    "truncated",
    "dryRun",
  ];

  const RUN = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    startedAt: new Date("2026-06-09T04:00:00.000Z"),
    finishedAt: new Date("2026-06-09T04:02:00.000Z"),
    environment: "production" as const,
    rail: "apple" as const,
    report: {
      pages: 2,
      scanned: 41,
      unchanged: 39,
      drifted: 1,
      superseded: 1,
      skipped: 0,
      failed: 0,
      truncated: false,
      dryRun: false,
    },
  };

  /** The body exactly as it left the Worker. What a client receives is what a disclosure gate is about. */
  async function readRunsRaw(query = ""): Promise<unknown> {
    const response = await call(
      makeApp([PAYMENTS_RECONCILE_READ_SCOPE]),
      `/payments/admin/reconcile-runs${query}`,
      PAYMENTS_RECONCILE_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    return await response.json();
  }

  /** The same body, through the schema — for the tests that are about the contract rather than disclosure. */
  async function readRuns(query = ""): Promise<PaymentsAdminReconcileRunsResponse> {
    return PaymentsAdminReconcileRunsResponse.parse(await readRunsRaw(query));
  }

  test("returns the passes this deployment has run, newest first", async () => {
    await recordReconcileRun(env.DB, RUN, { now: NOW });
    await recordReconcileRun(
      env.DB,
      { ...RUN, id: "later", startedAt: new Date("2026-06-10T04:00:00.000Z"), rail: null },
      { now: NOW },
    );
    const body = await readRuns();
    expect(body.runs.map((run) => run.id)).toEqual(["later", RUN.id]);
    expect(body.runs[1]?.drifted).toBe(1);
    expect(body.runs[1]?.rail).toBe("apple");
    expect(body.runs[0]?.rail).toBeNull();
  });

  test("an empty page is the answer, and it is the loud one", async () => {
    // Reconciliation has never run here. For a project that has provisioned the Workflow that is the
    // failure this read exists to surface, so it is a page rather than a 404 an operator would misread.
    const body = await readRuns();
    expect(body.runs).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  test("narrows to one rail and to one store environment", async () => {
    await recordReconcileRun(env.DB, RUN, { now: NOW });
    await recordReconcileRun(env.DB, { ...RUN, id: "sandbox-run", environment: "sandbox" }, { now: NOW });
    // Same `startedAt`, so the id is the tiebreak and it descends — the keyset's own order, not an accident.
    expect((await readRuns("?rail=apple")).runs.map((run) => run.id)).toEqual(["sandbox-run", RUN.id]);
    expect((await readRuns("?environment=sandbox")).runs.map((run) => run.id)).toEqual(["sandbox-run"]);
  });

  /** Every fact one `RUN` legitimately discloses, plus the envelope's own null end-of-page. */
  function publishedFactsOf(run: typeof RUN): (string | number | boolean | null)[] {
    return [
      run.id,
      run.startedAt.toISOString(),
      run.finishedAt.toISOString(),
      run.environment,
      ...(run.rail === null ? [] : [run.rail]),
      ...Object.values(run.report),
      // The envelope's own ends: a first page resumes nowhere.
      null,
    ];
  }

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    // Both halves at once, over the **raw** body. It ran over the parsed one until #328: Zod strips unknown
    // keys, so an undeclared field was removed from the document before either half looked at it, and the
    // gate could not fail for the reason it exists. The test below plants exactly that.
    await purchase({
      holder: user("ada"),
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
    });
    await recordReconcileRun(env.DB, RUN, { now: NOW });
    const raw = await readRunsRaw();

    const escaped = unpublishedIn(raw, { leaves: publishedFactsOf(RUN), keys: PERMITTED_KEYS });
    expect(
      escaped,
      `These crossed the reconciliation read and are neither a key it publishes nor a fact the run recorded:\n  ${escaped.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the sweep reads the body the Worker sent, not one a schema has already sanitized", async () => {
    // The defect, planted. `PaymentsAdminReconcileRunsResponse.parse` drops an unknown key, so a sweep over
    // its output examines a document the offending field has already been removed from — a gate reading a
    // copy of its own subject, cleaned. Both directions are asserted here: the sweep sees the widening, and
    // the parse is shown to be what hid it.
    await recordReconcileRun(env.DB, RUN, { now: NOW });
    const raw = (await readRunsRaw()) as { runs: Record<string, unknown>[] };

    // A projection widens by gaining a field. This is the cheapest possible one, carrying a store's payload.
    const widened = { ...raw, runs: raw.runs.map((run) => ({ ...run, providerPayload: "s3cret-from-the-store" })) };
    const escaped = unpublishedIn(widened, { leaves: publishedFactsOf(RUN), keys: PERMITTED_KEYS });
    expect(escaped).toEqual([
      'key "providerPayload" at runs[0].providerPayload',
      'value "s3cret-from-the-store" at runs[0].providerPayload',
    ]);

    // And through the schema it is simply gone, which is why the sweep must never be handed that copy.
    const sanitized = PaymentsAdminReconcileRunsResponse.parse(widened);
    expect(unpublishedIn(sanitized, { leaves: publishedFactsOf(RUN), keys: PERMITTED_KEYS })).toEqual([]);
  });

  test("the sweep is running against a run that really carries all of it", async () => {
    // A gate over nothing passes perfectly. The row the assertion above reads must genuinely hold the id,
    // both timestamps, the rail, the environment and all nine counts — twelve leaves at minimum, on one run.
    await recordReconcileRun(env.DB, RUN, { now: NOW });
    const raw = (await readRunsRaw()) as { runs: Record<string, unknown>[] };
    expect(raw.runs).toHaveLength(1);
    // Every value the permit list names is genuinely a **leaf** of the row. It read `toContain` over the
    // serialized row until #332, and a substring is not a leaf: `"2026-06-09"` and `"apple"`'s own first
    // letter both pass that, so a permitted value the row does not carry could sit on the list as slack —
    // silently absolving a future field that happens to publish it. The walk is the same one the sweep
    // above descends with, so the two agree on what the document holds by construction.
    const carried = leavesIn(raw.runs[0]);
    for (const fact of publishedFactsOf(RUN)) {
      if (fact === null) continue;
      expect(
        carried,
        `The run row does not carry ${JSON.stringify(fact)} as a value of its own, so permitting it proves nothing.`,
      ).toContain(fact);
    }
  });

  test("the response schema declares nothing the hand-written key list does not name", () => {
    // The other place a widening fails, and the earlier one: on the schema edit, before any view fills the
    // new field. The list polices the schema; the schema never polices itself.
    const declared = ["runs", "nextCursor", ...Object.keys(PaymentsAdminReconcileRunView.shape)];
    expect(declared.filter((key) => !PERMITTED_KEYS.includes(key))).toEqual([]);
    // And in the other direction, so a field removed from the schema leaves no permission behind it.
    expect(PERMITTED_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("a connection without the scope is refused, not handed the log", async () => {
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/reconcile-runs",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
  });

  test("the purchase log's scope confers nothing here, and this one confers nothing there", async () => {
    // `scopeCovers` matches exactly. A health monitor granted the run log must not acquire the commerce,
    // which is the whole reason this is a scope of its own rather than a row on an existing read.
    const response = await call(
      makeApp([PAYMENTS_RECONCILE_READ_SCOPE]),
      "/payments/admin/purchases",
      PAYMENTS_RECONCILE_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("the read is audited, naming the operator and the connection", async () => {
    await recordReconcileRun(env.DB, RUN, { now: NOW });
    await readRuns();
    const event = emitted.find((e) => e.action === "payments/reconcile_runs_read");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect(event?.metadata?.connectionId).toBe(CONNECTION_ID);
    expect(event?.metadata?.returned).toBe(1);
  });
});
