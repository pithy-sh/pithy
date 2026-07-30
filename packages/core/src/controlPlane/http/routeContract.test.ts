import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { PithyHonoEnv } from "../../capability/capability";
import { pathParams, uncoveredParamRoutes } from "../../http/routeContract";
import { type ControlPlaneOptions, controlplane } from "../capability";

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
      `These control-plane routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/controlPlane/http/schemas.ts:\n${uncovered
        .map((route) => `  ${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real control-plane routes, not an empty app", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);
    const paths = [...new Set(app.routes.map((route) => route.path))].sort();
    // Every route this seam serves. The list is what makes adding a sixth a deliberate edit rather than
    // a surprise, and it is the only place a control-plane route can be counted.
    expect(paths).toEqual([
      "/control-plane/keys",
      "/control-plane/keys/:keyId/expire",
      "/control-plane/manifest",
      "/control-plane/ping",
    ]);
    // The one param-carrying path, named exactly. Without this the check above would pass on an app
    // that declared no params at all, which proves nothing.
    expect(paramPaths(app)).toEqual(["/control-plane/keys/:keyId/expire"]);
  });

  test("mounts under the configured basePath, every route included", () => {
    // A basePath that moved only some routes would leave a management client half-connected: the seam
    // it can reach would work and the one it cannot would 404, with nothing saying why.
    const app = makeApp({ basePath: "/admin/cp" });
    expect([...new Set(app.routes.map((route) => route.path))].every((path) => path.startsWith("/admin/cp/"))).toBe(
      true,
    );
    expect(paramPaths(app)).toEqual(["/admin/cp/keys/:keyId/expire"]);
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
    expect(handlerCounts.size).toBe(5);
    for (const [route, count] of handlerCounts) expect(count, `${route} has no guard`).toBeGreaterThan(1);
  });
});
