// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { describeRoute } from "../http/routeSpec";
import { describedOperations } from "./operations";

const spec = { summary: "Read one.", verification: "public", responses: {} } as const;

function routesOf(register: (app: Hono) => void): Hono["routes"] {
  const app = new Hono();
  register(app);
  return app.routes;
}

describe("describedOperations", () => {
  test("one entry per method and path, carrying the spec its describeRoute declared", () => {
    const routes = routesOf((app) => {
      app.get("/one", describeRoute(spec), (c) => c.text("one"));
    });
    expect(describedOperations([{ tag: "t", routes }])).toEqual([{ method: "GET", path: "/one", spec }]);
  });

  test("a route with no describeRoute is listed with no spec, so a reader can name it", () => {
    const routes = routesOf((app) => {
      app.post("/bare", (c) => c.text("bare"));
    });
    expect(describedOperations([{ tag: "t", routes }])).toEqual([{ method: "POST", path: "/bare", spec: undefined }]);
  });

  test("middleware is not a route: an undescribed ALL entry is left out, a described one is kept", () => {
    const routes = routesOf((app) => {
      app.use("*", async (_c, next) => next());
      app.all("/any", describeRoute(spec), (c) => c.text("any"));
    });
    expect(describedOperations([{ tag: "t", routes }])).toEqual([{ method: "ALL", path: "/any", spec }]);
  });

  test("every group is walked, in order", () => {
    const first = routesOf((app) => {
      app.get("/a", describeRoute(spec), (c) => c.text("a"));
    });
    const second = routesOf((app) => {
      app.get("/b", (c) => c.text("b"));
    });
    expect(
      describedOperations([
        { tag: "one", routes: first },
        { tag: "two", routes: second },
      ]).map((operation) => operation.path),
    ).toEqual(["/a", "/b"]);
  });
});
