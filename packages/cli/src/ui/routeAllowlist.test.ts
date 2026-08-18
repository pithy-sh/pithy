// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { CI_ENV } from "@pithy-sh/core/src/env/ci";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import { ENVIRONMENT_VAR } from "@pithy-sh/core/src/worker/identity";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { deriveWorkerFirst, firstSegment, uncoveredRoutes, workerFirstPatterns } from "./routeAllowlist";

/** What `pithy init` writes when a project declares nothing. */
const DECLARED = ["staging", "prod"];

/** A capability that mounts routes under `base` and nothing else. */
function routed(name: string, base: string) {
  return defineCapability({
    name,
    requiredBindings: [],
    routes: (app) => {
      app.get(base, (c) => c.json({}));
      app.get(`${base}/:id`, (c) => c.json({}));
      app.use(`${base}/*`, async (_c, next) => {
        await next();
      });
    },
  });
}

/**
 * A capability that mounts one route **only** in the composition it names — the shape `@pithy-sh/auth`'s
 * dev-login route has, and the shape every environment-gated or flag-gated route has after it.
 */
function conditionallyRouted(name: string, environment: string, path: string) {
  return defineCapability({
    name,
    requiredBindings: [],
    routes: (app) => {
      if (compositionEnvironment() !== environment) return;
      app.get(path, (c) => c.json({}));
    },
  });
}

describe("firstSegment", () => {
  test("takes the first path segment", () => {
    expect(firstSegment("/leaderboard/:board/entries")).toBe("leaderboard");
    expect(firstSegment("/health")).toBe("health");
  });

  test("skips what an allowlist cannot express", () => {
    // core's own app.use("*") middleware, and anything mounted at a bare parameter root.
    expect(firstSegment("*")).toBeNull();
    expect(firstSegment("/*")).toBeNull();
    expect(firstSegment("/")).toBeNull();
    expect(firstSegment("/:tenant/things")).toBeNull();
  });
});

describe("workerFirstPatterns", () => {
  test("emits both the bare path and the glob, because /auth/* does not match /auth", () => {
    expect(workerFirstPatterns(["/auth", "/auth/sign-in/magic-link"])).toEqual([
      "/auth",
      "/auth/*",
      "/health",
      "/health/*",
    ]);
  });

  test("never emits a bare-prefix glob — /media* would over-match /mediafoo", () => {
    for (const pattern of workerFirstPatterns(["/media/upload"])) {
      expect(pattern).not.toMatch(/[^/]\*$/);
    }
  });

  test("is sorted and deduplicated, so the written config is stable run to run", () => {
    const patterns = workerFirstPatterns(["/ledger/x", "/auth", "/ledger", "/auth/y"]);
    expect(patterns).toEqual(["/auth", "/auth/*", "/health", "/health/*", "/ledger", "/ledger/*"]);
    expect([...patterns].sort()).toEqual(patterns);
  });
});

describe("deriveWorkerFirst", () => {
  test("derives the allowlist from the worker's REAL composed route table", () => {
    const patterns = deriveWorkerFirst(
      {
        capabilities: [routed("auth", "/auth"), routed("leaderboard", "/leaderboard")],
        app: defineCapability({
          name: "api",
          requiredBindings: [],
          routes: (app) => {
            app.get("/things", (c) => c.json({}));
          },
        }),
      },
      DECLARED,
    );

    for (const segment of ["/auth", "/leaderboard", "/things"]) {
      expect(patterns).toContain(segment);
      expect(patterns).toContain(`${segment}/*`);
    }
    // createBackend serves /health itself, and it is the first thing anyone checks.
    expect(patterns).toContain("/health");
    // The issue text said ["/api/*"]. Tested empirically, that answers GET /health with the SPA
    // shell and POST /auth/sign-in/magic-link with a 405 — the worker is never invoked.
    expect(patterns).not.toContain("/api/*");
    // core's own app.use("*") must not become a catch-all entry.
    expect(patterns).not.toContain("/*");
  });

  test("a worker composing nothing still keeps /health worker-first", () => {
    expect(deriveWorkerFirst({ capabilities: [] }, DECLARED)).toEqual(["/health", "/health/*"]);
  });
});

/**
 * The invariant, stated over behaviour: **a route the Worker mounts in any environment the project
 * declares is a route the asset handler does not answer first.**
 *
 * Every test here plants a conditionally-mounted route — the one shape the old derivation could not
 * see, because it composed the app once, under whatever environment the command happened to run in.
 */
describe("a conditionally-mounted route", () => {
  const originalEnvironment = process.env[ENVIRONMENT_VAR];
  const originalCi = process.env[CI_ENV];

  afterEach(() => {
    if (originalEnvironment === undefined) delete process.env[ENVIRONMENT_VAR];
    else process.env[ENVIRONMENT_VAR] = originalEnvironment;
    if (originalCi === undefined) delete process.env[CI_ENV];
    else process.env[CI_ENV] = originalCi;
  });

  test("is covered when it is mounted only by a dev composition", () => {
    // `pithy dev` composes this; the command deriving the allowlist does not. Nothing declares `dev` —
    // it is local and never declarable — so the derivation has to add it, or no project ever gets it.
    const config: WorkerConfig = { capabilities: [conditionallyRouted("auth", "dev", DEV_LOGIN_ROUTE)] };
    const patterns = deriveWorkerFirst(config, DECLARED);
    expect(patterns).toContain("/__pithy");
    expect(patterns).toContain("/__pithy/*");
    expect(uncoveredRoutes(config, patterns, DECLARED)).toEqual([]);
  });

  test("is covered when it is mounted only by a declared environment's composition", () => {
    // Dev-login is the first of these, not the last: a capability mounted for staging alone has the
    // same shape, and reserving one prefix would not have covered it.
    const config: WorkerConfig = { capabilities: [conditionallyRouted("preview", "staging", "/preview/banner")] };
    expect(deriveWorkerFirst(config, DECLARED)).toContain("/preview");
  });

  test("is reported as uncovered against an allowlist that misses it", () => {
    // The planted violation. Before this, `--check` answered "every route reaches the worker" here.
    const config: WorkerConfig = { capabilities: [conditionallyRouted("auth", "dev", DEV_LOGIN_ROUTE)] };
    expect(uncoveredRoutes(config, ["/health", "/health/*"], DECLARED)).toEqual([DEV_LOGIN_ROUTE]);
  });

  test("is covered identically under CI, so the file CI checks is the file a laptop writes", () => {
    // The second gate on the dev-login route is `CI`. Honouring it here would make `ui sync --check`
    // demand a shorter list than `ui sync` writes — a project permanently drifted, failing on the
    // correct file. An allowlist entry nothing serves costs a 404; a missing one costs a 200.
    process.env[CI_ENV] = "true";
    const config: WorkerConfig = { capabilities: [conditionallyRouted("auth", "dev", DEV_LOGIN_ROUTE)] };
    expect(deriveWorkerFirst(config, DECLARED)).toContain("/__pithy");
  });

  test("leaves the process environment exactly as it found it", () => {
    process.env[ENVIRONMENT_VAR] = "staging";
    process.env[CI_ENV] = "1";
    deriveWorkerFirst({ capabilities: [conditionallyRouted("auth", "dev", DEV_LOGIN_ROUTE)] }, DECLARED);
    expect(process.env[ENVIRONMENT_VAR]).toBe("staging");
    expect(process.env[CI_ENV]).toBe("1");
  });

  test("the dev-login route's own prefix is the one the patterns carry", () => {
    // `/_pithy` (one underscore) is the email callback prefix and matches nothing under `/__pithy`.
    // Naming the real constant here is what stops the two spellings drifting again.
    expect(firstSegment(DEV_LOGIN_ROUTE)).toBe("__pithy");
    expect(workerFirstPatterns([DEV_LOGIN_ROUTE])).toContain("/__pithy/*");
  });
});

describe("uncoveredRoutes", () => {
  const scaffoldTime = ["/health", "/health/*"];

  test("reports the routes an allowlist written earlier no longer covers", () => {
    // The reported failure, exactly: the list was derived when /health was the only route, and the
    // worker has grown its own since. Each of these comes back 200 text/html, having never run.
    const config: WorkerConfig = {
      capabilities: [],
      app: defineCapability({
        name: "api",
        requiredBindings: [],
        routes: (app) => {
          app.get("/api/organizations", (c) => c.json({}));
          app.post("/api/cli/device/start", (c) => c.json({}));
        },
      }),
    };
    expect(uncoveredRoutes(config, scaffoldTime, DECLARED)).toEqual(["/api/cli/device/start", "/api/organizations"]);
  });

  test("a list that covers the route table reports nothing", () => {
    const config: WorkerConfig = { capabilities: [routed("auth", "/auth")] };
    expect(uncoveredRoutes(config, deriveWorkerFirst(config, DECLARED), DECLARED)).toEqual([]);
  });

  test("a route no allowlist can express is not drift", () => {
    // core mounts `app.use("*")`, and `/` is the app shell by design. Reporting either would make
    // every project permanently drifted, which is how a check gets ignored.
    const config: WorkerConfig = {
      capabilities: [],
      app: defineCapability({
        name: "api",
        requiredBindings: [],
        routes: (app) => {
          app.get("/", (c) => c.json({}));
        },
      }),
    };
    expect(uncoveredRoutes(config, scaffoldTime, DECLARED)).toEqual([]);
  });
});
