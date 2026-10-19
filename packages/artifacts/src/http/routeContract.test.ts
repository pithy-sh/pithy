// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { openApiDocument, undescribedFields, undescribedRoutes } from "@pithy-sh/core/src/openapi/document";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { parseArtifactsConfig } from "../config/config";
import { registerArtifactsRoutes } from "./routes";

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
