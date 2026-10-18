// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { TURNSTILE_EVENTS } from "@pithy-sh/cloudflare/src/analytics/datasets";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { WidgetDeps, WidgetSource } from "../analytics/widgets";
import { TurnstileConfig } from "../config/config";
import { TURNSTILE_TEST_KEYS } from "../provision/testKeys";
import { TurnstileWidgetsResponse } from "./responses";
import { registerTurnstileRoutes } from "./routes";
import { TURNSTILE_WIDGETS_PATH, TURNSTILE_WIDGETS_READ_SCOPE } from "./scopes";

const now = new Date("2026-10-18T12:00:00.000Z");
const LIMITS = { enabled: true, maxDuration: 2_764_800, notOlderThan: 7_948_800, maxPageSize: 10_000 };
const pass = TURNSTILE_TEST_KEYS.sitekey.visiblePass;
const config = TurnstileConfig.parse({
  widgets: { visible: { sitekeys: { dev: pass, staging: pass, prod: "0xREAL" } } },
});

function context(granted: string[]): ControlPlaneContext {
  return {
    connectionId: "conn-1",
    environment: "prod",
    issuer: "https://dashboard.example",
    subject: "operator-1",
    scope: TURNSTILE_WIDGETS_READ_SCOPE,
    grantedScopes: granted,
    keyId: "key-1",
    tokenId: "jti-1",
    actorKind: "dashboard",
  };
}

function harness(environment: string | null, granted: string[] = [TURNSTILE_WIDGETS_READ_SCOPE]) {
  const from: WidgetSource = {
    datasetLimits: vi.fn(async () => ({ [TURNSTILE_EVENTS]: LIMITS })),
    turnstileEvents: vi.fn(async () => new Map([["0xREAL", new Map([["challenge_issued", 3]])]])),
  };
  const source = vi.fn(async () => from);
  const verify: ControlPlaneVerifier = async (_request, requirement) => {
    if (typeof requirement === "string" && !granted.includes(requirement)) throw new Error(`ungranted ${requirement}`);
    return context(granted);
  };
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verify);
    c.set("log", noopLogger);
    await next();
  });
  const deps: WidgetDeps = { config, environment, source, now: () => now };
  registerTurnstileRoutes({ config, resolveWidgets: async () => deps })(app);
  return { app, from, source };
}

describe(`GET ${TURNSTILE_WIDGETS_PATH} (#731)`, () => {
  test("a real widget answers its sitekey and outcomes for the default window, in the declared shape", async () => {
    const h = harness("prod");
    const response = await h.app.request(TURNSTILE_WIDGETS_PATH);
    expect(response.status).toBe(200);
    const body = TurnstileWidgetsResponse.parse(await response.json());
    expect(body.until).toBe(now.toISOString());
    expect(body.widgets[0]).toMatchObject({ state: "reported", sitekey: "0xREAL", testKey: false });
    expect(h.from.turnstileEvents).toHaveBeenCalledWith(expect.objectContaining({ siteKeys: ["0xREAL"] }));
  });

  test("a test-key environment answers deliberately passing, and reaches no Cloudflare", async () => {
    const h = harness("staging");
    const body = TurnstileWidgetsResponse.parse(await (await h.app.request(TURNSTILE_WIDGETS_PATH)).json());
    expect(body.widgets[0]).toMatchObject({ state: "test-key", testKey: true, verdict: "passes" });
    expect(h.source).not.toHaveBeenCalled();
  });

  test("since and until set the window", async () => {
    const h = harness("prod");
    const response = await h.app.request(
      `${TURNSTILE_WIDGETS_PATH}?since=2026-10-01T00:00:00.000Z&until=2026-10-08T00:00:00.000Z`,
    );
    expect(response.status).toBe(200);
    expect(h.from.turnstileEvents).toHaveBeenCalledWith({
      since: new Date("2026-10-01T00:00:00.000Z"),
      until: new Date("2026-10-08T00:00:00.000Z"),
      siteKeys: ["0xREAL"],
    });
  });

  test("a window past retention is a named 400", async () => {
    const response = await harness("prod").app.request(`${TURNSTILE_WIDGETS_PATH}?since=2026-01-01T00:00:00.000Z`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("turnstile/analytics_window");
  });

  test("a malformed bound is a validation failure, never a default window", async () => {
    const response = await harness("prod").app.request(`${TURNSTILE_WIDGETS_PATH}?since=yesterday`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("validation/invalid_input");
  });

  test("a caller without the scope is refused before anything is read", async () => {
    const h = harness("prod", []);
    const response = await h.app.request(TURNSTILE_WIDGETS_PATH);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(h.source).not.toHaveBeenCalled();
  });
});
