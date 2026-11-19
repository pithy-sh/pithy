// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import {
  type CapabilityRoutes,
  declaredRoutesOf,
  declareRoutes,
  mountLazy,
  type RouteMount,
  routeDrift,
  routesOf,
} from "./lazyRoutes";
import { describeRoute } from "./routeSpec";
import { validate } from "./validation";

const ThingParams = z.object({ id: z.string().describe("The thing's id.") }).describe("A thing's address.");
const ThingBody = z.record(z.string(), z.number()).describe("Any numbers, echoed back.");

/** A group with a parameterized read, a body-reading write, a throwing route and a header of its own. */
const things: RouteMount = (app) => {
  app.get(
    "/api/things/:id",
    describeRoute({ summary: "Read a thing.", verification: "public", responses: { 200: { description: "It." } } }),
    validate("param", ThingParams),
    (c) => c.json({ id: c.req.valid("param").id, seen: c.get("log") === undefined ? null : "log" }),
  );
  app.post(
    "/api/things",
    describeRoute({ summary: "Echo.", verification: "public", responses: { 201: { description: "It." } } }),
    validate("json", ThingBody),
    (c) => c.json({ echoed: c.req.valid("json") }, 201),
  );
  app.get("/api/broken", () => {
    throw new TypeError("inner fault");
  });
  app.get("/api/marks", (c) => {
    c.header("x-inner", "1");
    c.header("set-cookie", "inner=1", { append: true });
    return c.text("marked");
  });
};

const DECLARED = declareRoutes("/api", [
  ["GET", "/things/:id"],
  ["POST", "/things"],
  ["GET", "/broken"],
  ["GET", "/marks"],
]);

function routes(load: CapabilityRoutes["load"] = async () => things): CapabilityRoutes {
  return { declared: DECLARED, load };
}

/** An outer app shaped like `createBackend`'s: a base middleware publishing vars and a header, an error handler. */
function outer(mount: (app: Hono<PithyHonoEnv>) => void): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError((err, c) => c.json({ outerError: err.message }, 500));
  app.use("*", async (c, next) => {
    c.set("log", { marker: "outer" } as unknown as PithyHonoEnv["Variables"]["log"]);
    await next();
  });
  mount(app);
  app.notFound((c) => c.text("outer not found", 404));
  return app;
}

const lazily =
  (spec: CapabilityRoutes = routes()) =>
  (app: Hono<PithyHonoEnv>) => {
    mountLazy(app, spec, { composed: app });
  };

describe("mountLazy", () => {
  it("registers the declared table and loads nothing at mount", () => {
    const load = vi.fn(async () => things);
    const app = new Hono<PithyHonoEnv>();
    mountLazy(app, routes(load), { composed: app });
    expect(load).not.toHaveBeenCalled();
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /api/things/:id",
      "POST /api/things",
      "GET /api/broken",
      "GET /api/marks",
    ]);
  });

  it("loads the module on its first request, once", async () => {
    const load = vi.fn(async () => things);
    const app = outer(lazily(routes(load)));
    await app.request("/api/things/1");
    await app.request("/api/things/2");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("builds once when the first requests arrive together", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return things;
    });
    const mount = vi.fn();
    const app = outer(
      lazily({
        declared: DECLARED,
        load: async () => {
          const loaded = await load();
          return (inner, host) => {
            mount();
            loaded(inner, host);
          };
        },
      }),
    );
    const pending = Promise.all([1, 2, 3, 4, 5].map((n) => app.request(`/api/things/${n}`)));
    release?.();
    const responses = await pending;
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("loads nothing for a request elsewhere", async () => {
    const load = vi.fn(async () => things);
    const res = await outer(lazily(routes(load))).request("/api/elsewhere");
    expect(res.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  it("answers exactly as the eager mount does", async () => {
    const lazy = outer(lazily());
    const eager = outer((app) => things(app, { composed: app }));
    for (const [path, init] of [
      ["/api/things/abc", undefined],
      [
        "/api/things",
        { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } },
      ],
      ["/api/things", { method: "POST", body: "not json", headers: { "content-type": "application/json" } }],
      ["/api/marks", undefined],
      ["/api/broken", undefined],
    ] as const) {
      const [a, b] = [await lazy.request(path, init), await eager.request(path, init)];
      expect({ path, status: a.status, body: await a.text(), inner: a.headers.get("x-inner") }).toEqual({
        path,
        status: b.status,
        body: await b.text(),
        inner: b.headers.get("x-inner"),
      });
    }
  });

  it("runs the Worker's middleware before the module has loaded, and a refusal there never loads it", async () => {
    const order: string[] = [];
    const load = vi.fn(async () => {
      order.push("load");
      return things;
    });
    const app = new Hono<PithyHonoEnv>();
    app.use("*", async (c, next) => {
      order.push("guard");
      if (c.req.header("authorization") === undefined) return c.json({ refused: true }, 401);
      await next();
    });
    mountLazy(app, routes(load), { composed: app });
    expect((await app.request("/api/things/1")).status).toBe(401);
    expect(load).not.toHaveBeenCalled();
    expect((await app.request("/api/things/1", { headers: { authorization: "yes" } })).status).toBe(200);
    expect(order).toEqual(["guard", "guard", "load"]);
  });

  it("keeps the headers the Worker's middleware set before the route, cookies included", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.use("*", async (c, next) => {
      c.header("access-control-allow-origin", "https://dash.example.com");
      c.header("vary", "Origin", { append: true });
      c.header("set-cookie", "outer=1", { append: true });
      await next();
    });
    mountLazy(app, routes(), { composed: app });
    const res = await app.request("/api/marks");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("x-inner")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual(["outer=1", "inner=1"]);
  });

  it("keeps the Worker's headers on a request the module answers nothing for", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.use("*", async (c, next) => {
      c.header("access-control-allow-origin", "https://dash.example.com");
      await next();
    });
    mountLazy(
      app,
      { declared: [{ method: "GET", path: "/api/missing" }], load: async () => things },
      { composed: app },
    );
    app.notFound((c) => c.text("outer not found", 404));
    const res = await app.request("/api/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
  });

  it("keeps the headers the module set ahead of an error the Worker's handler answers", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.onError((err, c) => c.json({ outerError: err.message }, 500));
    app.use("*", async (c, next) => {
      c.header("vary", "Origin", { append: true });
      c.header("set-cookie", "outer=1", { append: true });
      await next();
    });
    mountLazy(
      app,
      {
        declared: [{ method: "GET", path: "/stamped" }],
        load: async () => (inner) => {
          inner.get(
            "/stamped",
            async (c, next) => {
              c.header("x-build", "v-1");
              c.header("vary", "Accept", { append: true });
              c.header("set-cookie", "inner=1", { append: true });
              await next();
            },
            () => {
              throw new TypeError("refused");
            },
          );
        },
      },
      { composed: app },
    );
    const res = await app.request("/stamped");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-build")).toBe("v-1");
    expect(res.headers.get("vary")).toBe("Origin, Accept");
    expect(res.headers.getSetCookie()).toEqual(["outer=1", "inner=1"]);
  });

  it("hands an error in the module to the Worker's error handler", async () => {
    const res = await outer(lazily()).request("/api/broken");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ outerError: "inner fault" });
  });

  it("shares context variables both ways", async () => {
    const LOCALE = { marker: "es" } as unknown as PithyHonoEnv["Variables"]["locale"];
    const app = new Hono<PithyHonoEnv>();
    let after: unknown;
    app.use("*", async (c, next) => {
      c.set("locale", LOCALE);
      await next();
      after = c.get("t");
    });
    mountLazy(
      app,
      {
        declared: [{ method: "GET", path: "/v" }],
        load: async () => (inner) => {
          inner.get("/v", (c) => {
            c.set("t", "from inner" as unknown as PithyHonoEnv["Variables"]["t"]);
            return c.text(c.get("locale") === LOCALE ? "es" : "missing");
          });
        },
      },
      { composed: app },
    );
    expect(await (await app.request("/v")).text()).toBe("es");
    expect(after).toBe("from inner");
  });

  it("sets a variable on the Worker's context as the module sets it, for a closure over that context", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.use("*", async (c, next) => {
      c.set("actingOrganization", async () =>
        c.var.auth === null ? null : { organizationId: "org", roleAllows: () => true },
      );
      c.set("auth", null);
      await next();
    });
    mountLazy(
      app,
      {
        declared: [{ method: "GET", path: "/acting" }],
        load: async () => (inner) => {
          inner.get("/acting", async (c) => {
            c.set("auth", { userId: "u1", sessionId: "s1", scopes: [], locale: null });
            const acting = await c.var.actingOrganization();
            return c.text(acting?.organizationId ?? "none");
          });
        },
      },
      { composed: app },
    );
    expect(await (await app.request("/acting")).text()).toBe("org");
  });

  it("falls through to the Worker when the module does not answer a declared route", async () => {
    const app = outer(lazily({ declared: [{ method: "GET", path: "/api/missing" }], load: async () => things }));
    const res = await app.request("/api/missing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("outer not found");
  });

  it("dispatches into the module once when two declared patterns match one request", async () => {
    const hits = vi.fn();
    const app = outer(
      lazily({
        declared: [
          { method: "GET", path: "/a/fixed" },
          { method: "GET", path: "/a/:any" },
        ],
        load: async () => (inner) => {
          inner.use("*", async (_c, next) => {
            hits();
            await next();
          });
          inner.get("/a/elsewhere", (c) => c.text("no"));
        },
      }),
    );
    expect((await app.request("/a/fixed")).status).toBe(404);
    expect(hits).toHaveBeenCalledTimes(1);
  });

  it("tries a failed load again on the next request", async () => {
    const load = vi
      .fn<CapabilityRoutes["load"]>()
      .mockRejectedValueOnce(new TypeError("chunk failed"))
      .mockResolvedValue(things);
    const app = outer(lazily(routes(load)));
    expect((await app.request("/api/things/1")).status).toBe(500);
    expect((await app.request("/api/things/1")).status).toBe(200);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hands the mount the Worker's composed app", async () => {
    let seen: unknown;
    const app = new Hono<PithyHonoEnv>();
    const mounted = mountLazy(
      app,
      {
        declared: [],
        load: async () => (_inner, host) => {
          seen = host.composed;
        },
      },
      { composed: app },
    );
    await mounted.routes();
    expect(seen).toBe(app);
  });

  it("resolves to the routes the module registered, its crossing aside", async () => {
    const app = new Hono<PithyHonoEnv>();
    const mounted = mountLazy(app, routes(), { composed: app });
    expect(declaredRoutesOf(await mounted.routes())).toEqual(DECLARED);
  });
});

describe("declaredRoutesOf", () => {
  it("declares middleware as ALL at its path, once beside a described app.all at the same path", () => {
    const app = new Hono<PithyHonoEnv>();
    app.use("/auth/*", async (_c, next) => next());
    app.all(
      "/auth/*",
      describeRoute({ summary: "All of it.", verification: "public", responses: { 200: { description: "It." } } }),
      (c) => c.text("ok"),
    );
    app.on("HEAD", "/x", (c) => c.body(null));
    expect(declaredRoutesOf(app.routes)).toEqual([
      { method: "ALL", path: "/auth/*" },
      { method: "HEAD", path: "/x" },
    ]);
  });
});

describe("declaredRoutesOf, for middleware alone", () => {
  it("declares a lone app.use as an ALL route, so a request it runs for enters the capability", () => {
    const app = new Hono<PithyHonoEnv>();
    app.use("/api/*", async (_c, next) => next());
    app.get("/api/ping", (c) => c.text("pong"));
    expect(declaredRoutesOf(app.routes)).toEqual([
      { method: "ALL", path: "/api/*" },
      { method: "GET", path: "/api/ping" },
    ]);
  });
});

describe("routeDrift", () => {
  it("is empty when the table matches the module", async () => {
    expect(await routeDrift(routes())).toEqual({ undeclared: [], unmounted: [] });
  });

  it("names an app.use the table does not cover, so its middleware cannot silently stop running", async () => {
    const guarded: RouteMount = (inner) => {
      inner.use("/api/*", async (_c, next) => next());
      inner.get("/api/ping", (c) => c.text("pong"));
    };
    expect(await routeDrift({ declared: [{ method: "GET", path: "/api/ping" }], load: async () => guarded })).toEqual({
      undeclared: [{ method: "ALL", path: "/api/*" }],
      unmounted: [],
    });
  });

  it("accepts an app.use under a declared ALL wildcard", async () => {
    const guarded: RouteMount = (inner) => {
      inner.use("/auth/sign-in", async (_c, next) => next());
      inner.all("/auth/*", (c) => c.text("auth"));
    };
    expect(await routeDrift({ declared: [{ method: "ALL", path: "/auth/*" }], load: async () => guarded })).toEqual({
      undeclared: [],
      unmounted: [],
    });
  });

  it("names a route the table misses and one the module does not mount", async () => {
    const drift = await routeDrift({
      declared: [...DECLARED.slice(1), { method: "DELETE", path: "/api/things/:id" }],
      load: async () => things,
    });
    expect(drift).toEqual({
      undeclared: [{ method: "GET", path: "/api/things/:id" }],
      unmounted: [{ method: "DELETE", path: "/api/things/:id" }],
    });
  });
});

describe("routesOf", () => {
  it("reads the table off the mount each time it is asked, so a mount that reads its composition declares that", async () => {
    let flag = false;
    const routes = routesOf((app) => {
      app.get("/always", (c) => c.text("ok"));
      if (flag) app.get("/flagged", (c) => c.text("ok"));
    });
    expect(routes.declared).toEqual([{ method: "GET", path: "/always" }]);
    flag = true;
    expect(routes.declared).toEqual([
      { method: "GET", path: "/always" },
      { method: "GET", path: "/flagged" },
    ]);
    expect(await routeDrift(routes)).toEqual({ undeclared: [], unmounted: [] });
  });
});
