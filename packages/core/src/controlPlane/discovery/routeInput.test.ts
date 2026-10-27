// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validate } from "../../http/validation";
import type { CapabilityDeclaration } from "./adminRoute";
import { routeInputs, withRouteInputs } from "./routeInput";

const ThreadParam = z.object({ id: z.string().describe("The thread.") }).describe("Which thread.");
const ListQuery = z.object({ q: z.string().optional().describe("Search text.") }).describe("Filters.");
const ReplyBody = z.object({ text: z.string().describe("The reply.") }).describe("The reply to send.");

function groupsOf(register: (app: Hono) => void) {
  const app = new Hono();
  register(app);
  return [{ tag: "support", routes: app.routes }];
}

describe("routeInputs", () => {
  test("a route's path, query and body validators become one object, each under its own key", () => {
    const groups = groupsOf((app) => {
      app.post("/support/threads/:id/reply", validate("param", ThreadParam), validate("json", ReplyBody), (c) =>
        c.text("ok"),
      );
    });
    const input = routeInputs(groups).get("POST /support/threads/:id/reply");
    expect(input).toMatchObject({
      type: "object",
      required: ["path", "body"],
      additionalProperties: false,
      properties: {
        path: { type: "object", properties: { id: { type: "string", description: "The thread." } } },
        body: { type: "object", properties: { text: { type: "string", description: "The reply." } } },
      },
    });
    expect(Object.keys((input as { properties: object }).properties)).toEqual(["path", "body"]);
  });

  test("a query whose every field is optional is not required, and a route with no validator takes nothing", () => {
    const groups = groupsOf((app) => {
      app.get("/support/threads", validate("query", ListQuery), (c) => c.text("ok"));
      app.get("/control-plane/ping", (c) => c.text("pong"));
    });
    const inputs = routeInputs(groups);
    expect(inputs.get("GET /support/threads")).toMatchObject({ properties: { query: { type: "object" } } });
    expect(inputs.get("GET /support/threads")).not.toHaveProperty("required");
    expect(inputs.get("GET /control-plane/ping")).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("withRouteInputs", () => {
  const declaration: CapabilityDeclaration = {
    name: "support",
    version: "0.1.0",
    package: "@pithy-sh/support",
    adminRoutes: [
      { method: "GET", path: "/support/threads", scope: "support:threads:read", summary: "List.", operation: "x" },
      { method: "GET", path: "/support/elsewhere", scope: "support:threads:read", summary: "Gone." },
    ],
    healthKeys: [],
    configKeys: [],
    config: {},
  };

  test("fills each routed admin route's input, and leaves one the router does not hold without", () => {
    const inputs = new Map([["GET /support/threads", { type: "object", properties: {} }]]);
    const [filled] = withRouteInputs([declaration], inputs);
    expect(filled?.adminRoutes[0]?.input).toEqual({ type: "object", properties: {} });
    expect(filled?.adminRoutes[0]?.operation).toBe("x");
    expect(filled?.adminRoutes[1]).not.toHaveProperty("input");
  });

  test("an app createBackend did not assemble has no groups, and the declarations go out unchanged", () => {
    expect(withRouteInputs([declaration], undefined)).toEqual([declaration]);
  });
});
