// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { type AuthConfigInput, auth } from "../capability";
import { publishSameOrigin } from "./csrf";

/**
 * The same-origin policy is auth's, and every route in the Worker gets that one — including routes
 * auth never wrote.
 *
 * So the subject here is not a middleware factory but a **composition**: the capability is built, its
 * middleware mounted the way `createBackend` mounts it, and an adopter's own route — the case that
 * forced this, the dashboard hand-writing a second origin check beside auth's — is registered with
 * core's zero-argument gate. What that route accepts is decided entirely by what `auth()` was
 * configured with.
 */
function compose(config: Partial<AuthConfigInput> = {}) {
  const capability = auth({
    baseURL: "https://api.example.com",
    trustedOrigins: ["https://app.example.com"],
    ...config,
  });
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  for (const middleware of capability.middleware ?? []) middleware(app);
  // The adopter's own route, gated by a check it cannot parameterize.
  app.post("/organizations", requireSameOrigin(), (c) => c.text("ok"));
  return app;
}

/** One request at the adopter's route, with the credential and origin headers a browser would send. */
async function post(app: Hono<PithyHonoEnv>, headers: Record<string, string>): Promise<Response> {
  return await app.request("/organizations", { method: "POST", headers }, {});
}

describe("an adopter's route wears auth's same-origin policy", () => {
  test("a cookie request from a trusted origin passes", async () => {
    const response = await post(compose(), { cookie: "session=t", origin: "https://app.example.com" });
    expect(response.status).toBe(200);
  });

  test("the baseURL's own origin is trusted without being listed", async () => {
    const response = await post(compose(), { cookie: "session=t", origin: "https://api.example.com" });
    expect(response.status).toBe(200);
  });

  test("a cookie request from a foreign origin is refused", async () => {
    const response = await post(compose(), { cookie: "session=t", origin: "https://evil.example.com" });
    expect(response.status).toBe(403);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("auth/forbidden");
  });

  test("a cookie request naming no origin at all is refused", async () => {
    const response = await post(compose(), { cookie: "session=t" });
    expect(response.status).toBe(403);
  });

  test("the Referer origin stands in when Origin is absent", async () => {
    const response = await post(compose(), { cookie: "session=t", referer: "https://app.example.com/account" });
    expect(response.status).toBe(200);
  });

  test("a bearer request is exempt — it carries no ambient credential to forge", async () => {
    const response = await post(compose(), { authorization: "Bearer t", origin: "https://evil.example.com" });
    expect(response.status).toBe(200);
  });

  /**
   * The property the seam exists for. The adopter's route never names an origin, so the only way to
   * change what it accepts is to change what `auth()` was composed with — and auth's own routes move
   * with it. Two implementations free to disagree is what this replaces; there is one now, and it is
   * not the adopter's to bind.
   */
  test("changing auth's trusted origins moves the adopter's route with it", async () => {
    const moved = compose({ trustedOrigins: ["https://console.example.com"] });
    expect((await post(moved, { cookie: "session=t", origin: "https://console.example.com" })).status).toBe(200);
    expect((await post(moved, { cookie: "session=t", origin: "https://app.example.com" })).status).toBe(403);
  });

  /**
   * The dev half of #244. The adopter's config holds their production origin, because that is what it
   * is for; under `pithy dev` the browser is at `http://localhost:<port>`, a port this run assigned.
   * Nothing was listed in `trustedOrigins` and nothing needs to be — the gate trusts the address the
   * composition is serving on, which in `dev` is the address the request arrived at.
   */
  describe("in a dev composition", () => {
    const dev = { ENVIRONMENT: "dev" };

    /** The same composition, with the environment handed in rather than read off the ambient env. */
    function composeDev(config: Partial<AuthConfigInput> = {}) {
      const capability = auth({ baseURL: "https://api.example.com", ...config });
      const app = new Hono<PithyHonoEnv>();
      app.onError(pithyErrorHandler);
      publishSameOrigin({ config: capability.authConfig, enqueueEmail: undefined, turnstile: undefined }, dev)(app);
      app.post("/organizations", requireSameOrigin(), (c) => c.text("ok"));
      return app;
    }

    /** One request at the adopter's route, sent to a specific local address. */
    async function postTo(app: Hono<PithyHonoEnv>, url: string, headers: Record<string, string>): Promise<Response> {
      return await app.request(url, { method: "POST", headers }, {});
    }

    test("the live local origin passes, with an empty trustedOrigins", async () => {
      const app = composeDev();
      const response = await postTo(app, "http://localhost:41011/organizations", {
        cookie: "session=t",
        origin: "http://localhost:41011",
      });
      expect(response.status).toBe(200);
    });

    test("it follows the port, so a second worker shifting the allocation changes nothing", async () => {
      const app = composeDev();
      for (const port of [8787, 8788, 41011]) {
        const response = await postTo(app, `http://localhost:${port}/organizations`, {
          cookie: "session=t",
          origin: `http://localhost:${port}`,
        });
        expect(response.status, `port ${port}`).toBe(200);
      }
    });

    test("an origin that is not the one this request arrived at is still refused", async () => {
      const app = composeDev();
      // The neighboring worker in the same `pithy dev` run. Local is not a wildcard.
      const response = await postTo(app, "http://localhost:41011/organizations", {
        cookie: "session=t",
        origin: "http://localhost:8787",
      });
      expect(response.status).toBe(403);
    });

    test("a foreign origin is refused exactly as it is in production", async () => {
      const app = composeDev();
      const response = await postTo(app, "http://localhost:41011/organizations", {
        cookie: "session=t",
        origin: "https://evil.example.com",
      });
      expect(response.status).toBe(403);
    });

    test("naming no origin at all is still refused", async () => {
      const response = await postTo(composeDev(), "http://localhost:41011/organizations", { cookie: "session=t" });
      expect(response.status).toBe(403);
    });

    test("the configured origin keeps passing — dev adds, it never replaces", async () => {
      const response = await postTo(composeDev(), "http://localhost:41011/organizations", {
        cookie: "session=t",
        origin: "https://api.example.com",
      });
      expect(response.status).toBe(200);
    });
  });

  // The surface, pinned. Nothing exported here takes an origin list and hands back a gate, so there is
  // no supported way to build a same-origin check bound to origins other than the composed auth's.
  // Binding one elsewhere would mean fabricating a whole `AuthWiring` — which is composing a different
  // auth, not forgetting an argument.
  test("the module exports no gate constructor an adopter could bind to other origins", async () => {
    const module = await import("./csrf");
    expect(Object.keys(module).sort()).toEqual(["publishSameOrigin"]);
  });
});
