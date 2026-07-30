import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
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
 * Every payments path is literal, on purpose: the three webhook rails are three routes rather than one `:rail`
 * because each proves authenticity by a different mechanism, and the rail a caller *claims* is not something to
 * route on. So the expected param set is empty, and the count assertion below is what keeps this gate from
 * passing vacuously — the moment a `:segment` appears, the test above starts doing work.
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
    // Every route this build serves — the full ten from issue #79. The list is what makes adding an eleventh
    // a deliberate edit rather than a surprise, and it is the only place a route can be counted.
    expect(paths).toEqual([
      "/payments/checkout",
      "/payments/entitlements",
      "/payments/entitlements/grant",
      "/payments/entitlements/revoke",
      "/payments/portal",
      "/payments/purchases",
      "/payments/restore",
      "/payments/webhooks/apple",
      "/payments/webhooks/google",
      "/payments/webhooks/stripe",
    ]);
    expect(paramPaths(app)).toEqual([]);
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
