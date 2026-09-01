// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { controlplane } from "../capability";
import { controlplane_0001_init } from "../migrations/0001_init";
import { CONTROL_PLANE_VERSION_CREATED_HEADER, CONTROL_PLANE_VERSION_HEADER } from "../wire";
import { requireControlPlane } from "./guard";

/**
 * The CORS surface in **workerd**, against real bindings.
 *
 * `cors.test.ts` covers the rules — the allow-list, the refusal, the dev allowance, the ordering — and
 * covers them far more thoroughly than this file does. It runs in node, where a request is a synthetic
 * `Request` handed to Hono. That is the right place to state a rule and the wrong place to trust one:
 * every claim this change makes is about **bytes a browser receives**, and the runtime that produces
 * them in production is workerd, not node.
 *
 * So this file asserts the wire, not the logic. A `204` that really carries no body, headers that
 * survive the runtime rather than the framework, `Vary` appended rather than replaced, and the version
 * headers actually readable on a real response. Nothing here re-states a rule; if a case fails here and
 * passes there, the difference is the runtime and that is the finding.
 *
 * What it still does not prove is that a *browser* accepts these bytes. Nothing that runs in CI can:
 * that is a deploy and a real origin, the way #462 verified its own claim.
 */

const DASHBOARD = "https://app.pithy.sh";
const STRANGER = "https://evil.example";

const INVENTORY_READ_SCOPE = "inventory:things:read";

/** A capability with an admin route of its own, mounted away from the seam's own base path. */
const inventory = defineCapability({
  name: "inventory",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/inventory/admin/things", scope: INVENTORY_READ_SCOPE, summary: "Every pending thing." },
  ],
  routes: (app) => {
    app.get("/inventory/admin/things", requireControlPlane(INVENTORY_READ_SCOPE), (c) => c.json({ things: [] }));
  },
});

/** The adopter's own API. Not an admin surface, and the kit does not decide its CORS. */
const adopterApp = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (app) => {
    app.get("/api/things", (c) => c.json({ things: [] }));
  },
});

const backend = createBackend({ capabilities: [controlplane(), inventory], app: adopterApp });

const BINDINGS = { ...env, ENVIRONMENT: "prod" };

function call(path: string, { method = "OPTIONS", origin = DASHBOARD as string | null, bindings = BINDINGS } = {}) {
  const headers: Record<string, string> = origin === null ? {} : { origin };
  return backend.request(`http://worker.example${path}`, { method, headers }, bindings);
}

beforeEach(async () => {
  // No connection is ever registered here. That is the shipped state of a Worker nobody has connected,
  // and every case below must hold in it — a preflight is answered before any credential is read.
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  await controlplane_0001_init.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("the preflight, on the wire", () => {
  test("is a 204 that really carries nothing", async () => {
    const response = await call("/control-plane/manifest");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(await response.text()).toBe("");
  });

  test("carries the methods, headers and cache hint workerd actually emits", async () => {
    const response = await call("/control-plane/keys");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  test("reaches a capability's own admin route, not just the seam's", async () => {
    const response = await call("/inventory/admin/things");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  test("refuses an unlisted origin by omission, with the same status and the same bytes", async () => {
    const allowed = await call("/control-plane/manifest");
    const refused = await call("/control-plane/manifest", { origin: STRANGER });
    expect(refused.status).toBe(allowed.status);
    expect(await refused.text()).toBe(await allowed.text());
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the real response, on the wire", () => {
  test("a denial is readable cross-origin, which is the point of the change", async () => {
    // With no connection registered the seam denies, and the dashboard has to be able to read *which*
    // denial. Without the echoed origin this is an opaque `TypeError` naming the host.
    const response = await call("/control-plane/manifest", { method: "GET" });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(await response.text()).toContain("controlplane/");
  });

  test("names both version headers as readable", async () => {
    const exposed = (await call("/control-plane/manifest", { method: "GET" })).headers.get(
      "access-control-expose-headers",
    );
    expect(exposed).toContain(CONTROL_PLANE_VERSION_HEADER);
    expect(exposed).toContain(CONTROL_PLANE_VERSION_CREATED_HEADER);
  });

  test("appends Vary rather than replacing whatever else set one", async () => {
    expect((await call("/control-plane/manifest", { method: "GET" })).headers.get("vary")).toContain("Origin");
  });

  test("never allows credentials", async () => {
    for (const method of ["OPTIONS", "GET"]) {
      expect(
        (await call("/control-plane/manifest", { method })).headers.get("access-control-allow-credentials"),
      ).toBeNull();
    }
  });
});

describe("what stays untouched in workerd", () => {
  test("the adopter's own route gains no CORS header", async () => {
    const response = await call("/api/things", { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  test("and an OPTIONS to it still 404s", async () => {
    expect((await call("/api/things")).status).toBe(404);
  });
});

describe("the dev allowance in workerd", () => {
  test("answers a loopback origin when the environment says dev", async () => {
    const response = await call("/control-plane/manifest", {
      origin: "http://localhost:5173",
      bindings: { ...env, ENVIRONMENT: "dev" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("and does not, one word later", async () => {
    const response = await call("/control-plane/manifest", {
      origin: "http://localhost:5173",
      bindings: { ...env, ENVIRONMENT: "prod" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
