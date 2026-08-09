// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { AmbientEnv } from "@pithy-sh/core/src/env/ambient";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AuthWiring, auth } from "../capability";
import { registerDevLoginRoute } from "./devLoginRoute";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The wiring the route closes over — only the config half matters to registration. */
function wiring(): AuthWiring {
  return {
    config: auth({ baseURL: "http://localhost:8787" }).authConfig,
    enqueueEmail: undefined,
    turnstile: undefined,
  };
}

/** Every path a composition mounted, for the one question these tests ask: is the route there at all? */
function paths(env: AmbientEnv): string[] {
  const app = new Hono<PithyHonoEnv>();
  registerDevLoginRoute(wiring(), env)(app);
  return app.routes.map((route) => route.path);
}

describe("the environment gate", () => {
  test("a dev composition carries the route", () => {
    expect(paths({ ENVIRONMENT: "dev" })).toContain(DEV_LOGIN_ROUTE);
  });

  test("a staging composition carries no such route", () => {
    expect(paths({ ENVIRONMENT: "staging" })).not.toContain(DEV_LOGIN_ROUTE);
  });

  test("a prod composition carries no such route", () => {
    expect(paths({ ENVIRONMENT: "prod" })).not.toContain(DEV_LOGIN_ROUTE);
  });

  test("a composition stamped with nothing carries no such route — an unknown environment is not dev", () => {
    expect(paths({})).not.toContain(DEV_LOGIN_ROUTE);
    expect(paths({ ENVIRONMENT: "" })).not.toContain(DEV_LOGIN_ROUTE);
  });
});

describe("the CI gate", () => {
  test("a dev composition under CI carries no such route", () => {
    // The refusal the environment check cannot make: CI boots dev compositions constantly, and CI is
    // where a session-minting endpoint is least supervised.
    expect(paths({ ENVIRONMENT: "dev", CI: "true" })).not.toContain(DEV_LOGIN_ROUTE);
  });

  test("any non-blank CI refuses; a blank one is no override", () => {
    expect(paths({ ENVIRONMENT: "dev", CI: "1" })).not.toContain(DEV_LOGIN_ROUTE);
    expect(paths({ ENVIRONMENT: "dev", CI: "false" })).not.toContain(DEV_LOGIN_ROUTE);
    expect(paths({ ENVIRONMENT: "dev", CI: "" })).toContain(DEV_LOGIN_ROUTE);
    expect(paths({ ENVIRONMENT: "dev", CI: "  " })).toContain(DEV_LOGIN_ROUTE);
  });

  test("the two gates are independent — neither implies the other", () => {
    expect(paths({ ENVIRONMENT: "prod", CI: "true" })).not.toContain(DEV_LOGIN_ROUTE);
    expect(paths({ ENVIRONMENT: "prod" })).not.toContain(DEV_LOGIN_ROUTE);
    expect(paths({ CI: "true" })).not.toContain(DEV_LOGIN_ROUTE);
  });
});

describe("the composed capability", () => {
  /** What `auth()` itself mounts, read off a real Hono app rather than off the helper. */
  function composedPaths(): string[] {
    const app = new Hono<PithyHonoEnv>();
    auth({ baseURL: "http://localhost:8787" }).routes?.(app);
    return app.routes.map((route) => route.path);
  }

  test("auth() mounts the route in a dev composition and omits it everywhere else", () => {
    // The gate is at registration, so what a composition *mounts* is the whole assertion — a route that
    // existed and refused inside its handler would still pass a test written against a response.
    vi.stubEnv("ENVIRONMENT", "dev");
    expect(composedPaths()).toContain(DEV_LOGIN_ROUTE);

    vi.stubEnv("ENVIRONMENT", "prod");
    expect(composedPaths()).not.toContain(DEV_LOGIN_ROUTE);

    vi.stubEnv("ENVIRONMENT", "dev");
    vi.stubEnv("CI", "true");
    expect(composedPaths()).not.toContain(DEV_LOGIN_ROUTE);
  });
});
