// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { ForbiddenError, ValidationError } from "../error/pithyError";
import { isRouteRateLimitBinding, RouteRateLimit, routeRateLimitBinding } from "./routeRateLimit";
import { describeRoute, type RouteSpec } from "./routeSpec";

const Ok = z.object({ ok: z.boolean().describe("Always true.") }).describe("A plain answer.");
const signedIn: RouteSpec = { summary: "Answer.", verification: ["bearer", "session"], responses: { 200: Ok } };

/** A Workers Rate Limiting binding in memory: `limit` calls per key, and every key it was asked about. */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    async limit({ key }: { key: string }) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

/** An app with one limited route, and a caller who is `user` (or nobody) arriving from `ip`. */
function limitedApp(rateLimit: RouteRateLimit, options: { verification?: RouteSpec["verification"] } = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-test-user");
    c.set("auth", user === undefined ? null : { userId: user, sessionId: "s", scopes: [] });
    await next();
  });
  app.post(
    "/runs",
    describeRoute({ ...signedIn, verification: options.verification ?? signedIn.verification, rateLimit }),
    (c) => c.json({ ok: true }),
  );
  app.post("/other", describeRoute({ ...signedIn, rateLimit }), (c) => c.json({ ok: true }));
  return app;
}

function send(
  app: Hono<PithyHonoEnv>,
  env: Record<string, unknown>,
  headers: Record<string, string>,
  path = "/runs",
): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "POST", headers }, env));
}

describe("RouteRateLimit", () => {
  test("takes a key, a whole positive limit, and a period of 10 or 60 seconds", () => {
    expect(RouteRateLimit.parse({ key: "user", limit: 20, period: 60 })).toEqual({
      key: "user",
      limit: 20,
      period: 60,
    });
    expect(() => RouteRateLimit.parse({ key: "user", limit: 0, period: 60 })).toThrow();
    expect(() => RouteRateLimit.parse({ key: "user", limit: 2.5, period: 60 })).toThrow();
    expect(() => RouteRateLimit.parse({ key: "user", limit: 5, period: 30 })).toThrow();
    expect(() => RouteRateLimit.parse({ key: "session", limit: 5, period: 10 })).toThrow();
  });

  test("describeRoute refuses a limit Cloudflare would refuse, before any request", () => {
    expect(() => describeRoute({ ...signedIn, rateLimit: { key: "ip", limit: 5, period: 30 as 60 } })).toThrow(
      ValidationError,
    );
  });
});

describe("routeRateLimitBinding", () => {
  test("names one binding per limit and period, so routes declaring the same policy share it", () => {
    expect(routeRateLimitBinding({ limit: 20, period: 60 })).toBe("ROUTE_RATE_LIMIT_20_PER_60S");
    expect(routeRateLimitBinding({ limit: 5, period: 10 })).toBe("ROUTE_RATE_LIMIT_5_PER_10S");
  });

  test("recognizes its own names and nobody else's", () => {
    expect(isRouteRateLimitBinding("ROUTE_RATE_LIMIT_20_PER_60S")).toBe(true);
    expect(isRouteRateLimitBinding("AUTH_RATE_LIMITER")).toBe(false);
    expect(isRouteRateLimitBinding("ROUTE_RATE_LIMIT_MINE")).toBe(false);
  });
});

describe("the gate describeRoute installs", () => {
  test("a user limit refuses that user past the limit with 429, and leaves another user alone", async () => {
    const limiter = fakeLimiter(2);
    const app = limitedApp({ key: "user", limit: 2, period: 60 });
    const env = { ROUTE_RATE_LIMIT_2_PER_60S: limiter };
    const ada = { "x-test-user": "ada", "cf-connecting-ip": "203.0.113.1" };
    expect((await send(app, env, ada)).status).toBe(200);
    expect((await send(app, env, ada)).status).toBe(200);
    const refused = await send(app, env, ada);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("rate_limit/exceeded");
    // Same address, another user: a user limit counts users, not addresses.
    expect((await send(app, env, { "x-test-user": "grace", "cf-connecting-ip": "203.0.113.1" })).status).toBe(200);
  });

  test("an ip limit counts addresses, whoever is signed in", async () => {
    const limiter = fakeLimiter(1);
    const app = limitedApp({ key: "ip", limit: 1, period: 10 });
    const env = { ROUTE_RATE_LIMIT_1_PER_10S: limiter };
    expect((await send(app, env, { "x-test-user": "ada", "cf-connecting-ip": "203.0.113.1" })).status).toBe(200);
    expect((await send(app, env, { "x-test-user": "grace", "cf-connecting-ip": "203.0.113.1" })).status).toBe(429);
    expect((await send(app, env, { "x-test-user": "grace", "cf-connecting-ip": "203.0.113.2" })).status).toBe(200);
  });

  test("two routes sharing one binding keep two budgets, because the key names the route", async () => {
    const limiter = fakeLimiter(1);
    const app = limitedApp({ key: "user", limit: 1, period: 60 });
    const env = { ROUTE_RATE_LIMIT_1_PER_60S: limiter };
    const ada = { "x-test-user": "ada" };
    expect((await send(app, env, ada, "/runs")).status).toBe(200);
    expect((await send(app, env, ada, "/other")).status).toBe(200);
    expect([...limiter.keys.keys()]).toEqual(["POST /runs user:ada", "POST /other user:ada"]);
  });

  test("a HEAD spends the GET route's budget, because Hono answers it by running the GET route", async () => {
    const limiter = fakeLimiter(2);
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    app.use("*", async (c, next) => {
      c.set("auth", { userId: "ada", sessionId: "s", scopes: [] });
      await next();
    });
    app.get("/runs", describeRoute({ ...signedIn, rateLimit: { key: "user", limit: 2, period: 60 } }), (c) =>
      c.json({ ok: true }),
    );
    const env = { ROUTE_RATE_LIMIT_2_PER_60S: limiter };
    expect((await app.request("/runs", { method: "GET" }, env)).status).toBe(200);
    expect((await app.request("/runs", { method: "GET" }, env)).status).toBe(200);
    expect((await app.request("/runs", { method: "HEAD" }, env)).status).toBe(429);
    expect([...limiter.keys.keys()]).toEqual(["GET /runs user:ada"]);
  });

  test("a user limit lets an unsigned caller on to the guard below, counting nothing, so the guard's answer stands", async () => {
    const limiter = fakeLimiter(5);
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    app.use("*", async (c, next) => {
      c.set("auth", null);
      await next();
    });
    // Stands in for a guard that answers a suspended account with its own 403 rather than a bare 401.
    const guard: MiddlewareHandler<PithyHonoEnv> = async () => {
      throw new ForbiddenError({ message: "This account is suspended." });
    };
    app.post("/runs", describeRoute({ ...signedIn, rateLimit: { key: "user", limit: 5, period: 60 } }), guard, (c) =>
      c.json({ ok: true }),
    );
    const res = await send(app, { ROUTE_RATE_LIMIT_5_PER_60S: limiter }, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("This account is suspended.");
    expect(limiter.keys.size).toBe(0);
  });

  test("a missing binding is a fault naming it and the command that writes it, never an unlimited route", async () => {
    const app = limitedApp({ key: "ip", limit: 5, period: 60 });
    const res = await send(app, {}, { "cf-connecting-ip": "203.0.113.1" });
    expect(res.status).toBe(500);
  });
});
