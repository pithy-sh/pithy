// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { defineCapability } from "./capability/capability";
import { createBackend } from "./createBackend";
import { createLogger } from "./logger/logger";
import type { LogRecord } from "./logger/record";

describe("createBackend", () => {
  test('serves GET /health with 200 { status: "ok" }', async () => {
    const app = createBackend({ capabilities: [] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: null });
  });

  test("GET /health reports the running build, which is what makes deploy verification an assertion", async () => {
    // A liveness probe proves *a* Worker answers at the declared domain. It does not prove it is the one
    // just shipped — and the old version answering happily is precisely the failure worth catching.
    const app = createBackend({ capabilities: [] });
    const res = await app.request("/health", {}, { ...env, CF_VERSION_METADATA: { id: "v-abc123", tag: "" } });
    expect(await res.json()).toEqual({ status: "ok", version: "v-abc123" });
  });

  test("seeds c.var.emit with a no-op recorder that never throws when no audit capability is composed", async () => {
    const probe = defineCapability({
      name: "probe",
      requiredBindings: [],
      routes: (a) => {
        a.get("/emit", async (c) => {
          // With no audit capability composed, emit is the no-op: it resolves and records nothing.
          await c.var.emit({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u1" });
          return c.json({ emitted: true });
        });
      },
    });
    const app = createBackend({ capabilities: [probe] });
    const res = await app.request("/emit", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emitted: true });
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

  test("fails fast at assembly when a capability's peer (dependsOn) is not composed", () => {
    const needsSecrets = defineCapability({ name: "turnstile", dependsOn: ["secrets"], requiredBindings: [] });
    expect(() => createBackend({ capabilities: [needsSecrets] })).toThrowError(/requires the "secrets" capability/);
  });

  test("a satisfied peer dependency assembles cleanly", () => {
    const secrets = defineCapability({ name: "secrets", requiredBindings: [] });
    const needsSecrets = defineCapability({ name: "turnstile", dependsOn: ["secrets"], requiredBindings: [] });
    expect(() => createBackend({ capabilities: [secrets, needsSecrets] })).not.toThrow();
  });

  test("fires each capability's compose hook once, with every composed capability (app included)", () => {
    const seen: string[][] = [];
    const a = defineCapability({
      name: "a",
      requiredBindings: [],
      compose: ({ capabilities }) => seen.push(capabilities.map((c) => c.name)),
    });
    const b = defineCapability({ name: "b", requiredBindings: [] });
    const app = defineCapability({ name: "app", requiredBindings: [] });
    createBackend({ capabilities: [a, b], app });
    // One invocation of a's hook, seeing all three capabilities in composition order.
    expect(seen).toEqual([["a", "b", "app"]]);
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

  test("resolves c.var.log from context, auto-carrying request-correlation fields", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "debug", sink: (r) => records.push(r) });
    const probe = defineCapability({
      name: "probe",
      requiredBindings: [],
      routes: (a) => {
        a.get("/log", (c) => {
          c.var.log.info("handled", { detail: "x" });
          return c.json({ ok: true });
        });
      },
    });
    const app = createBackend({ capabilities: [probe], logger, env: "staging" });
    await app.request("/log", { method: "GET" }, env);

    const handled = records.find((r) => r.msg === "handled");
    expect(handled?.fields).toMatchObject({
      method: "GET",
      path: "/log",
      env: "staging",
      detail: "x",
    });
    expect(typeof handled?.fields?.request).toBe("string");
  });

  test("correlation resolves env from the per-request ENVIRONMENT var (over the assembly fallback)", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "debug", sink: (r) => records.push(r) });
    const probe = defineCapability({
      name: "probe",
      requiredBindings: [],
      routes: (a) => a.get("/e", (c) => c.json({ ok: c.var.log.info("hit") === undefined })),
    });
    // options.env is only a fallback; the ENVIRONMENT var on the request env wins.
    const app = createBackend({ capabilities: [probe], logger, env: "unknown" });
    await app.request("/e", {}, { ...env, ENVIRONMENT: "production" });

    expect(records.find((r) => r.msg === "hit")?.fields?.env).toBe("production");
  });

  test("correlation carries the deployed version from the CF_VERSION_METADATA binding", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "debug", sink: (r) => records.push(r) });
    const probe = defineCapability({
      name: "probe",
      requiredBindings: [],
      routes: (a) => a.get("/v", (c) => c.json({ ok: c.var.log.info("hit") === undefined })),
    });
    const app = createBackend({ capabilities: [probe], logger });
    // The version-metadata binding is per-request env; inject it alongside the test bindings.
    await app.request("/v", {}, { ...env, CF_VERSION_METADATA: { id: "v-abc123", tag: "" } });

    const hit = records.find((r) => r.msg === "hit");
    expect(hit?.fields?.version).toBe("v-abc123");
  });

  test("emits one access-log record per request carrying status and elapsed", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "info", sink: (r) => records.push(r) });
    const app = createBackend({ capabilities: [], logger });
    await app.request("/health", {}, env);

    const access = records.filter((r) => r.msg === "request");
    expect(access).toHaveLength(1);
    expect(access[0]?.fields).toMatchObject({ status: 200 });
    expect(typeof access[0]?.fields?.elapsed).toBe("number");
  });

  test("defaults the request context: auth is null, db and kv are empty registries", async () => {
    // No capability registers databases or stores here, so db and kv are empty registries {}.
    // Typed db/kv population is covered in createBackend.data.workers.test.ts.
    const whoami = defineCapability({
      name: "whoami",
      requiredBindings: [],
      routes: (a) => {
        a.get("/whoami", (c) => c.json({ auth: c.get("auth"), db: c.get("db"), kv: c.get("kv") }));
      },
    });
    const app = createBackend({ capabilities: [whoami] });
    const res = await app.request("/whoami", {}, env);
    expect(await res.json()).toEqual({ auth: null, db: {}, kv: {} });
  });
});
