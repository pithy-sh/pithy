// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { PithyHonoEnv, PithyReadinessGuard } from "../../capability/capability";
import { registerReadinessGuards } from "./readiness";

/**
 * The exemption, in isolation: a plain Hono app, a guard that refuses, and the surface it must not reach.
 *
 * `createBackend.readiness.workers.test.ts` proves the composed Worker. This file states the rule.
 */

/** A guard that refuses every request it sees, the way a misprovisioned Worker does. */
const refuse: PithyReadinessGuard = async (c) => c.text("not ready", 503);

function appWith(surface: readonly { path: string }[], guards: readonly PithyReadinessGuard[]) {
  const app = new Hono<PithyHonoEnv>();
  registerReadinessGuards(app, surface, guards);
  app.get("/control-plane/ping", (c) => c.text("pong"));
  app.post("/control-plane/keys/:keyId/expire", (c) => c.text("expired"));
  app.get("/control-plane/ping/deeper", (c) => c.text("deeper"));
  app.get("/api/things", (c) => c.text("things"));
  return app;
}

const SURFACE = [{ path: "/control-plane/ping" }, { path: "/control-plane/keys/:keyId/expire" }];

describe("registerReadinessGuards", () => {
  test("refuses a request off the admin surface", async () => {
    const response = await appWith(SURFACE, [refuse]).request("/api/things");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("not ready");
  });

  test("does not run on an admin path", async () => {
    const response = await appWith(SURFACE, [refuse]).request("/control-plane/ping");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
  });

  test("does not run on an admin path with a parameter in it", async () => {
    const response = await appWith(SURFACE, [refuse]).request("/control-plane/keys/cpk_old/expire", {
      method: "POST",
    });
    expect(await response.text()).toBe("expired");
  });

  test("still runs beneath an admin path, which is not itself on the surface", async () => {
    expect((await appWith(SURFACE, [refuse]).request("/control-plane/ping/deeper")).status).toBe(503);
  });

  test("runs every guard, in order, and the first refusal answers", async () => {
    const seen: string[] = [];
    const first: PithyReadinessGuard = async (_c, next) => {
      seen.push("first");
      await next();
    };
    const second: PithyReadinessGuard = async (c) => {
      seen.push("second");
      return c.text("second refused", 503);
    };
    const third: PithyReadinessGuard = async (_c, next) => {
      seen.push("third");
      await next();
    };
    const response = await appWith(SURFACE, [first, second, third]).request("/api/things");
    expect(await response.text()).toBe("second refused");
    expect(seen).toEqual(["first", "second"]);
  });

  test("a guard that throws reaches the error handler, off the surface only", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.onError((error, c) => c.text(error.message, 500));
    registerReadinessGuards(app, SURFACE, [
      () => {
        throw new Error("drifted");
      },
    ]);
    app.get("/control-plane/ping", (c) => c.text("pong"));
    app.get("/api/things", (c) => c.text("things"));
    expect(await (await app.request("/api/things")).text()).toBe("drifted");
    expect(await (await app.request("/control-plane/ping")).text()).toBe("pong");
  });

  test("with no guards, registers nothing", () => {
    const app = new Hono<PithyHonoEnv>();
    registerReadinessGuards(app, SURFACE, []);
    expect(app.routes).toEqual([]);
  });

  test("with no admin surface, guards every request", async () => {
    expect((await appWith([], [refuse]).request("/control-plane/ping")).status).toBe(503);
  });
});
