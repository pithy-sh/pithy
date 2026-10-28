// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { PithyHonoEnv } from "../../capability/capability";
import { pathParams, uncoveredParamRoutes } from "../../http/routeContract";
import { openApiDocument, undescribedFields, undescribedRoutes } from "../../openapi/document";
import { type ControlPlaneOptions, controlplane } from "../capability";
import { missingAdminRoutes, undeclaredAdminRoutes } from "../discovery/drift";
import {
  ERASURE_READ_SCOPE,
  EVIDENCE_READ_SCOPE,
  MIGRATIONS_READ_SCOPE,
  PRIVACY_READ_SCOPE,
  PROCESSING_READ_SCOPE,
  RETENTION_HOLD_SCOPE,
  RETENTION_READ_SCOPE,
} from "../scope/scope";
import { PlaceHoldRequest, ReleaseHoldRequest } from "./schemas";

/**
 * The control-plane seam's half of gate 2 of the route request contract. A handler can reach a path
 * param through a validator it never declared, so the Biome ban that covers query and body cannot cover
 * params — this asserts the positive instead.
 *
 * No request is made. The app is composed and inspected, so no verifier, no `DB` binding, and no
 * migrations are needed. That is also why this is a node test, and why nothing in `routes.ts` may reach
 * `cloudflare:workers`.
 *
 * The app is built from the real `controlplane()` capability rather than by calling
 * `registerControlPlaneRoutes` directly, so what is inspected is the route tree an adopter actually
 * gets — base path resolved from parsed config included.
 */
function makeApp(options: ControlPlaneOptions = {}): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  controlplane(options).routes?.(app);
  return app;
}

function paramPaths(app: Hono<PithyHonoEnv>): string[] {
  return [
    ...new Set(app.routes.filter((route) => pathParams(route.path).length > 0).map((route) => route.path)),
  ].sort();
}

describe("control-plane route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These control-plane routes read a path param they never declared a schema for. Add \`validate("param", <Schema>)\` to each route line, with the schema in src/controlPlane/http/schemas.ts:\n${uncovered
        .map((route) => `  ${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real control-plane routes, not an empty app", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);
    const paths = [...new Set(app.routes.map((route) => route.path))].sort();
    // Every route this seam serves. The list is what makes adding a route a deliberate edit rather
    // than a surprise, and it is the only place a control-plane route can be counted.
    expect(paths).toEqual([
      "/control-plane/erasure",
      "/control-plane/erasure/:subjectType/:subjectId",
      "/control-plane/evidence",
      "/control-plane/holds",
      "/control-plane/holds/:holdId/release",
      "/control-plane/keys",
      "/control-plane/keys/:keyId/expire",
      "/control-plane/manifest",
      "/control-plane/migrations",
      "/control-plane/ping",
      "/control-plane/presence/tickets",
      "/control-plane/privacy",
      "/control-plane/processing",
    ]);
    // The one param-carrying path, named exactly. Without this the check above would pass on an app
    // that declared no params at all, which proves nothing.
    expect(paramPaths(app)).toEqual([
      "/control-plane/erasure/:subjectType/:subjectId",
      "/control-plane/holds/:holdId/release",
      "/control-plane/keys/:keyId/expire",
    ]);
  });

  test("mounts under the configured basePath, every route included", () => {
    // A basePath that moved only some routes would leave a management client half-connected: the seam
    // it can reach would work and the one it cannot would 404, with nothing saying why.
    const app = makeApp({ basePath: "/admin/cp" });
    expect([...new Set(app.routes.map((route) => route.path))].every((path) => path.startsWith("/admin/cp/"))).toBe(
      true,
    );
    expect(paramPaths(app)).toEqual([
      "/admin/cp/erasure/:subjectType/:subjectId",
      "/admin/cp/holds/:holdId/release",
      "/admin/cp/keys/:keyId/expire",
    ]);
  });

  test("every route carries at least one guard ahead of its handler", () => {
    // The positive half of "no public routes". A route registered with a bare handler has one entry in
    // `app.routes`; every route here must have more, and the first of them is `requireControlPlane`.
    const app = makeApp();
    const handlerCounts = new Map<string, number>();
    for (const route of app.routes) {
      const key = `${route.method} ${route.path}`;
      handlerCounts.set(key, (handlerCounts.get(key) ?? 0) + 1);
    }
    expect(handlerCounts.size).toBe(15);
    for (const [route, count] of handlerCounts) expect(count, `${route} has no guard`).toBeGreaterThan(1);
  });

  test("every admin route the seam advertises is a route it actually mounts", () => {
    // The seam holds itself to the rule it imposes on every capability. `GET /control-plane/manifest`
    // tells a management client these eleven routes exist and which scope each needs; a declaration that
    // drifted from the registrations would have the client calling paths nothing serves.
    const capability = controlplane();
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);

    expect(capability.adminRoutes).toHaveLength(15);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
    // And the other direction. The CORS surface derives from `adminRoutes`, so a guarded
    // route nobody declared gets no preflight and no browser reaches it, with this suite still green.
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("a moved base path moves the advertised routes too", () => {
    // The reason paths are described rather than assumed. An adopter who mounts the seam elsewhere must
    // get a manifest naming where it actually is.
    const capability = controlplane({ basePath: "/admin/cp" });
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);

    expect(capability.adminRoutes?.every((route) => route.path.startsWith("/admin/cp/"))).toBe(true);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("ping advertises a null scope — it needs a verified caller and no grant", () => {
    // A client reads this to know it can always prove a key, including on a connection granted nothing.
    const advertised = controlplane().adminRoutes ?? [];
    const ping = advertised.find((route) => route.path.endsWith("/ping"));
    expect(ping?.scope).toBeNull();
    // The presence ticket route is the other null, and for a different reason: the scope it needs is the
    // room kind's, named in its body and listed beside each kind in the manifest.
    expect(advertised.filter((route) => route.scope === null).map((route) => route.path)).toEqual([
      "/control-plane/ping",
      "/control-plane/presence/tickets",
    ]);
  });

  test("every route requiring migrations:read is a GET, so connect grants it as a read", () => {
    // `pithy dashboard connect` derives its default grant by method: a scope is a read only when every
    // route requiring it is a `GET`. One write behind this scope would drop it from every new connection.
    const advertised = controlplane().adminRoutes ?? [];
    const reading = advertised.filter((route) => route.scope === MIGRATIONS_READ_SCOPE);
    expect(reading.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /control-plane/migrations"]);
    const app = makeApp();
    const mounted = app.routes.filter((route) => route.path === "/control-plane/migrations");
    expect([...new Set(mounted.map((route) => route.method))]).toEqual(["GET"]);
  });

  test("every route requiring privacy:read is a GET, so connect offers it as a read", () => {
    const advertised = controlplane().adminRoutes ?? [];
    const reading = advertised.filter((route) => route.scope === PRIVACY_READ_SCOPE);
    expect(reading.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /control-plane/privacy"]);
  });

  test("every route requiring evidence:read is a GET, so connect offers it as a read", () => {
    const advertised = controlplane().adminRoutes ?? [];
    const reading = advertised.filter((route) => route.scope === EVIDENCE_READ_SCOPE);
    expect(reading.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /control-plane/evidence"]);
    const mounted = makeApp().routes.filter((route) => route.path === "/control-plane/evidence");
    expect([...new Set(mounted.map((route) => route.method))]).toEqual(["GET"]);
  });

  test("every route requiring processing:read is a GET, so connect offers it as a read", () => {
    const advertised = controlplane().adminRoutes ?? [];
    const reading = advertised.filter((route) => route.scope === PROCESSING_READ_SCOPE);
    expect(reading.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /control-plane/processing"]);
    const mounted = makeApp().routes.filter((route) => route.path === "/control-plane/processing");
    expect([...new Set(mounted.map((route) => route.method))]).toEqual(["GET"]);
  });

  test("every route requiring erasure:read is a GET, so connect offers it as a read", () => {
    const advertised = controlplane().adminRoutes ?? [];
    const reading = advertised.filter((route) => route.scope === ERASURE_READ_SCOPE);
    expect(reading.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /control-plane/erasure",
      "GET /control-plane/erasure/:subjectType/:subjectId",
    ]);
    const mounted = makeApp().routes.filter((route) => route.path.startsWith("/control-plane/erasure"));
    expect([...new Set(mounted.map((route) => route.method))]).toEqual(["GET"]);
  });

  test("the summary says undeclared is relative to this Worker", () => {
    const migrations = (controlplane().adminRoutes ?? []).find((route) => route.path.endsWith("/migrations"));
    expect(migrations?.summary).toMatch(/relative to this Worker/);
  });

  test("the seam's migration keys are behind migrations:read, its hold count behind retention:read, and only pending is graded", () => {
    const keys = controlplane().health?.keys ?? [];
    expect(keys.map((key) => [key.key, key.scope, key.nominal])).toEqual([
      ["pendingMigrations", MIGRATIONS_READ_SCOPE, { atMost: 0 }],
      ["undeclaredMigrations", MIGRATIONS_READ_SCOPE, null],
      ["activeHolds", RETENTION_READ_SCOPE, null],
    ]);
  });

  test("retention:read guards only GETs, so connect offers it as a read; retention:hold only POSTs", () => {
    const advertised = controlplane().adminRoutes ?? [];
    expect(
      advertised
        .filter((route) => route.scope === RETENTION_READ_SCOPE)
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual(["GET /control-plane/holds"]);
    expect(
      advertised
        .filter((route) => route.scope === RETENTION_HOLD_SCOPE)
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual(["POST /control-plane/holds", "POST /control-plane/holds/:holdId/release"]);
  });

  test("no route shortens a retention: none takes a window, a duration or a deletion of a hold", () => {
    const app = makeApp();
    // Holds are the only retention surface, and they can only add a preservation or end one with a reason.
    expect(app.routes.some((route) => route.method === "DELETE")).toBe(false);
    for (const schema of [PlaceHoldRequest, ReleaseHoldRequest]) {
      const keys = Object.keys(schema.shape);
      expect(keys.filter((key) => /days|window|age|retention|purge|prune|after/i.test(key))).toEqual([]);
    }
  });
});

describe("control-plane route contract: every route is described for the OpenAPI contract", () => {
  const groups = () => [{ tag: "controlplane", routes: makeApp().routes }];

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes(groups())).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "controlplane", version: "0" }, groups());
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });

  test("GET /privacy names its response schema and the scope it needs", () => {
    const document = openApiDocument({ title: "controlplane", version: "0" }, groups());
    const operation = (document.paths as Record<string, Record<string, unknown>>)["/control-plane/privacy"]?.get as
      | { responses?: Record<string, unknown> }
      | undefined;
    expect(operation?.responses?.["200"]).toBeDefined();
    expect(JSON.stringify(operation)).toContain("privacy:read");
  });
});
