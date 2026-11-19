// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "comment-json";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rateLimitNamespaceId } from "../project/bindingEntries";
import { scaffoldProject } from "../project/scaffold";
import { WORKERS_TEST_CONFIG } from "../project/workersTestConfig";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/** An app capability with one route limited per user, the way an analytics ingest would be. */
const limitedConfig = (
  limit: number,
): string => `import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { routesOf } from "@pithy-sh/core/src/http/lazyRoutes";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: routesOf((hono) => {
    hono.post(
      "/ingest",
      describeRoute({
        summary: "Record an event.",
        verification: ["bearer", "session"],
        responses: { 204: { description: "Recorded." } },
        rateLimit: { key: "user", limit: ${limit}, period: 60 },
      }),
      (c) => c.body(null, 204),
    );
  }),
});

export default { capabilities: [], app };
`;

interface Stanza {
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
}
type Config = Stanza & { env?: Record<string, Stanza> };

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-rate-limits-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  await linkKitPackages(dir, ["core"]);
  worker = join(dir, "apps", "board");
  await writeFile(join(worker, "pithy.config.ts"), limitedConfig(20));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Config> =>
  parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Config;

const routeLimiters = (stanza: Stanza | undefined): string[] =>
  (stanza?.ratelimits ?? []).map((entry) => entry.name).filter((name) => name.startsWith("ROUTE_RATE_LIMIT_"));

describe("pithy worker sync writes the rate limiters a Worker's routes declare", () => {
  test("every stanza gets the binding, with its policy, and a second run changes nothing", async () => {
    const first = await runCaptured("worker sync", ["--worker", "board", "--json"]);
    await expectConforms("worker sync", first);
    const config = await read();
    const envs = ["dev", ...Object.keys(config.env ?? {})];
    for (const env of envs) {
      const stanza = env === "dev" ? config : config.env?.[env];
      expect(stanza?.ratelimits).toContainEqual({
        name: "ROUTE_RATE_LIMIT_20_PER_60S",
        namespace_id: rateLimitNamespaceId("ROUTE_RATE_LIMIT_20_PER_60S"),
        simple: { limit: 20, period: 60 },
      });
    }
    const payload = JSON.parse(first.join("")) as { rateLimits: { env: string; written: string[] }[] };
    expect(payload.rateLimits.map((run) => run.env)).toEqual(envs);
    expect(payload.rateLimits[0]?.written).toEqual(["ROUTE_RATE_LIMIT_20_PER_60S"]);

    const written = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    vi.restoreAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const second = await runCaptured("worker sync", ["--worker", "board"]);
    expect(second.join("")).toContain("replay-board is already in sync.");
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(written);
  });

  test("a changed limit swaps the binding: the new one is written, the one no route declares is taken out", async () => {
    // The limiter an earlier sync wrote for a limit of 20, and a route that now declares 50. Written before the
    // first run, because this process caches the config it loads.
    const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Config;
    config.ratelimits = [
      ...(config.ratelimits ?? []),
      { name: "ROUTE_RATE_LIMIT_20_PER_60S", namespace_id: "1001", simple: { limit: 20, period: 60 } },
    ];
    await writeFile(join(worker, "wrangler.jsonc"), stringify(config, null, 2));
    await writeFile(join(worker, "pithy.config.ts"), limitedConfig(50));
    const lines = (await runCaptured("worker sync", ["--worker", "board"])).join("");
    expect(lines).toContain("dev: ROUTE_RATE_LIMIT_50_PER_60S written.");
    expect(lines).toContain("dev: ROUTE_RATE_LIMIT_20_PER_60S removed.");
    expect(routeLimiters(await read())).toEqual(["ROUTE_RATE_LIMIT_50_PER_60S"]);
  });

  test("the Workers test config gets the limiter, so a Workers test reaches the route", async () => {
    await runCaptured("worker sync", ["--worker", "board"]);
    const source = await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8");
    expect(source).toContain(
      `ROUTE_RATE_LIMIT_20_PER_60S: { namespace_id: "${rateLimitNamespaceId("ROUTE_RATE_LIMIT_20_PER_60S")}", simple: { limit: 20, period: 60 } }`,
    );
  });
});
