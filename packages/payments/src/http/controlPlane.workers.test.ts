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
import { unpublishedIn } from "@pithy-sh/core/src/projection/published";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { grantEntitlement } from "../entitlement/manual";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { projectPurchase } from "../projection/writer";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./guards";
import {
  PaymentsAdminCatalogProduct,
  PaymentsAdminCatalogResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminEntitlementView,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminPurchaseView,
  PaymentsAdminSubscriptionsResponse,
  PaymentsAdminUserEntitlementsResponse,
} from "./responses";
import { registerPaymentsRoutes } from "./routes";

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

/** One purchase, written by the real projection so the rows are the ones a webhook would have left. */
async function purchase(options: {
  user: string;
  sku: string;
  transaction: string;
  at: Date;
  status?: "active" | "refunded" | "expired";
  expires?: Date | null;
  amount?: number;
}): Promise<void> {
  await projectPurchase(
    env.DB,
    {
      rail: "apple",
      providerTransactionId: options.transaction,
      providerProductId: options.sku,
      userId: options.user,
      status: options.status ?? "active",
      environment: "production",
      purchasedAt: options.at,
      expiresAt: options.expires ?? null,
      providerEventAt: options.at,
      amountMinor: options.amount ?? 999,
      currency: "USD",
      // The receipt, as a rail hands it over. Every assertion about what a management read discloses is
      // made against a row that actually holds one.
      payload: { transactionId: options.transaction, appAccountToken: `token-${options.user}`, secret: "s3cret" },
    },
    { config: CONFIG, environment: "production", now: options.at },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

beforeEach(async () => {
  for (const table of [
    "pithy_payments_webhook_events",
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
    // And what is meant to cross does cross.
    const app = makeApp([PAYMENTS_CATALOG_READ_SCOPE], SENTINEL_CATALOG);
    const text = await (await call(app, "/payments/admin/catalog", PAYMENTS_CATALOG_READ_SCOPE)).text();
    for (const published of ["pro_monthly", "subscription", "Pro", "coins", "founder"]) {
      expect(text, published).toContain(published);
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
    // The same modelled answer `clientProjection` gives, and for the same reason: a client branches on
    // `enabled`, so "composed with nothing to sell" reads as its own state rather than as a dropdown that
    // came back broken. A catalog that failed to *load* is a non-200 or a body that does not parse, which
    // no branch on `enabled` can be confused by.
    const body = PaymentsAdminCatalogResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_CATALOG_READ_SCOPE], PaymentsConfig.parse({})),
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
 * Every key `GET {base}/admin/purchases` may carry, at any depth. Seventeen: the envelope's two, and a
 * purchase's fifteen. `GET {base}/admin/subscriptions` returns the same view under one other envelope
 * key, so widening the row is refused here whichever route a client reached it through.
 *
 * **Written out, never `Object.keys(PaymentsAdminPurchaseView.shape)`.** See the note above
 * `SENTINEL_CATALOG`: a gate derived from what it polices cannot fail when what it polices changes, and
 * that is not a hypothetical here — it is what the catalog read's first version did.
 */
const PUBLISHED_PURCHASE_KEYS = [
  "purchases",
  "nextCursor",
  "id",
  "userId",
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
  "updatedAt",
];

/** Every key the two entitlement reads may carry. Nine: two envelopes' three, and an entitlement's six. */
const PUBLISHED_ENTITLEMENT_KEYS = [
  "entitlements",
  "nextCursor",
  "userId",
  "key",
  "granted",
  "expiresAt",
  "manual",
  "source",
];

describe("GET /payments/admin/purchases", () => {
  test("answers a connection holding the scope, and the body is what the schema says it is", async () => {
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });

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
      userId: "ada",
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
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: PURCHASED_AT });
    const raw = await (
      await call(makeApp([PAYMENTS_PURCHASES_READ_SCOPE]), "/payments/admin/purchases", PAYMENTS_PURCHASES_READ_SCOPE)
    ).json();

    // The row's UUID is minted at write time, so it is read back from the column that holds it — named,
    // one column, never the whole row. Deriving the permitted values from the row would publish every
    // column by construction, which is the same mistake as deriving the keys from the schema.
    const id = await env.DB.prepare("SELECT id FROM pithy_payments_purchases").first<{ id: string }>();
    const published = [
      id?.id ?? "",
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
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: PURCHASED_AT });
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
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
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
        user: `u${index + 1}`,
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
      user: "u5",
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
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases?cursor=not-a-cursor",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect(PaymentsAdminPurchasesResponse.parse(await response.json()).purchases).toHaveLength(1);
  });

  test("filters narrow on account, store, status and store environment", async () => {
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    await purchase({
      user: "grace",
      sku: "com.acme.coins.100",
      transaction: "t2",
      at: new Date("2026-06-02"),
      status: "refunded",
    });
    const app = makeApp([PAYMENTS_PURCHASES_READ_SCOPE]);

    const mine = PaymentsAdminPurchasesResponse.parse(
      await (await call(app, "/payments/admin/purchases?userId=ada", PAYMENTS_PURCHASES_READ_SCOPE)).json(),
    );
    expect(mine.purchases.map((p) => p.userId)).toEqual(["ada"]);

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

  test("the read is audited, with the operator and the connection recorded and no row in the trail", async () => {
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases?userId=ada",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    const event = emitted.find((e) => e.action === "payments/purchases_read");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    const metadata = event?.metadata as { connectionId?: string; returned?: number } | undefined;
    expect(metadata?.connectionId).toBe(CONNECTION_ID);
    expect(metadata?.returned).toBe(1);
    // Counts and filters, never the rows: a trail that copied the purchase log would be a second purchase
    // log with weaker access rules than the first.
    expect(JSON.stringify(event?.metadata)).not.toContain("t1");
  });
});

describe("GET /payments/admin/subscriptions", () => {
  test("returns only the purchases that renew", async () => {
    await purchase({
      user: "ada",
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-06-01"),
      expires: new Date("2026-07-01"),
    });
    await purchase({ user: "ada", sku: "com.acme.coins.100", transaction: "coins-1", at: new Date("2026-06-02") });

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

  test("the subscription scope does not open the purchase log", async () => {
    // The split is only real if holding the narrower grant genuinely denies the wider one. `scopeCovers`
    // matches exactly, with no prefix rule, and this is where that is worth more than a comment.
    await purchase({ user: "ada", sku: "com.acme.coins.100", transaction: "coins-1", at: new Date("2026-06-02") });
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
      user: "ada",
      sku: "com.acme.pro.monthly",
      transaction: "sub-1",
      at: new Date("2026-05-01"),
      expires: new Date("2026-06-01T00:00:00.000Z"),
    });
    const stored = await env.DB.prepare("SELECT active FROM pithy_payments_entitlements WHERE user_id = 'ada'").first<{
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
      expect.objectContaining({ userId: "ada", key: "pro", granted: false, manual: false }),
    ]);
    expect(body.entitlements[0]?.expiresAt).toBe(new Date("2026-06-01T00:00:00.000Z").toISOString());
  });

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    // The entitlement row holds four things this response must not publish, and all four are the kind
    // nobody writes a `not.toContain` for: its own UUID, the stored `active` flag whose whole point is
    // that it is *not* the answer `granted` gives, and two ms-epoch timestamps. Enumeration would never
    // have named them; the invariant refuses them without being told they exist.
    await purchase({
      user: "ada",
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
      "SELECT id, active, created_at, updated_at FROM pithy_payments_entitlements WHERE user_id = 'ada'",
    ).first<{ id: string; active: number; created_at: number; updated_at: number }>();
    expect(stored?.id).toBeTypeOf("string");
    expect(stored?.id).not.toBe(purchaseId?.id);
    expect(stored?.active).toBe(1);
    expect(stored?.created_at).toBeTypeOf("number");
  });

  test("the entitlement schema declares nothing the hand-written key list does not name", () => {
    const declared = ["entitlements", "nextCursor", "userId", ...Object.keys(PaymentsAdminEntitlementView.shape)];
    expect(declared.filter((key) => !PUBLISHED_ENTITLEMENT_KEYS.includes(key))).toEqual([]);
    expect(PUBLISHED_ENTITLEMENT_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("shows which grants a human wrote and which a purchase produced", async () => {
    // The question the grant and revoke writes made unanswerable on their own: a console could comp an
    // entitlement and never see that it had. `manual` and `source` are what close that loop.
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "sub-1", at: new Date("2026-06-01") });
    await grantEntitlement(env.DB, { userId: "grace", entitlement: "pro", expiresAt: null }, { now: NOW });

    const body = PaymentsAdminEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    const grace = body.entitlements.find((e) => e.userId === "grace");
    const ada = body.entitlements.find((e) => e.userId === "ada");
    expect(grace).toMatchObject({ key: "pro", granted: true, manual: true, source: null });
    expect(ada).toMatchObject({ key: "pro", granted: true, manual: false });
    expect(ada?.source).toBeTypeOf("string");
  });

  test("filters to one entitlement key — the “who holds pro” question", async () => {
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "sub-1", at: new Date("2026-06-01") });
    await purchase({ user: "ada", sku: "com.acme.coins.100", transaction: "coins-1", at: new Date("2026-06-02") });
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
        user: `u${index + 1}`,
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
    const ids = [...first.entitlements, ...second.entitlements].map((e) => `${e.userId}:${e.key}`);
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

describe("GET /payments/admin/entitlements/:userId", () => {
  test("resolves everything one account holds, by key", async () => {
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "sub-1", at: new Date("2026-06-01") });
    await purchase({ user: "ada", sku: "com.acme.coins.100", transaction: "coins-1", at: new Date("2026-06-02") });
    await purchase({ user: "grace", sku: "com.acme.pro.monthly", transaction: "sub-2", at: new Date("2026-06-03") });

    const body = PaymentsAdminUserEntitlementsResponse.parse(
      await (
        await call(
          makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
          "/payments/admin/entitlements/ada",
          PAYMENTS_ENTITLEMENTS_READ_SCOPE,
        )
      ).json(),
    );
    expect(body.userId).toBe("ada");
    expect(body.entitlements.map((e) => e.key)).toEqual(["coins", "pro"]);
    // Never somebody else's, whatever else is in the table.
    expect(body.entitlements.every((e) => e.userId === "ada")).toBe(true);
  });

  test("an account holding nothing is an empty list, not a 404", async () => {
    // An entitlement row appears with the first purchase that grants one, so its absence is not a missing
    // person — and a 404 would make this an existence oracle for user ids.
    const response = await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/entitlements/nobody",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect(PaymentsAdminUserEntitlementsResponse.parse(await response.json()).entitlements).toEqual([]);
  });

  test("the read is audited against the account it named", async () => {
    await call(
      makeApp([PAYMENTS_ENTITLEMENTS_READ_SCOPE]),
      "/payments/admin/entitlements/ada",
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    );
    const event = emitted.find((e) => e.action === "payments/entitlements_read");
    expect(event?.resourceId).toBe("ada");
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
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "sub-1", at: new Date("2026-06-01") });
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
