// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import * as z from "zod";
import { payments } from "../capability";
import { PaymentsConfig } from "../config/config";
import * as responses from "./responses";
import { PaymentsPricingEnvelope, PaymentsSubscriptionResponse } from "./responses";
import { registerPaymentsRoutes } from "./routes";
import * as schemas from "./schemas";
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
  PAYMENTS_RECONCILE_RUN_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./scopes";

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
 * mechanism, and the rail a caller *claims* is not something to route on. The one route with `:segment`s is
 * `admin/entitlements/:subjectType/:subjectId`, and it carries **two** — a holder is a pair, and a route
 * addressed by the id alone would answer about whichever of a user and an organization happened to share it.
 * Both need a validator, which is what makes the gate above do real work rather than pass vacuously, and the
 * path list below is what keeps a third from appearing unnoticed.
 */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerPaymentsRoutes({
    config: PaymentsConfig.parse({
      // Required, and every fixture in this file states it: `PaymentsConfig` refuses to parse without it,
      // because who a purchase belongs to is not a thing a project may leave to a default.
      billingSubject: "user",
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

/**
 * Every distinct route the app mounted, as `METHOD /path`.
 *
 * The method is half the identity of a route and dropping it is what let the pin below be satisfied by a
 * surface it no longer described. Hono records one entry per handler, so the set is over the pair.
 */
function mountedRoutes(app: Hono<PithyHonoEnv>): string[] {
  return [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort();
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
    // Every route this build serves — the ten from issue #79, the four management reads from #247, the
    // catalog read from #300, Paddle's webhook, and the six subscription-lifecycle routes from #465. The
    // list is what makes adding a twenty-eighth a deliberate edit rather than a surprise, and it is the
    // only place a route can be counted.
    //
    // **`refund` is the sixth and it is a bearer route**, not a control-plane one. That is worth pinning:
    // a verb that moves money back reads as an operator's, and mounting it behind `requireControlPlane`
    // would put a customer's own refund out of their reach while widening a dashboard credential to reach
    // every account's money. It is the subscriber's own subscription, resolved from their own rows.
    //
    // **The read is first in the lifecycle set and that ordering is load-bearing**, not alphabetical
    // accident: `GET /payments/subscription` shipped before any of the four verbs beside it, because a
    // capability that can cancel a subscription and cannot report the cancellation ships the half that
    // creates the support ticket. #247 is the larger version of the same mistake, and it is recorded at
    // the top of `routes.ts`.
    //
    // **Method and path, so an extra method on a declared path is caught** — email's phrasing, because
    // it is the same rule. Pinned by path alone, `POST /payments/admin/purchases` mounted beside the
    // read was a write nobody declared, nobody reviewed and this file could not see: its path was
    // already in the set, and a set does not count. `/payments/admin/discounts` is the proof the
    // distinction is live rather than hypothetical — it is one path serving both a GET and a POST, so
    // the two spellings of this list genuinely differ.
    expect(mountedRoutes(app)).toEqual([
      "GET /payments/admin/catalog",
      "GET /payments/admin/discounts",
      "GET /payments/admin/entitlements",
      "GET /payments/admin/entitlements/:subjectType/:subjectId",
      "GET /payments/admin/purchases",
      "GET /payments/admin/reconcile-runs",
      "GET /payments/admin/subscriptions",
      "GET /payments/entitlements",
      "GET /payments/pricing",
      "GET /payments/subscription",
      "POST /payments/admin/discounts",
      "POST /payments/admin/reconcile-runs",
      "POST /payments/checkout",
      "POST /payments/entitlements/grant",
      "POST /payments/entitlements/revoke",
      "POST /payments/portal",
      "POST /payments/purchases",
      "POST /payments/restore",
      "POST /payments/subscription/cancel",
      "POST /payments/subscription/change",
      "POST /payments/subscription/keep",
      "POST /payments/subscription/preview",
      "POST /payments/subscription/refund",
      "POST /payments/webhooks/apple",
      "POST /payments/webhooks/google",
      "POST /payments/webhooks/lemon-squeezy",
      "POST /payments/webhooks/paddle",
      "POST /payments/webhooks/stripe",
    ]);
    // One route with `:segment`s — two of them, the pair a holder is — which is what makes the param gate
    // above do work rather than pass vacuously.
    expect(paramPaths(app)).toEqual(["/payments/admin/entitlements/:subjectType/:subjectId"]);
  });

  test("mounts under the configured basePath, webhooks included", () => {
    // The webhook URLs an operator registers in a store console are derived from this, so a basePath that only
    // moved some of the routes would be a silently half-broken deployment.
    const app = new Hono<PithyHonoEnv>();
    registerPaymentsRoutes({ config: PaymentsConfig.parse({ billingSubject: "user", basePath: "/billing" }) })(app);
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

  /**
   * The response envelopes the README describes field by field, and the schema each is held against.
   *
   * **A frozen literal, and it is a short list on purpose.** The Routes table checked the method and the
   * path, so the row for `GET /payments/pricing` stayed true while its response grew `quotedFrom` — a
   * field a real adopter then built a quote seam on, undescribed on both sides (#347). A gate that passes
   * the change it exists to catch is the class #326 tracks, so this is the half that was missing: every
   * top-level field of a documented envelope has to be named in the README, and adding one is a failing
   * build until it is.
   *
   * **Why not every route.** The other twenty are webhooks, whose bodies belong to a store, and management
   * reads whose consumer is `GET /control-plane/manifest` rather than a person reading this file — and a
   * README that listed every field of every admin page would be a second, worse copy of the schemas, which
   * is the documentation this repository deliberately does not write. The line is: a response a **browser**
   * reads field by field is described here. Moving that line is an edit to this list, with a reason.
   */
  const DOCUMENTED_RESPONSES: Readonly<Record<string, z.ZodObject>> = {
    "GET /payments/pricing": PaymentsPricingEnvelope,
    // Added with the route (#465), rather than after somebody built a seam on an undescribed field. It is
    // squarely on the line this list draws: a browser reads it field by field, and one of those fields —
    // `nextEvent` — exists precisely because the obvious reading of the others is wrong.
    "GET /payments/subscription": PaymentsSubscriptionResponse,
  };

  /** Every field a response carries, one level into the objects nested directly on it. */
  function fields(schema: z.ZodObject): string[] {
    return Object.entries(schema.shape).flatMap(([name, value]) => {
      const inner = value instanceof z.ZodNullable ? value.unwrap() : value;
      return inner instanceof z.ZodObject ? [name, ...Object.keys(inner.shape)] : [name];
    });
  }

  test("the field sweep reads real schemas, so the assertion below is not vacuous", () => {
    // Anti-vacuous, and specific: an introspection that silently returned nothing would pass every
    // envelope. Both nullable objects are descended into, which is what the nested names prove.
    expect(fields(PaymentsPricingEnvelope)).toEqual([
      "pricing",
      "currency",
      "currentAmountMinor",
      "listAmountMinor",
      "discountCode",
      "discountEndsAt",
      "quotedFrom",
      "rail",
      "providerAccountId",
    ]);
  });

  test("names every field of every response envelope it documents", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    for (const [route, schema] of Object.entries(DOCUMENTED_RESPONSES)) {
      const undescribed = fields(schema).filter((field) => !readme.includes(`\`${field}\``));
      expect(
        undescribed,
        `The response to ${route} carries fields packages/payments/README.md never names. A row that says only the method and the path stays true while the envelope under it changes, which is exactly how \`quotedFrom\` shipped undescribed (#347):\n${undescribed.map((field) => `  ${field}`).join("\n")}`,
      ).toEqual([]);
    }
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
    billingSubject: "user" as const,
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
    expect(capability.adminRoutes).toHaveLength(11);
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
      "/billing/admin/entitlements/:subjectType/:subjectId",
      "/billing/admin/discounts",
      "/billing/admin/discounts",
      "/billing/admin/reconcile-runs",
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
      PAYMENTS_RECONCILE_RUN_SCOPE,
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

/**
 * The subject never crosses a player-facing surface — asserted as a property, over every schema this
 * capability declares rather than route by route.
 *
 * **This is the security core of subject billing, and it is a property because a review is not.** A body,
 * a query or a path segment that could name a holder lets any signed-in caller read or write against one
 * they have no membership of, and payments has nothing to check that claim against: it has no members
 * table, by design. The server resolves the holder — the authenticated caller under `billingSubject:
 * "user"`, and under `"organization"` whatever the adopter's own resolver answers from its own session.
 *
 * The mirror half matters as much and is easier to lose. A *response* that published a subject teaches a
 * client the id space and the spelling, and the field a client can read is the field somebody eventually
 * sends back. So neither direction is permitted, and both are checked here in one sweep.
 *
 * **The permitted list is a frozen literal.** Every entry is a control-plane surface, where naming another
 * holder *is* the feature — support acting on somebody else's account, behind a default-denied scoped
 * credential, audited on every write. Adding a name here is a deliberate edit in a test, beside the
 * sentence saying why, which is the same shape the disclosure sweeps in `controlPlane.workers.test.ts`
 * take and for the same reason: a gate derived from what it polices cannot fail when what it polices
 * changes.
 */
describe("no player-facing surface names a subject", () => {
  /** The two field names that address a holder. Both, because half a subject is a different holder. */
  const SUBJECT_FIELDS = ["subjectType", "subjectId"];

  /**
   * The surfaces permitted to name one. Control-plane, every one of them: the two entitlement writes, the
   * three listing filters, the per-subject read's path segments, and the management views those reads
   * return. Nothing a browser or a mobile client calls is on this list, and nothing may be added to it
   * without moving the sentence above.
   */
  const NAMES_A_SUBJECT = [
    "EntitlementGrantRequest",
    "EntitlementRevokeRequest",
    "AdminPurchasesQuery",
    "AdminSubscriptionsQuery",
    "AdminEntitlementsQuery",
    "AdminSubjectParam",
    "PaymentsAdminPurchaseView",
    "PaymentsAdminEntitlementView",
    "PaymentsAdminPurchasesResponse",
    "PaymentsAdminSubscriptionsResponse",
    "PaymentsAdminEntitlementsResponse",
    "PaymentsAdminSubjectEntitlementsResponse",
  ];

  /**
   * Every key a schema declares, at any depth.
   *
   * Descends objects, arrays, unions and the optional/nullable/default wrappers, because a subject that
   * arrived inside an array of one or on the second member of a union would be exactly as reachable as one
   * on the top level — and rather more likely to be missed by a reader. The `seen` set is what keeps a
   * self-referential schema from spinning.
   */
  function keysIn(schema: z.ZodType, seen: Set<z.ZodType> = new Set()): string[] {
    if (seen.has(schema)) return [];
    seen.add(schema);
    if (schema instanceof z.ZodObject) {
      return Object.entries(schema.shape).flatMap(([key, value]) => [key, ...keysIn(value as z.ZodType, seen)]);
    }
    if (schema instanceof z.ZodArray) return keysIn(schema.element as z.ZodType, seen);
    if (schema instanceof z.ZodUnion) return schema.options.flatMap((option) => keysIn(option as z.ZodType, seen));
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
      return keysIn(schema.unwrap() as z.ZodType, seen);
    }
    return [];
  }

  /** Every Zod object this capability's request and response modules export, by the name it exports it as. */
  function declared(): [string, z.ZodType][] {
    const exported: [string, unknown][] = [...Object.entries(schemas), ...Object.entries(responses)];
    return exported.flatMap(([name, value]) =>
      value instanceof z.ZodType ? [[name, value] as [string, z.ZodType]] : [],
    );
  }

  test("the sweep is reading real schemas, so the assertion below is not vacuous", () => {
    // An introspection that silently found nothing would clear every surface at once.
    const found = declared();
    expect(found.length).toBeGreaterThan(20);
    expect(keysIn(schemas.PurchaseSubmission)).toEqual(["rail", "receipt"]);
    // And it genuinely descends: the subject on a management *view* is a level inside its envelope.
    expect(keysIn(responses.PaymentsAdminEntitlementsResponse)).toContain("subjectId");
  });

  test("only the control-plane surfaces name one", () => {
    const offenders = declared()
      .filter(([name]) => !NAMES_A_SUBJECT.includes(name))
      .filter(([, schema]) => keysIn(schema).some((key) => SUBJECT_FIELDS.includes(key)))
      .map(([name]) => name);
    expect(
      offenders,
      `These name a subject and are not control-plane surfaces. A request that names a holder lets any signed-in caller act against one they have no membership of; a response that publishes one teaches a client the id space it would send back:\n${offenders
        .map((name) => `  ${name}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("nothing on the permitted list is there without needing to be", () => {
    // The other direction, so a surface that stops naming a subject does not leave a permission behind it —
    // slack on a list like this is what silently absolves the next field to arrive.
    const exported = new Map(declared());
    for (const name of NAMES_A_SUBJECT) {
      const schema = exported.get(name);
      expect(schema, `${name} is permitted to name a subject and is not exported at all`).toBeDefined();
      expect(
        schema === undefined ? [] : keysIn(schema).filter((key) => SUBJECT_FIELDS.includes(key)),
        `${name} is permitted to name a subject and names none`,
      ).not.toEqual([]);
    }
  });
});
