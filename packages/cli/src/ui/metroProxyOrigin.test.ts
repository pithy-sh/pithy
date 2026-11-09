// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react-native/src/templates";
import { afterEach, describe, expect, test } from "vitest";
import { buildWorkerEnv } from "../dev/env";
import { buildDevConfig } from "../feature/devConfig";
import { discoverWorkers } from "../project/workers";

/**
 * The Expo web build's dev proxy (`templates/metro-proxy.cjs`) reads the Worker's origin from the variable `pithy dev`
 * exports for it. The proxy derives that variable's name on its own, from the app's `ui.worker` and that Worker's
 * `wrangler.jsonc`, so this holds it to the name `pithy dev` actually exports, from the same files.
 */

const proxy = createRequire(import.meta.url)(join(TEMPLATE_DIR, "metro-proxy.cjs")) as {
  workerOriginVar(appDir: string): string | null;
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(wrangler: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pithy-metro-origin-"));
  dirs.push(root);
  await mkdir(join(root, "apps", "app"), { recursive: true });
  await writeFile(
    join(root, "apps", "app", "pithy.worker.jsonc"),
    '{ "dev": { "command": ["bun", "x", "expo", "start"] }, "ui": { "stub": "react-native", "build": ["expo", "export"], "worker": "api" } }\n',
  );
  await mkdir(join(root, "apps", "api"), { recursive: true });
  if (wrangler === null) await writeFile(join(root, "apps", "api", "pithy.worker.jsonc"), "{}\n");
  else await writeFile(join(root, "apps", "api", "wrangler.jsonc"), wrangler);
  return root;
}

describe("the Worker origin the Expo dev proxy reads", () => {
  test.each([
    ["a Worker its wrangler.jsonc names", '{\n  // Deployed as\n  "name": "demo-api",\n}\n', "demo-api"],
    ["a Worker whose wrangler.jsonc names none", '{ "main": "src/index.ts" }\n', "api"],
    ["a Worker with no wrangler.jsonc", null, "api"],
  ])("is the variable pithy dev exports for %s", async (_case, wrangler, expected) => {
    const root = await project(wrangler);
    const workers = await discoverWorkers(root);
    const config = buildDevConfig({ branch: "feature/1-demo", block: { block: 3, base: 8817, size: 10 }, workers });
    const env = buildWorkerEnv(config, {});
    const variable = proxy.workerOriginVar(join(root, "apps", "app"));
    expect(variable).not.toBeNull();
    expect(env[variable ?? ""]).toBe(config.workers[expected]?.origin);
  });
});
