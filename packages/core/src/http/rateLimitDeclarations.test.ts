// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ValidationError } from "../error/pithyError";
import type { RouteGroup } from "../openapi/document";
import { assertRateLimitDeclarations, routeRateLimitBindings } from "./rateLimitDeclarations";
import { describeRoute, type RouteSpec } from "./routeSpec";

const Ok = z.object({ ok: z.boolean().describe("Always true.") }).describe("A plain answer.");
const signedIn: RouteSpec = { summary: "Answer.", verification: ["bearer", "session"], responses: { 200: Ok } };

/** A group made the way `createBackend` makes one. */
function group(tag: string, register: (app: Hono) => void): RouteGroup {
  const app = new Hono();
  register(app);
  return { tag, routes: app.routes };
}

describe("routeRateLimitBindings", () => {
  test("is every distinct policy the routes declare, once each, in name order", () => {
    const groups = [
      group("app", (app) => {
        app.post("/a", describeRoute({ ...signedIn, rateLimit: { key: "user", limit: 20, period: 60 } }), (c) =>
          c.text(""),
        );
        app.post("/b", describeRoute({ ...signedIn, rateLimit: { key: "ip", limit: 20, period: 60 } }), (c) =>
          c.text(""),
        );
        app.post("/c", describeRoute({ ...signedIn, rateLimit: { key: "ip", limit: 100, period: 10 } }), (c) =>
          c.text(""),
        );
        app.get("/d", describeRoute(signedIn), (c) => c.text(""));
      }),
    ];
    expect(routeRateLimitBindings(groups)).toEqual([
      { name: "ROUTE_RATE_LIMIT_100_PER_10S", limit: 100, period: 10 },
      { name: "ROUTE_RATE_LIMIT_20_PER_60S", limit: 20, period: 60 },
    ]);
  });

  test("is empty when no route declares a limit", () => {
    expect(
      routeRateLimitBindings([group("app", (app) => app.get("/", describeRoute(signedIn), (c) => c.text("")))]),
    ).toEqual([]);
  });
});

describe("assertRateLimitDeclarations", () => {
  test("refuses a user limit on a route that admits a caller nobody signed in, naming the route", () => {
    const groups = [
      group("games", (app) => {
        app.post(
          "/games/:id/runs",
          describeRoute({ ...signedIn, verification: "public", rateLimit: { key: "user", limit: 5, period: 60 } }),
          (c) => c.text(""),
        );
      }),
    ];
    expect(() => assertRateLimitDeclarations(groups)).toThrow(/POST \/games\/:id\/runs/);
    expect(() => assertRateLimitDeclarations(groups)).toThrow(ValidationError);
  });

  test("refuses one whose verification mixes a signed-in strategy with an open one", () => {
    const groups = [
      group("games", (app) => {
        app.post(
          "/runs",
          describeRoute({
            ...signedIn,
            verification: ["session", "public"],
            rateLimit: { key: "user", limit: 5, period: 60 },
          }),
          (c) => c.text(""),
        );
      }),
    ];
    expect(() => assertRateLimitDeclarations(groups)).toThrow(/POST \/runs/);
  });

  test("accepts a user limit on a signed-in route, and an ip limit on an open one", () => {
    const groups = [
      group("games", (app) => {
        app.post("/a", describeRoute({ ...signedIn, rateLimit: { key: "user", limit: 5, period: 60 } }), (c) =>
          c.text(""),
        );
        app.post(
          "/b",
          describeRoute({ ...signedIn, verification: "public", rateLimit: { key: "ip", limit: 5, period: 60 } }),
          (c) => c.text(""),
        );
      }),
    ];
    expect(() => assertRateLimitDeclarations(groups)).not.toThrow();
  });
});
