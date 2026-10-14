// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { createBackend } from "../createBackend";
import { describeRoute } from "../http/routeSpec";
import { openApiDocument, undescribedFields, undescribedRoutes } from "./document";
import { routeGroupsOf } from "./routeGroups";

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
});
