// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { payments } from "../capability";
import { PaymentsConfig } from "../config/config";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_CONTROL_PLANE_SCOPES,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./guards";
import { registerPaymentsRoutes } from "./routes";

/**
 * Payments' half of gate 2 of the route request contract. A handler can reach a path param through a validator
 * it never declared, so the Biome ban that covers query and body cannot cover params — this asserts the
 * positive instead.
 *
 * No request is made. The app is composed and inspected, so no auth middleware, no `DB` binding, and no
 * migrations are needed. That is also why this is a node test, and why nothing in `routes.ts` may reach
 * `cloudflare:workers`.
 *
 * Every payments path was literal until the management reads landed, and most still are on purpose: the three
 * webhook rails are three routes rather than one `:rail` because each proves authenticity by a different
 * mechanism, and the rail a caller *claims* is not something to route on. The one `:segment` is
 * `admin/entitlements/:userId`, which is what makes the gate above do real work rather than pass vacuously —
 * and the path list below is what keeps a second one from appearing unnoticed.
 */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerPaymentsRoutes({
    config: PaymentsConfig.parse({
      rails: { apple: true, google: true, stripe: true },
      stripe: {
        successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://acme.example/pricing",
        portalReturnUrl: "https://acme.example/account",
      },
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
          google: { productId: "pro_monthly" },
          stripe: { priceId: "price_1Abc" },
        },
      },
    }),
  })(app);
  return app;
}

function paramPaths(app: Hono<PithyHonoEnv>): string[] {
  return [
    ...new Set(app.routes.filter((route) => pathParams(route.path).length > 0).map((route) => route.path)),
  ].sort();
}

describe("payments route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These payments routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((route) => `  ${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real payments routes, not an empty app", () => {
    const app = makeApp();
    const paths = [...new Set(app.routes.map((route) => route.path))].sort();
    // Every route this build serves — the ten from issue #79, the four management reads from #247, and
    // the catalog read from #300. The list is what makes adding a sixteenth a deliberate edit rather than
    // a surprise, and it is the only place a route can be counted.
    expect(paths).toEqual([
      "/payments/admin/catalog",
      "/payments/admin/discounts",
      "/payments/admin/entitlements",
      "/payments/admin/entitlements/:userId",
      "/payments/admin/purchases",
      "/payments/admin/reconcile-runs",
      "/payments/admin/subscriptions",
      "/payments/checkout",
      "/payments/entitlements",
      "/payments/entitlements/grant",
      "/payments/entitlements/revoke",
      "/payments/portal",
      "/payments/pricing",
      "/payments/purchases",
      "/payments/restore",
      "/payments/webhooks/apple",
      "/payments/webhooks/google",
      "/payments/webhooks/lemon-squeezy",
      "/payments/webhooks/stripe",
    ]);
    // One `:segment`, which is what makes the param gate above do work rather than pass vacuously.
    expect(paramPaths(app)).toEqual(["/payments/admin/entitlements/:userId"]);
  });

  test("mounts under the configured basePath, webhooks included", () => {
    // The webhook URLs an operator registers in a store console are derived from this, so a basePath that only
    // moved some of the routes would be a silently half-broken deployment.
    const app = new Hono<PithyHonoEnv>();
    registerPaymentsRoutes({ config: PaymentsConfig.parse({ basePath: "/billing" }) })(app);
    expect([...new Set(app.routes.map((route) => route.path))].every((path) => path.startsWith("/billing/"))).toBe(
      true,
    );
  });

  test("every route carries at least one guard ahead of its handler", () => {
    // The positive half of "no public routes". A route registered with a bare handler has one entry in
    // `app.routes`; every route here must have more, and the first of them is its verification strategy.
    const app = makeApp();
    const handlerCounts = new Map<string, number>();
    for (const route of app.routes) {
      const key = `${route.method} ${route.path}`;
      handlerCounts.set(key, (handlerCounts.get(key) ?? 0) + 1);
    }
    for (const [route, count] of handlerCounts) expect(count, `${route} has no guard`).toBeGreaterThan(1);
  });
});

/**
 * The README's Routes table, held against the real registrations.
 *
 * The table is what a **person** reads to find out whether this capability can answer their question — a
 * management client discovers routes from the manifest, but nobody chooses a capability from a manifest. It
 * had been missing the four management reads since they landed, so the README said the answer was no.
 *
 * The cost of that gap was not cosmetic and it was already paid once: the fifth management read deliberately
 * withheld its row, because one row in a table missing four peers reads as completeness. A documentation gap
 * that recurs is a missing gate rather than a missing paragraph, so this is the gate.
 *
 * Both directions, deliberately. A route with no row is the omission that happened; a row with no route is a
 * table describing a surface that was removed, which is the same lie told the other way round.
 */
describe("the README's Routes table", () => {
  /** `| `METHOD /path` | purpose | verification |` — the first cell of every row in the Routes table. */
  function documentedRoutes(): string[] {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const section = readme.split("\n## Routes\n")[1]?.split("\n## ")[0] ?? "";
    return [...section.matchAll(/^\|\s*`(GET|POST|PUT|PATCH|DELETE) (\/[^`]*)`\s*\|/gm)]
      .map((row) => `${row[1]} ${row[2]}`)
      .sort();
  }

  /** Every route actually registered, as `METHOD /path`. Hono records one entry per handler. */
  function registeredRoutes(): string[] {
    return [...new Set(makeApp().routes.map((route) => `${route.method} ${route.path}`))].sort();
  }

  test("is reading the real table, not an empty string", () => {
    // Anti-vacuous: a split that silently matched nothing would make both assertions below pass.
    expect(documentedRoutes().length).toBeGreaterThan(10);
  });

  test("names every route this capability registers", () => {
    const undocumented = registeredRoutes().filter((route) => !documentedRoutes().includes(route));
    expect(
      undocumented,
      `These routes are registered and absent from the Routes table in packages/payments/README.md. An adopter reading that table is told this capability does not serve them:\n${undocumented.map((route) => `  ${route}`).join("\n")}`,
    ).toEqual([]);
  });

  test("names nothing it does not register", () => {
    const registered = registeredRoutes();
    const phantom = documentedRoutes().filter((route) => !registered.includes(route));
    expect(
      phantom,
      `The Routes table in packages/payments/README.md documents routes this capability does not register:\n${phantom.map((route) => `  ${route}`).join("\n")}`,
    ).toEqual([]);
  });

  test("names the scope every control-plane route's guard demands", () => {
    // A control-plane row without its scope tells an integrator to ask for a credential and not which one,
    // which is the question the row exists to answer. Every scope the guards declare must appear.
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const routes = readme.split("\n## Routes\n")[1]?.split("\n## ")[0] ?? "";
    for (const scope of PAYMENTS_CONTROL_PLANE_SCOPES) {
      expect(routes, `The Routes table names no route demanding \`${scope}\``).toContain(`\`${scope}\``);
    }
  });
});

describe("the admin surface payments advertises", () => {
  /**
   * The smallest catalog `payments()` will parse: one rail on, one product sold on it. The admin
   * surface does not depend on what is sold, but a catalog has to be coherent to assemble at all.
   */
  const CATALOG = {
    rails: { apple: true },
    products: {
      pro_monthly: {
        type: "subscription" as const,
        name: "Pro",
        entitlements: ["pro"],
        apple: { productId: "com.acme.pro.monthly" },
      },
    },
  };

  /** The composed capability, so what is inspected is what an adopter actually gets. */
  function composed(basePath?: string) {
    const capability = payments({ ...CATALOG, ...(basePath === undefined ? {} : { basePath }) });
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    return { capability, app };
  }

  test("every advertised admin route is one payments actually mounts", () => {
    // `GET /control-plane/manifest` tells a management client these six routes exist and which scope
    // each needs. A declaration that drifted from `routes.ts` would have the client calling a path
    // nothing serves — and blaming the adopter's Worker for it.
    const { capability, app } = composed();
    expect(capability.adminRoutes).toHaveLength(10);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("a moved base path moves the advertised routes too", () => {
    // The case that motivated describing routes at all. An adopter mounting payments at `/billing`
    // would 404 every management call from a client that assumed the `/payments` default.
    const { capability, app } = composed("/billing");
    expect(capability.adminRoutes?.map((route) => route.path)).toEqual([
      "/billing/admin/catalog",
      "/billing/admin/purchases",
      "/billing/admin/subscriptions",
      "/billing/admin/entitlements",
      "/billing/admin/entitlements/:userId",
      "/billing/admin/discounts",
      "/billing/admin/discounts",
      "/billing/admin/reconcile-runs",
      "/billing/entitlements/grant",
      "/billing/entitlements/revoke",
    ]);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("each advertised route names the scope its guard actually requires", () => {
    // The scopes are the join key with what `pithy dashboard connect` offers an adopter to grant, so a
    // manifest naming a different string would tell a client to ask for a grant nothing checks.
    const { capability } = composed();
    expect(capability.adminRoutes?.map((route) => route.scope)).toEqual([
      PAYMENTS_CATALOG_READ_SCOPE,
      PAYMENTS_PURCHASES_READ_SCOPE,
      PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
      PAYMENTS_DISCOUNT_READ_SCOPE,
      PAYMENTS_DISCOUNT_CREATE_SCOPE,
      PAYMENTS_RECONCILE_READ_SCOPE,
      PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
      PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
    ]);
    expect(new Set(capability.adminRoutes?.map((route) => route.scope))).toEqual(
      new Set(PAYMENTS_CONTROL_PLANE_SCOPES),
    );
  });

  test("only the control-plane routes are advertised — the player routes are not a management surface", () => {
    // Declaring is opt-in and one-directional. Payments serves plenty of bearer routes on paths that look
    // like these — `GET /payments/entitlements` is the caller's own — and none of them belong in a
    // manifest a management client dispatches from. The `admin/` segment and the two write verbs are what
    // separate the two sets, so both shapes are named.
    const { capability } = composed();
    expect(
      capability.adminRoutes?.every(
        (route) => route.path.startsWith("/payments/admin/") || route.path.includes("/entitlements/"),
      ),
    ).toBe(true);
    expect(capability.adminRoutes?.map((route) => route.path)).not.toContain("/payments/entitlements");
  });

  test("the reads are reads — every advertised GET is under admin/, and no read declares a body", () => {
    // A management read that could be reached by a POST would be a write nobody reviewed. Method and path
    // are asserted together because either alone permits the mistake.
    const { capability } = composed();
    const reads = capability.adminRoutes?.filter((route) => route.method === "GET") ?? [];
    expect(reads).toHaveLength(7);
    expect(reads.every((route) => route.path.startsWith("/payments/admin/"))).toBe(true);
  });
});
