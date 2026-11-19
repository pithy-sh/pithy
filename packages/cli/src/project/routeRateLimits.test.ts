// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rateLimitNamespaceId } from "./bindingEntries";
import { addRouteRateLimits, composedRouteRateLimits, reconcileRouteRateLimits } from "./routeRateLimits";

interface Entry {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}
interface Stanza {
  ratelimits?: Entry[];
}
type Config = Stanza & { env?: Record<string, Stanza> };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-route-rate-limits-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const WRANGLER = `{
  // The Worker.
  "name": "replay-board",
  "ratelimits": [
    // Sign-in's flood guard.
    { "name": "AUTH_RATE_LIMITER", "namespace_id": "3093", "simple": { "limit": 100, "period": 60 } }
  ],
  "env": {
    "staging": {
      "ratelimits": [
        { "name": "AUTH_RATE_LIMITER", "namespace_id": "3093", "simple": { "limit": 100, "period": 60 } },
        { "name": "ROUTE_RATE_LIMIT_9_PER_10S", "namespace_id": "1234", "simple": { "limit": 9, "period": 10 } }
      ]
    },
    "prod": {}
  }
}
`;

const read = async (): Promise<Config> =>
  parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as Config;

const names = (stanza: Stanza | undefined): string[] => (stanza?.ratelimits ?? []).map((entry) => entry.name);

describe("reconcileRouteRateLimits", () => {
  const limits = [{ name: "ROUTE_RATE_LIMIT_20_PER_60S", limit: 20, period: 60 as const }];

  test("writes each declared limit into every stanza, with its policy and its derived namespace", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
    const runs = await reconcileRouteRateLimits({ workerDir: dir, limits });
    const config = await read();
    for (const stanza of [config, config.env?.staging, config.env?.prod]) {
      expect(stanza?.ratelimits).toContainEqual({
        name: "ROUTE_RATE_LIMIT_20_PER_60S",
        namespace_id: rateLimitNamespaceId("ROUTE_RATE_LIMIT_20_PER_60S"),
        simple: { limit: 20, period: 60 },
      });
    }
    expect(runs.map((run) => [run.env, run.written, run.removed])).toEqual([
      ["dev", ["ROUTE_RATE_LIMIT_20_PER_60S"], []],
      ["staging", ["ROUTE_RATE_LIMIT_20_PER_60S"], ["ROUTE_RATE_LIMIT_9_PER_10S"]],
      ["prod", ["ROUTE_RATE_LIMIT_20_PER_60S"], []],
    ]);
  });

  test("takes out a route limiter no route declares, and leaves every other limiter and its comment alone", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
    await reconcileRouteRateLimits({ workerDir: dir, limits: [] });
    const config = await read();
    expect(names(config.env?.staging)).toEqual(["AUTH_RATE_LIMITER"]);
    expect(names(config)).toEqual(["AUTH_RATE_LIMITER"]);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toContain("// Sign-in's flood guard.");
  });

  test("a second run changes nothing and writes no bytes", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
    await reconcileRouteRateLimits({ workerDir: dir, limits });
    const once = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    const runs = await reconcileRouteRateLimits({ workerDir: dir, limits });
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(once);
    expect(runs.every((run) => run.written.length === 0 && run.removed.length === 0)).toBe(true);
  });

  test("--env reconciles that stanza alone", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
    const runs = await reconcileRouteRateLimits({ workerDir: dir, limits, env: "prod" });
    const config = await read();
    expect(runs.map((run) => run.env)).toEqual(["prod"]);
    expect(names(config.env?.prod)).toEqual(["ROUTE_RATE_LIMIT_20_PER_60S"]);
    expect(names(config)).toEqual(["AUTH_RATE_LIMITER"]);
  });

  test("a Worker that never declared a limit and still declares none is left byte for byte", async () => {
    const plain = `{\n  "name": "replay-board"\n}\n`;
    await writeFile(join(dir, "wrangler.jsonc"), plain);
    await reconcileRouteRateLimits({ workerDir: dir, limits: [] });
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(plain);
  });
});

describe("composedRouteRateLimits", () => {
  test("reads every limit off the routes the Worker composes, app and libraries alike", () => {
    const library = defineCapability({
      name: "library",
      requiredBindings: [],
      routes: (app) => {
        app.post(
          "/library/upload",
          describeRoute({
            summary: "Upload.",
            verification: "public",
            responses: { 200: { description: "Stored." } },
            rateLimit: { key: "ip", limit: 5, period: 10 },
          }),
          (c) => c.text(""),
        );
      },
    });
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (hono) => {
        hono.post(
          "/runs",
          describeRoute({
            summary: "Submit a run.",
            verification: "bearer",
            responses: { 200: { description: "Recorded." } },
            rateLimit: { key: "user", limit: 20, period: 60 },
          }),
          (c) => c.text(""),
        );
      },
    });
    expect(composedRouteRateLimits("dev", { capabilities: [library], app })).toEqual([
      { name: "ROUTE_RATE_LIMIT_20_PER_60S", limit: 20, period: 60 },
      { name: "ROUTE_RATE_LIMIT_5_PER_10S", limit: 5, period: 10 },
    ]);
  });
});

describe("addRouteRateLimits", () => {
  const limitedApp = defineCapability({
    name: "app",
    requiredBindings: [],
    routes: (hono) => {
      hono.post(
        "/runs",
        describeRoute({
          summary: "Submit a run.",
          verification: "bearer",
          responses: { 200: { description: "Recorded." } },
          rateLimit: { key: "user", limit: 20, period: 60 },
        }),
        (c) => c.text(""),
      );
    },
  });

  test("writes what pithy worker sync would, and says so", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), `{\n  "name": "replay-board"\n}\n`);
    const notes = await addRouteRateLimits({
      projectDir: dir,
      workerDir: dir,
      config: async () => ({ capabilities: [], app: limitedApp }),
    });
    expect(names(await read())).toEqual(["ROUTE_RATE_LIMIT_20_PER_60S"]);
    expect(notes).toEqual(["Rate limiters written for the routes that declare them: ROUTE_RATE_LIMIT_20_PER_60S."]);
  });

  test("a Worker that does not compose yet is left alone, for pithy worker sync to finish", async () => {
    const plain = `{\n  "name": "replay-board"\n}\n`;
    await writeFile(join(dir, "wrangler.jsonc"), plain);
    const notes = await addRouteRateLimits({
      projectDir: dir,
      workerDir: dir,
      config: async () => {
        throw new Error("The secrets capability is not composed.");
      },
    });
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(plain);
    expect(notes).toEqual([]);
  });
});
