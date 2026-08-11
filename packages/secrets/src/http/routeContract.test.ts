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
import { secrets } from "../capability";
import { defineSecretRegistry } from "../registry";
import { SECRETS_CONTROL_PLANE_SCOPES, SECRETS_STATUS_READ_SCOPE, secretsAdminRoutes } from "./guards";
import { registerSecretsRoutes, SECRETS_ROUTES } from "./routes";

/**
 * The secrets capability's half of gate 2 of the route request contract (issue #74), plus the
 * management surface's own gate.
 *
 * The app is composed the way `createBackend` composes it: the error handler installed and the request
 * variables seeded. A bare Hono app would answer 500 where production answers 403, and a gate that
 * asserts against a different app than the one that ships is not a gate.
 *
 * `controlPlaneVerifier` is seeded **null**, which is the state of a Worker that never composed
 * `controlplane()` — exactly the state the seam is meant to deny in, and therefore the one worth
 * testing. It also means these cases never reach a handler, so no D1 binding is needed here; what the
 * handlers do once they are past the gate is `admin/status.workers.test.ts`, against a real database.
 */

const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: 90 },
});

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
  registerSecretsRoutes({ registry: () => registry, basePath })(app);
  return app;
}

/**
 * Every route Hono actually mounted, method included and middleware excluded. `app.routes` lists
 * middleware too, as `ALL` on the pattern it was registered against — the `app.use("*")` above is one.
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

/** A declared path with a real value in its segment, so it can actually be requested. */
function concrete(path: string): string {
  return `/secrets${path}`.replace(":name", "auth-signing-key");
}

describe("secrets route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These secrets routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((r) => `  ${r.method} ${r.path} (:${r.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real secrets routes, not an empty app", () => {
    // The anti-vacuous check. A gate that silently starts inspecting an empty route table passes
    // forever; adding or removing a route fails here first and says so.
    expect(paramPaths(makeApp())).toEqual(["/secrets/admin/status/:name/rotations"]);
  });

  test("the declared route set matches what Hono actually mounted, in both directions", () => {
    const mounted = new Set(realRoutes(makeApp()).map((route) => `${route.method} ${route.path}`));
    for (const declared of SECRETS_ROUTES) {
      expect(mounted.has(`${declared.method} /secrets${declared.path}`), `${declared.method} ${declared.path}`).toBe(
        true,
      );
    }
    const declared = new Set(SECRETS_ROUTES.map((route) => `${route.method} /secrets${route.path}`));
    for (const route of realRoutes(makeApp())) {
      expect(
        declared.has(`${route.method} ${route.path}`),
        `${route.method} ${route.path} is mounted but not declared in SECRETS_ROUTES`,
      ).toBe(true);
    }
  });

  test("mounts under the configured basePath", () => {
    // Deduplicated: Hono records one `app.routes` entry per handler on a line, so a route wearing a
    // guard and two validators appears three times under its own method.
    const moved = realRoutes(makeApp("/vault"));
    expect(new Set(moved.map((route) => `${route.method} ${route.path}`)).size).toBe(SECRETS_ROUTES.length);
    for (const route of moved) expect(route.path.startsWith("/vault/")).toBe(true);
  });

  test("every route actually runs its scope guard", async () => {
    // The real gate, and the one a middleware count could never be. Each route is called with no
    // credential at all: `requireControlPlane` must answer 403 `controlplane/not_connected`, which only
    // happens if the guard genuinely ran. A route that lost its guard would fall through to the handler
    // and hand a project's secret estate to an anonymous caller.
    for (const route of SECRETS_ROUTES) {
      const path = concrete(route.path);
      const response = await makeApp().request(path, { method: route.method });
      expect(response.status, `${route.method} ${path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs BEFORE the validator, so a malformed request still gets 403 and not 400", async () => {
    // A validator ahead of the gate turns a 403 into a 400 and tells an unverified caller which requests
    // were well-formed. On a surface that enumerates a project's credentials that is a live oracle, so
    // the ordering is asserted rather than trusted to the order somebody typed the arguments in.
    const malformed = [
      `/secrets/admin/status/${"a".repeat(400)}/rotations`,
      "/secrets/admin/status/auth-signing-key/rotations?limit=nonsense",
      "/secrets/admin/status/auth-signing-key/rotations?limit=9999",
    ];
    for (const path of malformed) {
      const response = await makeApp().request(path, { method: "GET" });
      expect(response.status, path).toBe(403);
    }
  });

  test("a management route never carries the player auth gate", async () => {
    // `requireAuth()` on one of these would deny every legitimate management call, permanently, because
    // the seam leaves `c.var.auth` null by design and no credential could ever populate it. A 401 here
    // is the signature of that mistake; the correct denial for an uncredentialled call is 403.
    for (const route of SECRETS_ROUTES) {
      const path = concrete(route.path);
      expect((await makeApp().request(path, { method: route.method })).status, path).not.toBe(401);
    }
  });

  test("every route declares the capability's own scope", () => {
    for (const route of SECRETS_ROUTES) {
      expect(route.strategy, route.path).toBe("control-plane");
      expect(SECRETS_CONTROL_PLANE_SCOPES).toContain(route.scope);
    }
  });

  test("the advertised admin surface names the same scope the route checks", () => {
    // Drift here means a management client greys out an action it may perform, or offers one it may not.
    const declared = new Map(SECRETS_ROUTES.map((route) => [`/secrets${route.path}`, route.scope]));
    for (const advertised of secretsAdminRoutes("/secrets")) {
      expect(declared.get(advertised.path), advertised.path).toBe(advertised.scope);
    }
  });
});

describe("the advertised admin surface", () => {
  const capability = secrets({ registry }) as unknown as Capability;

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
    const moved = secrets({ registry, basePath: "/vault" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/vault/")).toBe(true);
  });

  test("secret status is its own scope, and it is a read", () => {
    // Its own, because the list of which credentials a project holds and which are stale is a map of
    // where to push — an adopter must be able to grant a users pane without also granting that. A read,
    // because `defaultGrant` classifies a scope by the methods of the routes requiring it, and a write
    // appearing here would silently widen what `pithy dashboard connect` hands out by default.
    expect(SECRETS_CONTROL_PLANE_SCOPES).toEqual([SECRETS_STATUS_READ_SCOPE]);
    expect(SECRETS_STATUS_READ_SCOPE).toBe("secrets:status:read");
    for (const route of capability.adminRoutes ?? []) expect(route.method).toBe("GET");
  });

  test("nothing advertised reads a value", () => {
    // The review this test exists to force. There is no route here that returns a secret, and there is
    // no scope that could grant one: the whole reason a value is encrypted under a key only the
    // customer's Worker holds is that no third party has a path to the plaintext. A route added here
    // that reads one would be that path, in every deployment, whether or not anybody granted it.
    for (const route of capability.adminRoutes ?? []) {
      expect(route.path.startsWith("/secrets/admin/status"), route.path).toBe(true);
      expect(route.summary.toLowerCase()).not.toContain("value");
    }
  });
});
