// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { describeRoute, type RouteSpec, routeSpecOf } from "./routeSpec";

const Ok = z.object({ ok: z.boolean().describe("Always true.") }).describe("A plain answer.");
const spec: RouteSpec = { summary: "Answer.", verification: "public", responses: { 200: Ok } };

describe("describeRoute", () => {
  test("passes the request straight on to the next handler", async () => {
    const app = new Hono();
    app.get("/", describeRoute(spec), (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("carries its spec, so a reader of the composed app can find it", () => {
    expect(routeSpecOf(describeRoute(spec))).toBe(spec);
  });

  test("any other handler carries none", () => {
    expect(routeSpecOf(async (_c: unknown, next: () => Promise<void>) => next())).toBeUndefined();
    expect(routeSpecOf(undefined)).toBeUndefined();
  });
});

/** An app whose request carries a signed-in user, and an acting organization whose role holds `held`. */
function gatedApp(held: readonly string[] | null, signedIn = true) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", signedIn ? { userId: "u1", sessionId: "s1", scopes: [] } : null);
    c.set("actingOrganization", async () =>
      held === null ? null : { organizationId: "o1", roleAllows: (power: string) => held.includes(power) },
    );
    await next();
  });
  app.get("/", describeRoute({ ...spec, power: "notes:read" }), (c) => c.json({ ok: true }));
  return app;
}

describe("describeRoute with a power", () => {
  test("lets a caller whose role holds the power through", async () => {
    const res = await gatedApp(["notes:read"]).request("/");
    expect(res.status).toBe(200);
  });

  test("refuses a caller whose role does not hold it, naming the power", async () => {
    const res = await gatedApp(["notes:write"]).request("/");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("notes:read");
  });

  test("refuses a caller with no organization in force, because nothing is held", async () => {
    expect((await gatedApp(null).request("/")).status).toBe(403);
  });

  test("refuses an anonymous caller with a 401, not a 403", async () => {
    expect((await gatedApp(["notes:read"], false).request("/")).status).toBe(401);
  });

  test("the gate and the declaration are one value, so they cannot differ", async () => {
    // The power the spec carries is the power the middleware gates on. Change one and the other moves with it.
    for (const power of ["notes:read", "notes:write", "billing:manage"]) {
      const middleware = describeRoute({ ...spec, power });
      expect(routeSpecOf(middleware)?.power).toBe(power);
      const app = new Hono<PithyHonoEnv>();
      app.onError(pithyErrorHandler);
      app.use("*", async (c, next) => {
        c.set("auth", { userId: "u1", sessionId: "s1", scopes: [] });
        c.set("actingOrganization", async () => ({ organizationId: "o1", roleAllows: (held) => held === power }));
        await next();
      });
      app.get("/", middleware, (c) => c.json({ ok: true }));
      expect((await app.request("/")).status).toBe(200);
      const other = new Hono<PithyHonoEnv>();
      other.onError(pithyErrorHandler);
      other.use("*", async (c, next) => {
        c.set("auth", { userId: "u1", sessionId: "s1", scopes: [] });
        c.set("actingOrganization", async () => ({ organizationId: "o1", roleAllows: (held) => held !== power }));
        await next();
      });
      other.get("/", middleware, (c) => c.json({ ok: true }));
      expect((await other.request("/")).status).toBe(403);
    }
  });

  test("a route with no power gates nothing", async () => {
    const app = new Hono();
    app.get("/", describeRoute(spec), (c) => c.json({ ok: true }));
    expect((await app.request("/")).status).toBe(200);
  });
});
