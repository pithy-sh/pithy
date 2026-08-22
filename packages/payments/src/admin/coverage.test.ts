// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { describe, expect, test } from "vitest";
import { payments } from "../capability";
import { paymentsTables } from "../data/tables";
import { PAYMENTS_CONTROL_PLANE_SCOPES } from "../http/scopes";
import { PAYMENTS_TABLE_DISCLOSURE } from "./coverage";

/**
 * The invariant: **a management client can read every record payments keeps for a customer, and can read
 * back anything it is allowed to change.**
 *
 * This is the gate for issue #247, and it is stated as a property rather than as a list of routes
 * somebody must remember to add. Payments shipped `entitlements/grant` and `entitlements/revoke` — a
 * console that could comp an entitlement and revoke one, and could never list one — and three panes in
 * the first adopter computed `absent` and dropped out of the rail. Nothing failed. No test asked the
 * question, so no test could answer it.
 *
 * Two halves, and each catches a different way of getting there:
 *
 * 1. **Stored implies decided.** Every table payments owns carries a disclosure decision beside the
 *    table map — a read scope, or a stated reason it is withheld — and `Record<keyof PaymentsTables, …>`
 *    means a fifth table does not compile until somebody decides. A table declared readable must have a
 *    control-plane `GET` demanding exactly that scope.
 * 2. **Write implies read.** Every resource the control-plane surface can write, it can also read. This
 *    is the shape of the #247 defect precisely: two writes on `entitlements`, no read.
 *
 * The reads are also checked the way a management client actually finds them — a `GET`, with a declared
 * scope, no `:` segment, mounted at a path ending in the resource — because that, not the fact that some
 * route exists somewhere, is what decides whether a pane renders or vanishes.
 */

/**
 * The smallest catalog `payments()` will parse. The admin surface does not depend on what is sold.
 *
 * `billingSubject` is required and has no default, so it is here rather than absent: what a project bills
 * is a decision, and a config that could omit it would decide by accident. Which value it takes does not
 * matter to a disclosure decision — a table is readable or withheld whoever holds its rows.
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

/** The advertised admin surface of a composed capability — what `GET /control-plane/manifest` reports. */
function advertised(basePath?: string): AdminRoute[] {
  const capability = payments({ ...CATALOG, ...(basePath === undefined ? {} : { basePath }) });
  return [...(capability.adminRoutes ?? [])];
}

/**
 * The collection route a management client would pick for a resource, by the rule it actually uses.
 *
 * A `GET`, because a pane reads. **A declared scope**, because a token binds exactly one scope and a
 * route naming none cannot be spent through. **No `:` segment**, because a route with a hole in it
 * cannot be called until something has already been chosen, so it can never be the thing that lists the
 * set. And the path ends in the resource, because the mount point moves and the noun does not.
 */
function collection(routes: readonly AdminRoute[], resource: string): AdminRoute | undefined {
  return routes.find(
    (route) =>
      route.method === "GET" &&
      route.scope !== null &&
      !route.path.includes(":") &&
      route.path.endsWith(`/${resource}`),
  );
}

/**
 * The resource an admin route is about — the last segment that names a noun rather than a verb.
 *
 * A read is `…/entitlements`, where the noun is last. A write takes one of two shapes, and both are in the
 * table: `…/entitlements/grant` names the verb last because one noun carries two operations, and
 * `…/discounts` posts to the collection because it carries one. So a write's noun is the last segment when
 * that is a collection somebody can read, and the segment before it otherwise.
 *
 * Deliberately not "whichever segment happens to have a read". The fallback is the *convention* — a write
 * on a noun nothing reads still resolves to that noun and is still reported, which is the whole point of
 * the gate.
 */
function resourceOf(route: AdminRoute, routes: readonly AdminRoute[] = []): string {
  const segments = route.path.split("/").filter((segment) => segment.length > 0 && !segment.startsWith(":"));
  const last = segments[segments.length - 1] ?? "";
  if (route.method === "GET") return last;
  // A POST straight at a readable collection is a create on that collection.
  if (collection(routes, last) !== undefined) return last;
  return segments[segments.length - 2] ?? last;
}

describe("payments' control-plane read coverage (#247)", () => {
  test("every resource a management client can write, it can also read", () => {
    const routes = advertised();
    const written = new Set(routes.filter((route) => route.method !== "GET").map((route) => resourceOf(route, routes)));
    const missing = [...written].filter((resource) => collection(routes, resource) === undefined);
    expect(
      missing,
      `payments advertises a control-plane write on ${missing.join(", ")} and no read. A management client cannot see what it just changed, and a pane over that resource computes absent rather than blocked — which no grant and no seed can repair. Add a GET with its own read scope.`,
    ).toEqual([]);
  });

  test("every table payments stores is either readable through a declared scope or withheld for a stated reason", () => {
    // `Record<keyof PaymentsTables, …>` is the structural half: a fifth table does not typecheck until it
    // is decided. This is the half that checks the decision was honored — a table declaring a scope with
    // no route behind it is a promise nothing keeps.
    const routes = advertised();
    const scopes = new Set(routes.filter((route) => route.method === "GET").map((route) => route.scope));
    const broken = Object.entries(PAYMENTS_TABLE_DISCLOSURE).flatMap(([table, disclosure]) =>
      "reads" in disclosure ? disclosure.reads.filter((scope) => !scopes.has(scope)).map((s) => `${table} → ${s}`) : [],
    );
    expect(
      broken,
      `These tables declare a control-plane read that no advertised GET demands:\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the disclosure map covers the tables payments actually creates, and nothing else", () => {
    // Keeps the gate from passing because a table was quietly dropped from one map and not the other.
    expect(Object.keys(PAYMENTS_TABLE_DISCLOSURE).sort()).toEqual(Object.keys(paymentsTables()).sort());
  });

  test("every scope a table declares is one payments publishes for an adopter to grant", () => {
    // The scopes are the join key with what `pithy dashboard connect` offers. A read gated on a string
    // that list does not carry is a route nobody can ever be granted.
    const published = new Set(PAYMENTS_CONTROL_PLANE_SCOPES);
    const orphans = Object.values(PAYMENTS_TABLE_DISCLOSURE).flatMap((disclosure) =>
      "reads" in disclosure ? disclosure.reads.filter((scope) => !published.has(scope)) : [],
    );
    expect(orphans).toEqual([]);
  });

  test("the three panes the first adopter needs resolve to a route, wherever payments is mounted", () => {
    // The literal reproduction from #247. Purchases, Entitlements and Subscriptions computed `absent`
    // against a live manifest — not blocked, not refused, absent — and dropped out of the rail. A moved
    // base path is checked in the same breath because that is the case describing routes exists for.
    for (const base of ["/payments", "/billing"]) {
      const routes = advertised(base === "/payments" ? undefined : base);
      for (const resource of ["purchases", "entitlements", "subscriptions"]) {
        const route = collection(routes, resource);
        expect(route?.path, `no control-plane read for ${resource} under ${base}`).toBe(`${base}/admin/${resource}`);
      }
    }
  });

  test("the read scopes are the ones the first adopter's panes ask for", () => {
    // Named literally, because a scope is a join key with a customer's grant: renaming one silently
    // un-grants every connection that already holds it.
    const routes = advertised();
    expect(collection(routes, "purchases")?.scope).toBe("payments:purchases:read");
    expect(collection(routes, "entitlements")?.scope).toBe("payments:entitlements:read");
    expect(collection(routes, "subscriptions")?.scope).toBe("payments:subscriptions:read");
  });
});
