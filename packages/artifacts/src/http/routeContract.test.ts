// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes, undeclaredAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { openApiDocument, undescribedFields, undescribedRoutes } from "@pithy-sh/core/src/openapi/document";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { artifacts } from "../capability";
import { parseArtifactsConfig } from "../config/config";
import { registerArtifactsRoutes } from "./routes";
import {
  ARTIFACTS_CONTROL_PLANE_SCOPES,
  ARTIFACTS_REPOS_READ_SCOPE,
  ARTIFACTS_TOKENS_REVOKE_SCOPE,
  artifactsAdminRoutes,
} from "./scopes";

/**
 * The route request contract, applied to this package: every `:segment` validated, every route described, every
 * field described. The organization routes mount only where `organization` is composed, so the gate composes them.
 * A composed app is only inspected; nothing is bound and no request is made.
 */
function composed(organization = true): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  registerArtifactsRoutes({
    config: parseArtifactsConfig({ managePower: "repos:manage" }),
    organization: () => organization,
  })(app);
  return app;
}

describe("artifacts route contract", () => {
  test("every param-bearing route validates its params", async () => {
    const uncovered = await uncoveredParamRoutes(composed() as unknown as Hono<never>);
    expect(uncovered).toEqual([]);
  });

  test("the gate is not vacuous — it sees every param route", () => {
    const paths = [
      ...new Set(
        composed()
          .routes.filter((r) => pathParams(r.path).length > 0)
          .map((r) => r.path),
      ),
    ].sort();
    expect(paths).toEqual([
      "/artifacts/admin/repos/:name",
      "/artifacts/admin/repos/:name/tokens",
      "/artifacts/admin/repos/:name/tokens/:tokenId/revoke",
      "/artifacts/admin/repos/:name/tokens/revoke",
      "/artifacts/repos/:name",
      "/artifacts/repos/:name/blob/:hash",
      "/artifacts/repos/:name/commits/:hash",
      "/artifacts/repos/:name/credentials",
      "/artifacts/repos/:name/file",
      "/artifacts/repos/:name/grants",
      "/artifacts/repos/:name/grants/:userId",
      "/artifacts/repos/:name/log",
      "/artifacts/repos/:name/tree/:hash",
    ]);
  });

  test("the organization routes mount only where organization is composed", () => {
    const withOrg = composed(true).routes.map((r) => `${r.method} ${r.path}`);
    const without = composed(false).routes.map((r) => `${r.method} ${r.path}`);
    expect(withOrg).toContain("POST /artifacts/organization/repos");
    expect(withOrg).toContain("GET /artifacts/organization/repos");
    expect(without.filter((route) => route.includes("/organization/"))).toEqual([]);
  });
});

describe("route contract: every route is described for the OpenAPI contract", () => {
  const groups = () => [{ tag: "artifacts", routes: composed().routes }];

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes(groups())).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "artifacts", version: "0" }, groups());
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });
});

/** The app as `createBackend` seeds it, with no control-plane verifier: every management call must be refused. */
function seeded(): Hono<PithyHonoEnv> {
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
  registerArtifactsRoutes({ config: parseArtifactsConfig({}), organization: () => false })(app);
  return app;
}

/** An advertised path with its params filled, and the body a revoke carries. */
function concrete(path: string): string {
  return path.replace(":name", "r1").replace(":tokenId", "tok_1");
}

describe("the control-plane surface", () => {
  const capability = artifacts() as unknown as Capability;

  test("every advertised admin route is mounted, and every mounted one is advertised", () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    const moved = artifacts({ basePath: "/git" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/git/admin/")).toBe(true);
  });

  test("reads take artifacts:repos:read, revokes take artifacts:tokens:revoke, and nothing else is declared", () => {
    expect(ARTIFACTS_CONTROL_PLANE_SCOPES).toEqual(["artifacts:repos:read", "artifacts:tokens:revoke"]);
    for (const route of artifactsAdminRoutes("/artifacts")) {
      expect(route.scope, route.path).toBe(
        route.method === "GET" ? ARTIFACTS_REPOS_READ_SCOPE : ARTIFACTS_TOKENS_REVOKE_SCOPE,
      );
    }
  });

  test("the scope each route checks is the scope the manifest advertises", () => {
    const declared = new Map(
      composed()
        .routes.filter((route) => route.path.includes("/admin/"))
        .map((route) => [`${route.method} ${route.path}`, route]),
    );
    const document = openApiDocument({ title: "artifacts", version: "0" }, [
      { tag: "artifacts", routes: composed().routes },
    ]);
    for (const advertised of artifactsAdminRoutes("/artifacts")) {
      expect(declared.has(`${advertised.method} ${advertised.path}`), advertised.path).toBe(true);
      const openApiPath = advertised.path.replace(/:(\w+)/g, "{$1}");
      const operation = (document.paths[openApiPath] as Record<string, Record<string, unknown>>)[
        advertised.method.toLowerCase()
      ];
      expect(operation?.["x-pithy-scopes"], advertised.path).toEqual([advertised.scope]);
    }
  });

  test("a call with no connection is refused with a 403 on every management route, never a 401", async () => {
    // A 401 would be `requireAuth()` on a management route: a gate no management client can ever pass.
    for (const route of artifactsAdminRoutes("/artifacts")) {
      const init: RequestInit =
        route.method === "POST"
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ idempotencyKey: "k", reason: "Why." }),
            }
          : { method: "GET" };
      const response = await seeded().request(concrete(route.path), init);
      expect(response.status, route.path).toBe(403);
    }
  });
});
