// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { createBackend } from "../createBackend";
import { describeRoute } from "../http/routeSpec";
import { openApiDocument, undescribedFields, undescribedRoutes } from "./document";
import { recordRouteGroups, routeGroupsOf } from "./routeGroups";

const Pong = z.object({ pong: z.boolean().describe("Always true.") }).describe("A pong.");

const ping = defineCapability({
  name: "ping",
  requiredBindings: [],
  routes: (app) => {
    app.get("/ping", describeRoute({ summary: "Ping.", verification: "public", responses: { 200: Pong } }), (c) =>
      c.json({ pong: true }),
    );
  },
});

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (hono) => {
    hono.get("/mine", (c) => c.text("undescribed"));
  },
});

describe("routeGroupsOf", () => {
  test("is what createBackend recorded: health under core, then each capability's own routes", () => {
    const backend = createBackend({ capabilities: [ping], app });
    const groups = routeGroupsOf(backend) ?? [];
    // Hono keeps one entry per handler, so a route with a describeRoute ahead of its handler appears twice.
    const routes = (group: (typeof groups)[number]) => [
      ...new Set(group.routes.map((route) => `${route.method} ${route.path}`)),
    ];
    expect(groups.map((group) => [group.tag, routes(group)])).toEqual([
      ["core", ["GET /health"]],
      ["ping", ["GET /ping"]],
      ["app", ["GET /mine"]],
    ]);
  });

  test("feeds a contract that describes health and every capability, and names what it cannot describe", () => {
    const groups = routeGroupsOf(createBackend({ capabilities: [ping], app })) ?? [];
    const document = openApiDocument({ title: "t", version: "0" }, groups);
    expect(Object.keys(document.paths)).toEqual(["/health", "/ping"]);
    expect(undescribedFields(document)).toEqual([]);
    expect(undescribedRoutes(groups)).toEqual([{ method: "GET", path: "/mine" }]);
  });

  test("an app createBackend did not assemble has none", () => {
    expect(routeGroupsOf(new Hono())).toBeUndefined();
  });

  test("the last record wins, it is the app's own, and the app has no enumerable mark", () => {
    const hono = new Hono();
    const keys = Reflect.ownKeys(hono).filter((key) => Object.getOwnPropertyDescriptor(hono, key)?.enumerable);
    recordRouteGroups(hono, [{ tag: "one", routes: [] }]);
    recordRouteGroups(hono, [{ tag: "two", routes: [] }]);
    expect(routeGroupsOf(hono)?.map((group) => group.tag)).toEqual(["two"]);
    expect(routeGroupsOf(Object.create(hono))).toBeUndefined();
    expect(Reflect.ownKeys(hono).filter((key) => Object.getOwnPropertyDescriptor(hono, key)?.enumerable)).toEqual(keys);
  });

  test("a frozen app records its groups too, and the last record wins", () => {
    const hono = Object.freeze(new Hono());
    recordRouteGroups(hono, [{ tag: "one", routes: [] }]);
    recordRouteGroups(hono, [{ tag: "two", routes: [] }]);
    expect(routeGroupsOf(hono)?.map((group) => group.tag)).toEqual(["two"]);
  });

  test("an app frozen after its first record takes the next", () => {
    const hono = new Hono();
    recordRouteGroups(hono, [{ tag: "one", routes: [] }]);
    Object.freeze(hono);
    recordRouteGroups(hono, [{ tag: "two", routes: [] }]);
    expect(routeGroupsOf(hono)?.map((group) => group.tag)).toEqual(["two"]);
  });

  test("an app one copy of core assembles has the route groups another copy reads", async () => {
    vi.resetModules();
    const other = {
      capability: await import("../capability/capability"),
      backend: await import("../createBackend"),
      groups: await import("./routeGroups"),
    };
    expect(other.groups.routeGroupsOf).not.toBe(routeGroupsOf);
    expect(other.backend.createBackend).not.toBe(createBackend);
    const mine = other.capability.defineCapability({
      name: "mine",
      requiredBindings: [],
      routes: (hono) => {
        hono.get("/mine", (c) => c.text("ok"));
      },
    });

    const groups = routeGroupsOf(other.backend.createBackend({ capabilities: [mine], app })) ?? [];

    expect(groups.map((group) => group.tag)).toEqual(["core", "mine", "app"]);
  });
});
