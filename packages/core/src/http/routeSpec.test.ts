// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
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
