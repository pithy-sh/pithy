// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { type CapabilityInput, defineCapability } from "./capability/capability";
import { createBackend } from "./createBackend";
import { PithyError } from "./error/pithyError";
import type { CapabilityRoutes } from "./http/lazyRoutes";
import { describeRoute } from "./http/routeSpec";
import { routeGroupsOf } from "./openapi/routeGroups";

/**
 * **A capability's routes are built on the first request that reaches them, behind everything they sat behind
 * when they were built at assembly.**
 */

const ENV = {};

const PROBE_EVALUATIONS = Symbol.for("pithy.test.lazyProbeEvaluations");
const evaluations = () => (globalThis as { [PROBE_EVALUATIONS]?: number })[PROBE_EVALUATIONS] ?? 0;

/** The probe capability: its routes module counts its own evaluation. */
function probe(extra: Partial<CapabilityInput> = {}) {
  return defineCapability({
    name: "probe",
    requiredBindings: [],
    routes: {
      declared: [{ method: "GET", path: "/probe" }],
      load: async () => (await import("./test-utils/lazyProbe")).mountProbe,
    },
    ...extra,
  });
}

describe("createBackend, with a capability's routes behind a loader", () => {
  test("evaluates the routes module on the first request that reaches it, and not before", async () => {
    const before = evaluations();
    const app = createBackend({ capabilities: [probe()] });
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toContain("GET /probe");
    await app.request("/health", {}, ENV);
    expect(evaluations()).toBe(before);

    const res = await app.request("/probe", {}, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evaluations: before + 1 });
    expect(evaluations()).toBe(before + 1);
  });

  test("runs every middleware and readiness guard ahead of a route whose module has not loaded", async () => {
    const order: string[] = [];
    const load = vi.fn<CapabilityRoutes["load"]>(async () => (app) => {
      order.push("load");
      app.get("/guarded", (c) => c.text("served"));
    });
    const capability = defineCapability({
      name: "guarded",
      requiredBindings: [],
      middleware: [
        (app) =>
          app.use("*", async (c, next) => {
            order.push("auth");
            if (c.req.header("authorization") !== "Bearer yes") return c.json({ refused: "auth" }, 401);
            await next();
          }),
        (app) =>
          app.use("*", async (c, next) => {
            order.push("rate");
            if (c.req.header("x-flood") !== undefined) return c.json({ refused: "rate" }, 429);
            await next();
          }),
      ],
      readiness: [
        async (c, next) => {
          order.push("ready");
          if (c.req.header("x-broken") !== undefined) return c.json({ refused: "ready" }, 503);
          await next();
        },
      ],
      routes: { declared: [{ method: "GET", path: "/guarded" }], load },
    });
    const app = createBackend({ capabilities: [capability] });

    expect((await app.request("/guarded", {}, ENV)).status).toBe(401);
    expect(
      (await app.request("/guarded", { headers: { authorization: "Bearer yes", "x-flood": "1" } }, ENV)).status,
    ).toBe(429);
    expect(
      (await app.request("/guarded", { headers: { authorization: "Bearer yes", "x-broken": "1" } }, ENV)).status,
    ).toBe(503);
    expect(load).not.toHaveBeenCalled();

    const served = await app.request("/guarded", { headers: { authorization: "Bearer yes" } }, ENV);
    expect(await served.text()).toBe("served");
    expect(order).toEqual(["auth", "auth", "rate", "auth", "rate", "ready", "auth", "rate", "ready", "load"]);
  });

  test("builds a capability's routes once when its first requests arrive together", async () => {
    const mounted = vi.fn();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capability = defineCapability({
      name: "together",
      requiredBindings: [],
      routes: {
        declared: [{ method: "GET", path: "/together" }],
        load: async () => {
          await gate;
          return (app) => {
            mounted();
            app.get("/together", (c) => c.text("ok"));
          };
        },
      },
    });
    const app = createBackend({ capabilities: [capability] });
    const pending = Promise.all(Array.from({ length: 8 }, () => app.request("/together", {}, ENV)));
    release?.();
    expect((await pending).map((res) => res.status)).toEqual(Array.from({ length: 8 }, () => 200));
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  test("records each capability's loaded routes as its route group", async () => {
    const capability = defineCapability({
      name: "described",
      requiredBindings: [],
      routes: {
        declared: [{ method: "GET", path: "/described" }],
        load: async () => (app) => {
          app.get(
            "/described",
            describeRoute({ summary: "Answer.", verification: "public", responses: { 200: { description: "It." } } }),
            (c) => c.text("ok"),
          );
        },
      },
    });
    const groups = (await routeGroupsOf(createBackend({ capabilities: [capability] }))) ?? [];
    expect(
      groups.map((group) => [group.tag, [...new Set(group.routes.map((route) => `${route.method} ${route.path}`))]]),
    ).toEqual([
      ["core", ["GET /health"]],
      ["described", ["GET /described"]],
    ]);
  });

  test("refuses a capability that hands core its routes as a function, naming the loader shape", () => {
    const eager = { ...probe(), routes: (() => undefined) as unknown as CapabilityRoutes };
    const refusal = (() => {
      try {
        createBackend({ capabilities: [eager] });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).message).toMatch(/probe.*routes as a function/);
    expect((refusal as PithyError).payload.action).toMatch(/declared.*load/);
  });

  test("merges every capability's messages on the first message rendered, not at assembly", async () => {
    // Every message read is counted; reading the keys alone, as the domain check does, reads none.
    const read: string[] = [];
    const catalog = new Proxy<Record<string, string>>(
      { "speaker/hello": "Hello." },
      {
        get: (target, key, receiver) => {
          if (typeof key === "string") read.push(key);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const speaker = defineCapability({
      name: "speaker",
      requiredBindings: [],
      messages: { en: catalog },
      routes: {
        declared: [
          { method: "GET", path: "/quiet" },
          { method: "GET", path: "/speak" },
        ],
        load: async () => (app) => {
          app.get("/quiet", (c) => c.text(c.var.t.formatNumber(1)));
          app.get("/speak", (c) => c.text(c.var.t.t("speaker/hello")));
        },
      },
    });
    const app = createBackend({ capabilities: [speaker] });
    expect((await app.request("/quiet", {}, ENV)).status).toBe(200);
    expect(read).toEqual([]);
    expect(await (await app.request("/speak", {}, ENV)).text()).toBe("Hello.");
    expect(read).toContain("speaker/hello");
  });

  test("refuses a message outside its capability's domain at assembly, so the Worker never starts", () => {
    const trespasser = defineCapability({
      name: "trespasser",
      requiredBindings: [],
      messages: { en: { "auth/stolen": "Not mine." } },
    });
    expect(() => createBackend({ capabilities: [trespasser] })).toThrow(/under its own domain/);
  });
});
