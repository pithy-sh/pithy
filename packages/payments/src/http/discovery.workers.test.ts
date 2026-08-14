// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import { type AdminRoute, ControlPlaneManifest } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { controlplane_0001_init } from "@pithy-sh/core/src/controlPlane/migrations/0001_init";
import { MANIFEST_READ_SCOPE } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { payments } from "../capability";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { projectPurchase } from "../projection/writer";
import {
  PaymentsAdminCatalogResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminSubscriptionsResponse,
} from "./responses";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./scopes";

/**
 * Discovery, end to end, against a **composed backend** — the shape of #247 rather than its symptom.
 *
 * `controlPlane.workers.test.ts` proves the handlers. This proves the thing that actually broke: a
 * management client learns what it may call from `GET /control-plane/manifest` and from nothing else, and
 * before these reads existed the manifest simply did not mention purchases, entitlements or
 * subscriptions. The dashboard's three panes therefore computed `absent` — **not** blocked, not refused —
 * and dropped out of the rail. Nothing 403'd, nothing logged, nothing was wrong to look at.
 *
 * So every call below is composed from the manifest's own reply, by the rule a management client applies:
 * a `GET`, with a declared scope, no `:` segment, at a path ending in the resource's noun. Nothing here
 * concatenates a path or assumes a base — which is also why the project is mounted at `/billing`, the
 * case that catches a client having hardcoded the default.
 *
 * The names are `replay` and `board` rather than one word used twice. A Worker deploys as
 * `<project>-<worker>`, and a fixture where both are the same hides a whole class of confusion.
 */

const PROJECT = "replay";
const WORKER = "board";
const ENVIRONMENT = "prod";
const ISSUER = "https://dashboard.example";
const CONNECTION_ID = "c0ffee00-1111-4222-8333-444455556666";
const KEY_ID = "key-1";
const BASE_PATH = "/billing";

/** The three resources the first adopter's payments panes read. */
const PANES = ["purchases", "entitlements", "subscriptions"] as const;

/** The composed Worker, exactly as `apps/board/pithy.config.ts` would assemble it. */
const backend = createBackend({
  capabilities: [
    controlplane(),
    secrets({ registry: {} }),
    payments({
      basePath: BASE_PATH,
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
    }),
  ],
});

const BINDINGS = { ...env, ENVIRONMENT, PITHY_PROJECT: PROJECT, PITHY_WORKER: WORKER };

let keys: CryptoKeyPair;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
});

/** Register a connection — what `pithy dashboard connect` writes, and the only thing that opens the seam. */
async function connect(scopes: string[]): Promise<void> {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: `https://${PROJECT}-${WORKER}.workers.dev`,
        basePath: "/control-plane",
        scopes,
        keys: [
          {
            keyId: KEY_ID,
            publicKey: await exportPublicJwk(keys.publicKey),
            validFrom: new Date(now.getTime() - 60_000),
            validUntil: null,
            revokedAt: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

/** One real HTTP GET at the composed backend, carrying a freshly minted single-use token. */
async function get(path: string, scope: string): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
  });
  return backend.request(
    `http://${PROJECT}-${WORKER}.workers.dev${path}`,
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    BINDINGS,
  );
}

/** The manifest, as a management client reads it before deciding anything. */
async function manifest(): Promise<ControlPlaneManifest> {
  const response = await get("/control-plane/manifest", MANIFEST_READ_SCOPE);
  expect(response.status).toBe(200);
  return ControlPlaneManifest.parse(await response.json());
}

/** Payments' declared surface, as the manifest reports it. */
function paymentsRoutes(reported: ControlPlaneManifest): AdminRoute[] {
  return reported.capabilities.find((capability) => capability.name === "payments")?.adminRoutes ?? [];
}

/**
 * The collection route a pane would pick, by the rule a management client actually uses.
 *
 * A `GET`, because a pane reads. A declared scope, because a token binds exactly one and a route naming
 * none cannot be spent through. No `:` segment, because a route with a hole in it cannot be called until
 * something has already been chosen. And a path ending in the resource, because the mount point moves and
 * the noun does not.
 */
function collection(routes: AdminRoute[], resource: string): AdminRoute | undefined {
  return routes.find(
    (route) =>
      route.method === "GET" &&
      route.scope !== null &&
      !route.path.includes(":") &&
      route.path.endsWith(`/${resource}`),
  );
}

/** What a pane computes from the manifest alone, before any call goes out. */
function paneAccess(reported: ControlPlaneManifest, resource: string): "absent" | "blocked" | "ready" {
  const route = collection(paymentsRoutes(reported), resource);
  if (!route) return "absent";
  return reported.grantedScopes.includes(route.scope ?? "") ? "ready" : "blocked";
}

/** Two purchases: one that renews, one that does not, so the two listings genuinely differ. */
async function seed(): Promise<void> {
  for (const [sku, at] of [
    ["com.acme.pro.monthly", "2026-06-01T00:00:00.000Z"],
    ["com.acme.coins.100", "2026-06-02T00:00:00.000Z"],
  ] as const) {
    await projectPurchase(
      env.DB,
      {
        rail: "apple",
        providerTransactionId: `t-${sku}`,
        providerProductId: sku,
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(at),
        expiresAt: null,
        providerEventAt: new Date(at),
        payload: { transactionId: `t-${sku}` },
      },
      {
        config: PAYMENTS_CATALOG,
        environment: "production",
        now: new Date(at),
      },
    );
  }
}

/** The same catalog the backend composes, parsed once for the seeding writer. */
const PAYMENTS_CATALOG = payments({
  basePath: BASE_PATH,
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
}).paymentsConfig;

beforeEach(async () => {
  for (const table of [
    "pithy_payments_webhook_events",
    "pithy_payments_reconcile_runs",
    "pithy_payments_sync_cursors",
    "pithy_payments_provider_accounts",
    "pithy_payments_entitlements",
    "pithy_payments_purchases",
    "pithy_controlplane_connections",
    "pithy_controlplane_replays",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await payments_0001_purchases.up(db);
});

describe("what a management client discovers about payments", () => {
  test("the manifest names every read, at the base path this project actually mounted", async () => {
    await connect([MANIFEST_READ_SCOPE]);
    const routes = paymentsRoutes(await manifest());
    expect(routes.filter((route) => route.method === "GET").map((route) => route.path)).toEqual([
      "/billing/admin/catalog",
      "/billing/admin/purchases",
      "/billing/admin/subscriptions",
      "/billing/admin/entitlements",
      "/billing/admin/entitlements/:userId",
      "/billing/admin/discounts",
      "/billing/admin/reconcile-runs",
    ]);
  });

  test("a comp control discovers the catalog read and calls it from the manifest alone (#300)", async () => {
    // The shape of #300, as the same difference between two words #247 was about. Before this read, a
    // control offering "comp this person an entitlement" found nothing in the manifest to populate a list
    // from and could only render a text box beside a free-text key. Now it discovers the route, learns
    // which scope it needs, and gets the keys — without concatenating a path or assuming a base.
    await connect([MANIFEST_READ_SCOPE, PAYMENTS_CATALOG_READ_SCOPE]);
    const route = collection(paymentsRoutes(await manifest()), "catalog");
    expect(route?.path).toBe("/billing/admin/catalog");
    expect(route?.scope).toBe(PAYMENTS_CATALOG_READ_SCOPE);

    const body = PaymentsAdminCatalogResponse.parse(await (await get(route?.path ?? "", route?.scope ?? "")).json());
    expect(body.enabled && body.products.map((product) => product.id)).toEqual(["pro_monthly", "coins_100"]);
    expect(body.enabled && body.products.flatMap((product) => product.entitlements)).toEqual(["pro", "coins"]);
    // The keys are the point: they are what a grant names, and what the grant route now checks against.
    expect(await (await get("/billing/admin/purchases", PAYMENTS_CATALOG_READ_SCOPE)).status).toBe(403);
  });

  test("without the read scopes the panes are blocked, not absent", async () => {
    // The whole of #247, as a difference between two words. `absent` says their Worker has no such
    // surface, so a client renders nothing and offers the adopter nothing to do. `blocked` says the
    // surface exists and this credential was not granted it, which is a sentence an adopter can act on.
    await connect([MANIFEST_READ_SCOPE]);
    const reported = await manifest();
    for (const pane of PANES) expect(paneAccess(reported, pane), pane).toBe("blocked");
  });

  test("with them granted, every pane is ready and its scope is the one it will be refused for", async () => {
    await connect([
      MANIFEST_READ_SCOPE,
      PAYMENTS_PURCHASES_READ_SCOPE,
      PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    ]);
    const reported = await manifest();
    for (const pane of PANES) expect(paneAccess(reported, pane), pane).toBe("ready");
    expect(collection(paymentsRoutes(reported), "purchases")?.scope).toBe(PAYMENTS_PURCHASES_READ_SCOPE);
    expect(collection(paymentsRoutes(reported), "subscriptions")?.scope).toBe(PAYMENTS_SUBSCRIPTIONS_READ_SCOPE);
    expect(collection(paymentsRoutes(reported), "entitlements")?.scope).toBe(PAYMENTS_ENTITLEMENTS_READ_SCOPE);
  });

  test("the three panes populate, called at the addresses and scopes the manifest gave", async () => {
    // The acceptance criterion, executed. Nothing below names a path or a scope: both come from the
    // manifest, which is the claim discovery makes and the only way to prove it holds.
    await connect([
      MANIFEST_READ_SCOPE,
      PAYMENTS_PURCHASES_READ_SCOPE,
      PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
    ]);
    await seed();
    const routes = paymentsRoutes(await manifest());

    const purchases = collection(routes, "purchases");
    const purchasesBody = PaymentsAdminPurchasesResponse.parse(
      await (await get(purchases?.path ?? "", purchases?.scope ?? "")).json(),
    );
    expect(purchasesBody.purchases.map((p) => p.productId)).toEqual(["coins_100", "pro_monthly"]);

    const subscriptions = collection(routes, "subscriptions");
    const subscriptionsBody = PaymentsAdminSubscriptionsResponse.parse(
      await (await get(subscriptions?.path ?? "", subscriptions?.scope ?? "")).json(),
    );
    expect(subscriptionsBody.subscriptions.map((s) => s.productId)).toEqual(["pro_monthly"]);

    const entitlements = collection(routes, "entitlements");
    const entitlementsBody = PaymentsAdminEntitlementsResponse.parse(
      await (await get(entitlements?.path ?? "", entitlements?.scope ?? "")).json(),
    );
    expect(entitlementsBody.entitlements.map((e) => e.key).sort()).toEqual(["coins", "pro"]);
  });

  test("a Worker nobody has connected answers nothing, however good the token looks", async () => {
    // No `connect()`. The seam denies before a capability's handler is reached, which is what makes the
    // reads default-denied rather than merely scoped.
    const response = await get("/billing/admin/purchases", PAYMENTS_PURCHASES_READ_SCOPE);
    expect(response.status).toBe(403);
  });

  test("a granted read cannot be spent on a route it was not minted for", async () => {
    // The token binds one scope. Holding every read still means one call, one operation.
    await connect([MANIFEST_READ_SCOPE, PAYMENTS_PURCHASES_READ_SCOPE, PAYMENTS_ENTITLEMENTS_READ_SCOPE]);
    const response = await get("/billing/admin/entitlements", PAYMENTS_PURCHASES_READ_SCOPE);
    expect(response.status).toBe(403);
  });
});
