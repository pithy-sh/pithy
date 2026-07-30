// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { UnauthorizedError } from "../error/pithyError";
import { pathParams, uncoveredParamRoutes } from "./routeContract";
import { validationHook } from "./validation";

const Id = z.object({ id: z.string().min(1).max(8).describe("A record id.") }).describe("Path params.");
const Body = z.object({ n: z.number().describe("A number.") }).describe("A body.");
const Query = z.object({ q: z.string().describe("A term.") }).describe("A query.");

/** The house guard shape: rejects when there is no AuthContext. Probing must not mistake it for a validator. */
const requireAuth = () => async (c: { var: { auth?: unknown } }, next: () => Promise<void>) => {
  if (!c.var.auth) throw new UnauthorizedError();
  await next();
};

function app() {
  return new Hono() as unknown as Hono<never>;
}

describe("pathParams", () => {
  test("names every :segment, in order", () => {
    expect(pathParams("/leaderboard/:board/entries/:userId")).toEqual(["board", "userId"]);
  });

  test("a path with no params has none", () => {
    expect(pathParams("/health")).toEqual([]);
  });

  test("a wildcard is not a param", () => {
    expect(pathParams("/auth/*")).toEqual([]);
  });
});

describe("uncoveredParamRoutes", () => {
  test("a param route with a param validator is covered", async () => {
    const a = app();
    a.get("/x/:id", zValidator("param", Id, validationHook), (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([]);
  });

  test("a param route with NO validator is reported, with its param names", async () => {
    const a = app();
    a.get("/x/:id/:rev", (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([{ method: "GET", path: "/x/:id/:rev", params: ["id", "rev"] }]);
  });

  test("a json validator does not count as param coverage", async () => {
    const a = app();
    a.post("/x/:id", zValidator("json", Body, validationHook), (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([{ method: "POST", path: "/x/:id", params: ["id"] }]);
  });

  test("a query validator does not count as param coverage either", async () => {
    const a = app();
    a.get("/x/:id", zValidator("query", Query, validationHook), (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([{ method: "GET", path: "/x/:id", params: ["id"] }]);
  });

  test("a guard ahead of the validator does not hide it", async () => {
    const a = app();
    a.get("/x/:id", requireAuth(), zValidator("param", Id, validationHook), (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([]);
  });

  test("a guard alone is not mistaken for a validator", async () => {
    const a = app();
    a.get("/x/:id", requireAuth(), (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([{ method: "GET", path: "/x/:id", params: ["id"] }]);
  });

  test("paths without params are never reported", async () => {
    const a = app();
    a.get("/health", (c) => c.text("ok"));
    a.all("/auth/*", (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([]);
  });

  test("each method on one path is judged on its own registrations", async () => {
    const a = app();
    a.get("/x/:id", zValidator("param", Id, validationHook), (c) => c.text("ok"));
    a.delete("/x/:id", (c) => c.text("ok"));
    expect(await uncoveredParamRoutes(a)).toEqual([{ method: "DELETE", path: "/x/:id", params: ["id"] }]);
  });

  test("the terminal handler is never probed — its body must not run", async () => {
    const a = app();
    let ran = false;
    a.get("/x/:id", zValidator("param", Id, validationHook), (c) => {
      ran = true;
      return c.text("ok");
    });
    await uncoveredParamRoutes(a);
    expect(ran).toBe(false);
  });
});
