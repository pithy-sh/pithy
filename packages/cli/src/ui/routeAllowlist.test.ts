import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { deriveWorkerFirst, firstSegment, workerFirstPatterns } from "./routeAllowlist";

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
    const patterns = deriveWorkerFirst({
      capabilities: [routed("auth", "/auth"), routed("leaderboard", "/leaderboard")],
      app: defineCapability({
        name: "api",
        requiredBindings: [],
        routes: (app) => {
          app.get("/things", (c) => c.json({}));
        },
      }),
    });

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
    expect(deriveWorkerFirst({ capabilities: [] })).toEqual(["/health", "/health/*"]);
  });
});
