// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { ledger } from "../capability";
import { LedgerConfig } from "../config/config";
import {
  LEDGER_ACCOUNTS_READ_SCOPE,
  LEDGER_CONTROL_PLANE_SCOPES,
  LEDGER_TRANSACTIONS_READ_SCOPE,
  ledgerAdminRoutes,
} from "./guards";
import { LEDGER_ROUTES, registerLedgerRoutes } from "./routes";

/**
 * The ledger's half of gate 2 of the route request contract (issue #74), plus the management surface's
 * own gate. The Biome GritQL plugin is gate one — it bans the raw accessors, so `c.req.valid()` is the
 * only way to reach a query or a body. Params have no accessor to ban, so they need this positive check.
 *
 * The app is composed the way `createBackend` composes it: the error handler installed and the request
 * variables seeded. A bare Hono app would answer 500 where production answers 403 and would crash where
 * production audits a denial, and a gate that asserts against a different app than the one that ships is
 * not a gate.
 *
 * `controlPlaneVerifier` is seeded **null**, which is the state of a Worker that never composed
 * `controlplane()` — exactly the state the seam is meant to deny in, and therefore the one worth testing.
 */

const CONFIG = LedgerConfig.parse({ currencies: [{ code: "chips", name: "Chips" }] });

function makeApp(basePath?: string) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    await next();
  });
  registerLedgerRoutes({ config: CONFIG, basePath })(app);
  return app;
}

/**
 * Every route Hono actually mounted, method included and middleware excluded.
 *
 * `app.routes` lists middleware too, as `ALL` on the pattern it was registered against — the
 * `app.use("*")` above is one. Those are not routes and have nothing to declare, so they are filtered
 * out by method rather than by path: filtering by a `/ledger/` prefix would also silently drop a route
 * mounted under a prefix somebody typed wrong, which is precisely the drift this exists to catch.
 */
function realRoutes(app: Hono<PithyHonoEnv>): { method: string; path: string }[] {
  return app.routes
    .filter((route) => route.method !== "ALL")
    .map((route) => ({ method: route.method, path: route.path }));
}

/** The distinct `:segment`-bearing path patterns on an app, deduped across a route's middleware entries. */
function paramPaths(app: Hono<PithyHonoEnv>): string[] {
  return [...new Set(realRoutes(app).map((route) => route.path))].filter((path) => pathParams(path).length > 0).sort();
}

/** A declared path with real values in its segments, so it can actually be requested. */
function concrete(path: string): string {
  return `/ledger${path}`.replace(":userId", "alice").replace(":currency", "chips");
}

describe("ledger route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These ledger routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((r) => `  ${r.method} ${r.path} (:${r.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real ledger routes, not an empty app", () => {
    // The anti-vacuous check. A gate that silently starts inspecting an empty route table passes
    // forever; adding or removing a route fails here first and says so.
    expect(paramPaths(makeApp())).toEqual([
      "/ledger/:currency",
      "/ledger/:currency/credit",
      "/ledger/:currency/debit",
      "/ledger/:currency/transactions",
      "/ledger/admin/accounts/:userId",
      "/ledger/admin/accounts/:userId/:currency/transactions",
    ]);
  });

  test("the declared route set matches what Hono actually mounted, in both directions", () => {
    const mounted = new Set(realRoutes(makeApp()).map((route) => `${route.method} ${route.path}`));
    for (const declared of LEDGER_ROUTES) {
      expect(mounted.has(`${declared.method} /ledger${declared.path}`), `${declared.method} ${declared.path}`).toBe(
        true,
      );
    }
    const declared = new Set(LEDGER_ROUTES.map((route) => `${route.method} /ledger${route.path}`));
    for (const route of realRoutes(makeApp())) {
      expect(
        declared.has(`${route.method} ${route.path}`),
        `${route.method} ${route.path} is mounted but not declared in LEDGER_ROUTES`,
      ).toBe(true);
    }
  });

  test("mounts under the configured basePath, the management surface included", () => {
    // Deduplicated: Hono records one `app.routes` entry per handler on a line, so a route wearing a
    // guard and two validators appears three times under its own method.
    const moved = realRoutes(makeApp("/wallet"));
    expect(new Set(moved.map((route) => `${route.method} ${route.path}`)).size).toBe(LEDGER_ROUTES.length);
    for (const route of moved) expect(route.path.startsWith("/wallet/")).toBe(true);
  });

  test("every control-plane route actually runs its declared scope guard", async () => {
    // The real gate, and the one a middleware count could never be. Each management route is called with
    // no credential at all: `requireControlPlane` must answer 403 `controlplane/not_connected`, which
    // only happens if the guard genuinely ran. A route that lost its guard would fall through to the
    // handler and fail differently — or worse, succeed and hand the ledger to an anonymous caller.
    for (const route of LEDGER_ROUTES.filter((entry) => entry.strategy === "control-plane")) {
      const path = concrete(route.path);
      const response = await makeApp().request(path, { method: route.method });
      expect(response.status, `${route.method} ${path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs BEFORE the validator, so a malformed request still gets 403 and not 400", async () => {
    // A validator ahead of the gate turns a 403 into a 400 and tells an unverified caller which requests
    // were well-formed. On a read surface over other people's balances that is a live oracle, so the
    // ordering is asserted rather than trusted to the order somebody typed the arguments in.
    const malformed = [
      "/ledger/admin/accounts?limit=nonsense",
      "/ledger/admin/accounts?currency=NOT-A-CODE",
      `/ledger/admin/accounts/${"a".repeat(300)}`,
      "/ledger/admin/accounts/alice/NOT-A-CODE/transactions",
      "/ledger/admin/accounts/alice/chips/transactions?limit=9999",
    ];
    for (const path of malformed) {
      const response = await makeApp().request(path, { method: "GET" });
      expect(response.status, path).toBe(403);
    }
  });

  test("a management route never carries the player auth gate", async () => {
    // `requireAuth()` on one of these would deny every legitimate management call permanently, because
    // the seam leaves `c.var.auth` null by design and no credential could ever populate it. A 401 here
    // is the signature of that mistake; the correct denial for an uncredentialled call is 403.
    for (const route of LEDGER_ROUTES.filter((entry) => entry.strategy === "control-plane")) {
      const path = concrete(route.path);
      const response = await makeApp().request(path, { method: route.method });
      expect(response.status, path).not.toBe(401);
    }
  });

  test("the player routes still deny an unauthenticated caller", async () => {
    expect((await makeApp().request("/ledger/chips")).status).toBe(401);
    expect((await makeApp().request("/ledger/chips/transactions")).status).toBe(401);
  });

  test("every control-plane route declares a scope, and no player route does", () => {
    for (const route of LEDGER_ROUTES) {
      if (route.strategy === "control-plane") {
        expect(route.scope, route.path).toBeDefined();
        expect(LEDGER_CONTROL_PLANE_SCOPES).toContain(route.scope);
      } else {
        expect(route.scope, route.path).toBeUndefined();
      }
    }
  });

  test("the advertised admin surface names the same scope the route checks", () => {
    // Drift here means a management client greys out an action it may perform, or offers one it may not.
    const declared = new Map(
      LEDGER_ROUTES.filter((route) => route.scope).map((route) => [`/ledger${route.path}`, route.scope]),
    );
    for (const advertised of ledgerAdminRoutes("/ledger")) {
      expect(declared.get(advertised.path), advertised.path).toBe(advertised.scope);
    }
  });
});

describe("the advertised admin surface", () => {
  const capability = ledger({ currencies: [{ code: "chips", name: "Chips" }] }) as unknown as Capability;

  test("every advertised admin route is actually mounted", async () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    const drift = missingAdminRoutes(app as unknown as Hono<never>, [capability]);
    expect(
      drift,
      "The control-plane manifest advertises routes that no router mounts. A management client composes its calls from that manifest, so a drifted entry is a 404 nobody can diagnose.",
    ).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    // The trap this capability actually had: the `?? "/ledger"` fallback lived in the route registrar
    // rather than beside the manifest, so the two could disagree about where anything was mounted.
    const moved = ledger({ currencies: [{ code: "chips", name: "Chips" }], basePath: "/wallet" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/wallet/")).toBe(true);
  });

  test("each advertised route names a scope this capability defines", () => {
    for (const route of ledgerAdminRoutes("/ledger")) {
      expect(LEDGER_CONTROL_PLANE_SCOPES).toContain(route.scope);
    }
  });

  test("reading a balance and reading its history are separate scopes", () => {
    // One `ledger:admin` flag would mean a credential issued to render a balances pane could also
    // reconstruct every player's economic history. `scopeCovers` matches exactly, so these confer
    // nothing about each other — which is only true while they are genuinely two strings.
    expect(LEDGER_ACCOUNTS_READ_SCOPE).not.toBe(LEDGER_TRANSACTIONS_READ_SCOPE);
    expect(new Set(LEDGER_CONTROL_PLANE_SCOPES).size).toBe(2);
  });

  test("nothing advertised can move a balance", () => {
    // The whole scope of this surface. A POST, PUT, PATCH or DELETE appearing here is the review this
    // test exists to force: an adjustment from a console needs an idempotency key, a recorded reason,
    // and a reversal path, and none of those are designed yet.
    for (const route of capability.adminRoutes ?? []) expect(route.method).toBe("GET");
    for (const scope of LEDGER_CONTROL_PLANE_SCOPES) expect(scope.endsWith(":read")).toBe(true);
  });

  test("the player and management surfaces cannot collide", () => {
    // `${base}/:currency` claims every one-segment path under the mount point, so a management route at
    // `${base}/accounts` would be ambiguous with a currency called `accounts` — and its gate would be
    // decided by registration order. Every management path is deeper than that, and the segment after
    // the base is static.
    for (const route of ledgerAdminRoutes("/ledger")) {
      expect(route.path.startsWith("/ledger/admin/"), route.path).toBe(true);
      expect(route.path.split("/").length, route.path).toBeGreaterThan(3);
    }
  });
});
