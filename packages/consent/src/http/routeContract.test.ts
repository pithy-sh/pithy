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
import { consent } from "../capability";
import { CONSENT_CONTROL_PLANE_SCOPES, CONSENT_READ_SCOPE, consentAdminRoutes } from "./scopes";

/**
 * The route request contract (CLAUDE.md §HTTP), applied to consent: every `:segment` is validated, every route is
 * described, every field in the contract carries a description, and every management route denies without a
 * control-plane connection. No request reaches a database: the app is inspected, or denied before it reads.
 */

/** The consent routes, composed the way `createBackend` composes them, with no control plane. */
function served(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    c.set("sameOrigin", null);
    await next();
  });
  consent().routes?.(app);
  return app;
}

describe("consent route contract", () => {
  test("every param-bearing route validates its params", async () => {
    const uncovered = await uncoveredParamRoutes(served() as unknown as Hono<never>);
    expect(uncovered).toEqual([]);
  });

  test("the gate is not vacuous — it sees every param route consent ships", () => {
    const paths = [
      ...new Set(
        served()
          .routes.filter((r) => pathParams(r.path).length > 0)
          .map((r) => r.path),
      ),
    ].sort();
    expect(paths).toEqual([
      "/consent/control-plane/documents/:hash",
      "/consent/control-plane/evidence/:hash",
      "/consent/control-plane/subjects/:kind/:subjectId",
      "/consent/me/documents/:hash",
    ]);
  });

  test("every route declares describeRoute, and every field is described", () => {
    const groups = [{ tag: "consent", routes: served().routes }];
    expect(undescribedRoutes(groups)).toEqual([]);
    const document = openApiDocument({ title: "consent", version: "0" }, groups);
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });
});

/** A declared admin path with real values in its segments. */
function concrete(path: string): string {
  return path.replace(":kind", "account").replace(":subjectId", "ada").replace(":hash", "a".repeat(64));
}

describe("the management surface", () => {
  test("every management route refuses a caller with no control-plane connection", async () => {
    for (const route of consentAdminRoutes("/consent")) {
      const response = await served().request(concrete(route.path), { method: route.method });
      expect(response.status, route.path).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, route.path).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs before the validator, so a malformed request is still a 403", async () => {
    for (const path of ["/consent/control-plane/subjects/robot/ada", "/consent/control-plane/documents/NOT_A_HASH"]) {
      expect((await served().request(path)).status, path).toBe(403);
    }
  });

  test("both writes refuse with no same-origin policy composed, before reading the body", async () => {
    for (const path of ["/consent/grants", "/consent/withdrawals"]) {
      const response = await served().request(path, { method: "POST", body: "not json" });
      expect(response.status, path).toBe(403);
    }
  });

  test("every advertised admin route is mounted, and every mounted one is advertised, wherever it is mounted", () => {
    for (const basePath of ["/consent", "/privacy/consent"]) {
      const capability = consent({ basePath }) as unknown as Capability;
      const app = new Hono<PithyHonoEnv>();
      capability.routes?.(app);
      expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
      expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
    }
  });

  test("every management route asks for consent:read, the one scope consent defines", () => {
    expect(CONSENT_CONTROL_PLANE_SCOPES).toEqual([CONSENT_READ_SCOPE]);
    for (const route of consentAdminRoutes("/consent")) {
      expect(route.method).toBe("GET");
      expect(route.scope).toBe(CONSENT_READ_SCOPE);
    }
  });
});
