import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { defineCapability } from "./capability/capability";
import { createBackend } from "./createBackend";

describe("createBackend", () => {
  test('serves GET /health with 200 { status: "ok" }', async () => {
    const app = createBackend({ capabilities: [] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("mounts a capability's routes", async () => {
    const ping = defineCapability({
      name: "ping",
      requiredBindings: [],
      routes: (a) => {
        a.get("/ping", (c) => c.text("pong"));
      },
    });
    const app = createBackend({ capabilities: [ping] });
    const res = await app.request("/ping", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  test("mounts the app capability's routes after capability routes", async () => {
    const order: string[] = [];
    const cap = defineCapability({
      name: "cap",
      requiredBindings: [],
      routes: (a) => {
        a.use("/order", async (_c, next) => {
          order.push("cap");
          await next();
        });
      },
    });
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (a) => {
        a.get("/order", (c) => {
          order.push("app");
          return c.json(order);
        });
      },
    });
    const backend = createBackend({ capabilities: [cap], app });
    const res = await backend.request("/order", {}, env);
    expect(await res.json()).toEqual(["cap", "app"]);
  });

  test("fails fast: a missing required binding yields 500 naming the binding", async () => {
    const needsMissing = defineCapability({
      name: "needsMissing",
      requiredBindings: [{ type: "kv", name: "DOES_NOT_EXIST", optional: false }],
    });
    const app = createBackend({ capabilities: [needsMissing] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: kv:DOES_NOT_EXIST/);
  });

  test("validates the app capability's bindings too", async () => {
    const app = defineCapability({
      name: "app",
      requiredBindings: [{ type: "kv", name: "ALSO_MISSING", optional: false }],
    });
    const backend = createBackend({ capabilities: [], app });
    const res = await backend.request("/health", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: kv:ALSO_MISSING/);
  });

  test("validates bindings once, memoized across requests", async () => {
    let routeHits = 0;
    const cap = defineCapability({
      name: "counter",
      // DB and SESSIONS are provided by the test env, so validation passes.
      requiredBindings: [{ type: "d1", name: "DB", optional: false }],
      routes: (a) => {
        a.get("/count", (c) => {
          routeHits += 1;
          return c.text(String(routeHits));
        });
      },
    });
    const app = createBackend({ capabilities: [cap] });
    expect((await app.request("/count", {}, env)).status).toBe(200);
    expect((await app.request("/count", {}, env)).status).toBe(200);
    expect(routeHits).toBe(2);
  });

  test("composes capability middleware", async () => {
    const tag = defineCapability({
      name: "tag",
      requiredBindings: [],
      middleware: [
        (a) => {
          a.use("*", async (c, next) => {
            await next();
            c.header("x-tag", "on");
          });
        },
      ],
      routes: (a) => {
        a.get("/tagged", (c) => c.text("ok"));
      },
    });
    const app = createBackend({ capabilities: [tag] });
    const res = await app.request("/tagged", {}, env);
    expect(res.headers.get("x-tag")).toBe("on");
  });

  test("defaults the request context: auth, db, and kv are null", async () => {
    const whoami = defineCapability({
      name: "whoami",
      requiredBindings: [],
      routes: (a) => {
        a.get("/whoami", (c) => c.json({ auth: c.get("auth"), db: c.get("db"), kv: c.get("kv") }));
      },
    });
    const app = createBackend({ capabilities: [whoami] });
    const res = await app.request("/whoami", {}, env);
    expect(await res.json()).toEqual({ auth: null, db: null, kv: null });
  });
});
