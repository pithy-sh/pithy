// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { routesOf } from "@pithy-sh/core/src/http/lazyRoutes";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "./config";
import { assertRouteTablesDeployable, assertRouteTablesShip } from "./routeTables";

/** A capability whose `POST /notes` opts in as an MCP tool and names no effect. */
const loose = defineCapability({
  name: "notes",
  requiredBindings: [],
  routes: routesOf((app) => {
    app.post(
      "/notes",
      describeRoute({
        summary: "Write a note.",
        verification: "public",
        operation: "notes.write",
        tool: true,
        responses: { 200: { description: "Written.", contentType: "text/plain" } },
      }),
      (c) => c.text("ok"),
    );
  }),
});

/** The same route, declared as a write. */
const sound = defineCapability({
  name: "notes",
  requiredBindings: [],
  routes: routesOf((app) => {
    app.post(
      "/notes",
      describeRoute({
        summary: "Write a note.",
        verification: "public",
        operation: "notes.write",
        tool: { effect: "writes" },
        responses: { 200: { description: "Written.", contentType: "text/plain" } },
      }),
      (c) => c.text("ok"),
    );
  }),
});

/** A capability whose routes module cannot load here. */
const unloadable = defineCapability({
  name: "native",
  requiredBindings: [],
  routes: {
    declared: [{ method: "GET", path: "/native" }],
    load: async () => {
      throw new TypeError("No such module cloudflare:sockets.");
    },
  },
});

const worker = (capabilities: WorkerConfig["capabilities"]) => ({
  dir: "/p/apps/api",
  config: { capabilities } as WorkerConfig,
});

describe("assertRouteTablesShip", () => {
  test("refuses a Worker whose route table its runtime would refuse, naming the Worker", async () => {
    const failure = await assertRouteTablesShip([worker([loose])], "prod").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.code).toBe("core/precondition_failed");
    expect((failure as PithyError).payload.message).toMatch(/^api will not run as configured: /);
    expect((failure as PithyError).payload.message).toMatch(/without an effect/);
  });

  test("passes a Worker whose route table reads cleanly", async () => {
    await expect(assertRouteTablesShip([worker([sound])], "prod")).resolves.toBeUndefined();
  });

  test("leaves a route module that cannot load here to the Worker", async () => {
    await expect(assertRouteTablesShip([worker([unloadable])], "prod")).resolves.toBeUndefined();
  });
});

describe("assertRouteTablesDeployable", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-route-tables-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A project with one Worker composing the capability literal given. */
  async function project(capability: string): Promise<void> {
    await writeFile(join(dir, "pithy.config.ts"), `export default { name: "replay", environments: ["prod"] };\n`);
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), '{ "name": "replay-api" }\n');
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
    await writeFile(join(workerDir, "pithy.config.ts"), `export default { capabilities: [${capability}] };\n`);
  }

  test("refuses pithy deploy for a Worker that would refuse to start", async () => {
    await project(`{ name: "board", requiredBindings: [], messages: { en: { "auth/sign_in.title": "Sign in" } } }`);
    await expect(assertRouteTablesDeployable(dir, "prod")).rejects.toThrow(/api will not run as configured/);
  });

  test("deploys a Worker that composes cleanly", async () => {
    await project(`{ name: "board", requiredBindings: [], messages: { en: { "board/nav.title": "Board" } } }`);
    await expect(assertRouteTablesDeployable(dir, "prod")).resolves.toBeUndefined();
  });
});
