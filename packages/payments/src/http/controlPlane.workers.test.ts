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
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { grantEntitlement } from "../entitlement/manual";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_control_plane_reads } from "../migrations/0002_control_plane_reads";
import { projectPurchase } from "../projection/writer";
import {
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./guards";
import {
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminPurchasesResponse,
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
function makeApp(scopes: readonly ControlPlaneScope[]) {
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
  registerPaymentsRoutes({ config: CONFIG, now: () => NOW })(app);
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
  await payments_0002_control_plane_reads.up(db);
  emitted = [];
});

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

  test("the stored provider payload is nowhere in the response", async () => {
    // The one column across all four tables that is a bearer artifact, and on Stripe a document carrying
    // the buyer's email address and billing details. The queries do not select it — this proves the whole
    // path, including that no key of it survives serialization under another name.
    await purchase({ user: "ada", sku: "com.acme.pro.monthly", transaction: "t1", at: new Date("2026-06-01") });
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/purchases",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    const raw = await response.text();
    expect(raw).not.toContain("payload");
    expect(raw).not.toContain("s3cret");
    expect(raw).not.toContain("appAccountToken");
    // And the row it came from really did hold one, so the assertion above is not passing vacuously.
    const stored = await env.DB.prepare("SELECT payload FROM pithy_payments_purchases").first<{ payload: string }>();
    expect(stored?.payload).toContain("s3cret");
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
