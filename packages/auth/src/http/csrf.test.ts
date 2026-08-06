// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { type AuthConfigInput, auth } from "../capability";

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
  // The adopter's own route, gated by a check it cannot parameterise.
  app.post("/organisations", requireSameOrigin(), (c) => c.text("ok"));
  return app;
}

/** One request at the adopter's route, with the credential and origin headers a browser would send. */
async function post(app: Hono<PithyHonoEnv>, headers: Record<string, string>): Promise<Response> {
  return await app.request("/organisations", { method: "POST", headers }, {});
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

  // The surface, pinned. Nothing exported here takes an origin list and hands back a gate, so there is
  // no supported way to build a same-origin check bound to origins other than the composed auth's.
  // Binding one elsewhere would mean fabricating a whole `AuthWiring` — which is composing a different
  // auth, not forgetting an argument.
  test("the module exports no gate constructor an adopter could bind to other origins", async () => {
    const module = await import("./csrf");
    expect(Object.keys(module).sort()).toEqual(["publishSameOrigin"]);
  });
});
