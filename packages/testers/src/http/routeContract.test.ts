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
import { testers } from "../capability";
import { TestersConfig } from "../config/config";
import { generateOptInToken } from "../crypto/token";
import { registerTestersRoutes, selectForNudge, TESTERS_ROUTES } from "./routes";
import { OptInTokenParam } from "./schemas";
import {
  TESTERS_CONTROL_PLANE_SCOPES,
  TESTERS_NUDGE_SEND_SCOPE,
  TESTERS_ROSTER_READ_SCOPE,
  TESTERS_ROSTER_WRITE_SCOPE,
  testersAdminRoutes,
} from "./scopes";

/**
 * Gate two of the request contract. The Biome GritQL plugin is gate one — it bans the raw accessors, so
 * `c.req.valid()` is the only way to reach a query or a body. Params have no accessor to ban, so they
 * need this positive check instead.
 */

const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });

/**
 * The routes, mounted the way `createBackend` mounts them.
 *
 * The error handler and the seeded request variables are not decoration: `createBackend` installs
 * `pithyErrorHandler` and seeds `c.var` on every real deployment, so a bare Hono app would answer 500
 * where production answers 403 and would crash where production audits a denial. A gate that asserts
 * against a different app than the one that ships is not a gate.
 */
function makeApp(basePath?: string) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    // Null, as it is in a Worker that never composed `controlplane()` — which is exactly the state the
    // seam is meant to deny in, and therefore the one worth testing.
    c.set("controlPlaneVerifier", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    await next();
  });
  registerTestersRoutes({ config: CONFIG, basePath })(app);
  return app;
}

/**
 * The paths this capability mounted, excluding the `*` entry the test harness's own variable-seeding
 * middleware registers. Filtering by prefix rather than by exclusion keeps it honest: a route mounted
 * somewhere unexpected shows up as a missing path rather than being quietly skipped.
 */
function mountedPaths(app: Hono<PithyHonoEnv>, base = "/testers"): string[] {
  return [...new Set(app.routes.map((route) => route.path))].filter((path) => path.startsWith(`${base}/`));
}

/**
 * Every route Hono actually mounted, method included and middleware excluded.
 *
 * `app.routes` lists middleware too, as `ALL` on the pattern it was registered against — the `app.use("*")`
 * in `makeApp` is one. Those are not routes and have nothing to declare, so they are filtered out by
 * method rather than by path: filtering by a `/testers/` prefix would also silently drop a route
 * mounted at exactly the base, or under a prefix somebody typed wrong, which is precisely the drift
 * this check exists to catch.
 */
function realRoutes(app: Hono<PithyHonoEnv>): { method: string; path: string }[] {
  return app.routes
    .filter((route) => route.method !== "ALL")
    .map((route) => ({ method: route.method, path: route.path }));
}

function paramPaths(app: Hono<PithyHonoEnv>): string[] {
  return mountedPaths(app).filter((path) => pathParams(path).length > 0);
}

describe("testers route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These testers routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((route) => `  ${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real testers routes, not an empty app", () => {
    const paths = mountedPaths(makeApp()).sort();
    expect(paths).toEqual([
      "/testers/cohorts",
      "/testers/confirm/:token",
      "/testers/invite",
      "/testers/nudge",
      "/testers/opt-in/:token",
      "/testers/opt-out/:token",
      "/testers/remove",
      "/testers/resend",
      "/testers/status",
    ]);
    // The three public routes are the only ones carrying a param, and all are token-bearing.
    expect(paramPaths(makeApp()).sort()).toEqual([
      "/testers/confirm/:token",
      "/testers/opt-in/:token",
      // One path, two methods: the GET asks and the POST acts. See the opt-out tests below for why.
      "/testers/opt-out/:token",
    ]);
  });

  test("mounts under the configured basePath, the public links included", () => {
    // An adopter who moves the mount point moves the confirmation links with it, so the admin manifest
    // and the minted URLs have to follow rather than assume the default.
    const moved = mountedPaths(makeApp("/beta"), "/beta");
    // Paths, not routes — `/opt-out/:token` is mounted twice, once per method.
    expect(moved).toHaveLength(new Set(TESTERS_ROUTES.map((route) => route.path)).size);
    for (const path of moved) expect(path.startsWith("/beta/")).toBe(true);
  });

  test("the declared route set matches what Hono actually mounted, in both directions", () => {
    // The registry is a declaration, so it can drift. This is what stops it: a route added without an
    // entry and an entry naming a route nobody mounts both fail here.
    const mounted = new Set(makeApp().routes.map((route) => `${route.method} ${route.path}`));
    for (const declared of TESTERS_ROUTES) {
      expect(mounted.has(`${declared.method} /testers${declared.path}`), `${declared.method} ${declared.path}`).toBe(
        true,
      );
    }
    // Method *and* path, and every mounted route rather than the deduplicated path set. Comparing
    // paths alone let an extra method on an already-declared path through — `POST /status` beside the
    // declared `GET /status` would have been invisible, and since the registry is the only record of a
    // route's verification strategy, invisible here means undeclared everywhere. `/opt-out/:token` is
    // itself two methods on one path, so this is the case that already exists rather than a
    // hypothetical one.
    const declared = new Set(TESTERS_ROUTES.map((route) => `${route.method} /testers${route.path}`));
    for (const route of realRoutes(makeApp())) {
      expect(
        declared.has(`${route.method} ${route.path}`),
        `${route.method} ${route.path} is mounted but not declared in TESTERS_ROUTES`,
      ).toBe(true);
    }
  });

  test("every control-plane route actually runs its declared scope guard", async () => {
    // The real gate, and the one a middleware count could never be. Each control-plane route is called
    // with no credential at all: `requireControlPlane` must answer 403 `controlplane/not_connected`,
    // which only happens if the guard genuinely ran. A route that lost its guard would fall through to
    // the handler and fail differently — or worse, succeed.
    for (const route of TESTERS_ROUTES.filter((entry) => entry.strategy === "control-plane")) {
      const response = await makeApp().request(`/testers${route.path}`, {
        method: route.method,
        ...(route.method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs BEFORE the validator, so a malformed body still gets 403 and not 400", async () => {
    // A validator ahead of the gate turns a 401/403 into a 400 and tells an unauthenticated caller which
    // requests were well-formed. On these routes that is a live oracle for the roster's shape, so the
    // ordering is asserted rather than trusted to the order someone typed the arguments in.
    for (const route of TESTERS_ROUTES.filter(
      (entry) => entry.strategy === "control-plane" && entry.method === "POST",
    )) {
      const response = await makeApp().request(`/testers${route.path}`, {
        method: "POST",
        body: JSON.stringify({ nonsense: true }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  test("the authenticated route denies an unauthenticated caller", async () => {
    const response = await makeApp().request("/testers/status");
    expect(response.status).toBe(401);
  });

  test("every control-plane route declares a scope, and no public route does", () => {
    for (const route of TESTERS_ROUTES) {
      if (route.strategy === "control-plane") {
        expect(route.scope, `${route.path}`).toBeDefined();
        expect(TESTERS_CONTROL_PLANE_SCOPES).toContain(route.scope);
      } else {
        expect(route.scope, `${route.path}`).toBeUndefined();
      }
    }
  });

  test("the advertised admin surface names the same scope the route checks", () => {
    // Drift here means a management client greys out an action it may perform, or offers one it may not.
    const declared = new Map(
      TESTERS_ROUTES.filter((route) => route.scope).map((route) => [`/testers${route.path}`, route.scope]),
    );
    for (const advertised of testersAdminRoutes("/testers")) {
      expect(declared.get(advertised.path), advertised.path).toBe(advertised.scope);
    }
  });
});

describe("the advertised admin surface", () => {
  const capability = testers({ baseUrl: "https://api.example.test" }) as unknown as Capability;

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
    const moved = testers({ baseUrl: "https://api.example.test", basePath: "/beta" }) as unknown as Capability;
    for (const route of moved.adminRoutes ?? []) {
      expect(route.path.startsWith("/beta/")).toBe(true);
    }
  });

  test("each advertised route names a scope this capability defines", () => {
    for (const route of testersAdminRoutes("/testers")) {
      expect(TESTERS_CONTROL_PLANE_SCOPES).toContain(route.scope);
    }
  });

  test("read, write, and send are separate scopes", () => {
    // One `testers:admin` flag would mean a credential issued to read a roster could also mail every
    // person on it — and mailing is the operation whose blast radius reaches outside the adopter's own
    // systems.
    expect(new Set([TESTERS_ROSTER_READ_SCOPE, TESTERS_ROSTER_WRITE_SCOPE, TESTERS_NUDGE_SEND_SCOPE]).size).toBe(3);
    expect(TESTERS_NUDGE_SEND_SCOPE).not.toBe(TESTERS_ROSTER_WRITE_SCOPE);
  });

  test("only control-plane routes are advertised — the public links are not management surface", () => {
    const advertised = (capability.adminRoutes ?? []).map((route) => route.path);
    expect(advertised).not.toContain("/testers/opt-in/:token");
    expect(advertised).not.toContain("/testers/confirm/:token");
    expect(advertised).not.toContain("/testers/status");
  });
});

describe("the param schema accepts the tokens we actually issue", () => {
  test("a freshly generated token parses", () => {
    // This is the gap that let a real bug ship all the way to a passing test suite. The contract test
    // above proves a validator EXISTS on every param route; it cannot prove the validator accepts
    // anything real. When the token stopped being a signed `payload.signature` pair and became a single
    // 43-character value, the schema still demanded a dot — so every confirm, opt-in and opt-out link a
    // tester received answered 400 before any handler ran, and nothing failed.
    for (let attempt = 0; attempt < 25; attempt++) {
      const token = generateOptInToken();
      expect(() => OptInTokenParam.parse({ token }), token).not.toThrow();
    }
  });

  test("it still refuses what is not one of ours", () => {
    for (const bad of ["", "short", "a".repeat(44), "a.b", `${"a".repeat(42)}=`, "../../etc/passwd"]) {
      expect(() => OptInTokenParam.parse({ token: bad }), bad).toThrow();
    }
  });
});

describe("selection is not an override", () => {
  const live = (state: string) => ({ id: `m-${state}`, state, email: `${state}@example.com` });
  const roster = [
    live("invited"),
    live("accepted"),
    live("opted_in"),
    live("lapsed"),
    live("removed"),
  ] as unknown as Parameters<typeof selectForNudge>[0];

  test("naming a tester who opted out does not mail them", () => {
    // The one message this capability must never send. Consent is a server-side fact exactly as the
    // cooldown is, and pointing at someone by id must not be a way around it.
    const selected = selectForNudge(roster, "inactive", ["m-lapsed", "m-opted_in"]);
    expect(selected.map((m) => m.id)).toEqual(["m-opted_in"]);
  });

  test("naming only withdrawn testers raises rather than silently mailing nobody", () => {
    expect(() => selectForNudge(roster, "inactive", ["m-lapsed", "m-removed"])).toThrow();
  });

  test("each kind selects the population its own message is for", () => {
    // `confirm` asks whether they will test, so it targets people who have not answered. `store` sends
    // the link, so it targets people who have. A `confirm` that also swept up `accepted` testers would
    // re-ask a question they already said yes to, while the link they are waiting for never arrives.
    expect(selectForNudge(roster, "confirm", undefined).map((m) => m.id)).toEqual(["m-invited"]);
    expect(selectForNudge(roster, "store", undefined).map((m) => m.id)).toEqual(["m-accepted"]);
    expect(selectForNudge(roster, "inactive", undefined).map((m) => m.id)).toEqual(["m-opted_in"]);
    expect(selectForNudge(roster, "closing", undefined).map((m) => m.id)).toEqual(["m-opted_in"]);
  });

  test("no kind ever selects a withdrawn or removed tester", () => {
    for (const kind of ["confirm", "store", "inactive", "closing"] as const) {
      const ids = selectForNudge(roster, kind, undefined).map((m) => m.id);
      expect(ids).not.toContain("m-lapsed");
      expect(ids).not.toContain("m-removed");
    }
  });
});

describe("withdrawing takes two steps", () => {
  /** A member row and its token, seeded straight into a Miniflare-free fake is not possible here, so
   *  these assert the shape of the exchange rather than its effect — the effect is covered in the
   *  workers tests. What matters at this level is that the GET cannot mutate. */
  test("the opt-out path is mounted for both GET and POST", () => {
    const declared = TESTERS_ROUTES.filter((route) => route.path === "/opt-out/:token");
    expect(declared.map((route) => route.method).sort()).toEqual(["GET", "POST"]);
  });

  test("both remain public — a tester withdrawing has no account to authenticate with", () => {
    for (const route of TESTERS_ROUTES.filter((r) => r.path === "/opt-out/:token")) {
      expect(route.strategy).toBe("public");
      expect(route.scope).toBeUndefined();
    }
  });

  test("the confirmation page itself is covered in pages.test.ts, where it is pure", () => {
    // Asserting its HTML through a request would need a database bound to look the token up first.
    // The renderer takes a string and returns a Response, so that is the layer that can prove it.
    expect(TESTERS_ROUTES.some((route) => route.method === "POST" && route.path === "/opt-out/:token")).toBe(true);
  });
});
