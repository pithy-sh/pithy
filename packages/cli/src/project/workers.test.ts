// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_READY_SIGNAL } from "./workerManifest";
import { discoverWorkers } from "./workers";

describe("discoverWorkers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-workers-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a real Worker: a `wrangler.jsonc` plus its `pithy.worker.jsonc` manifest. */
  async function writeWorker(at: string, name: string, dev?: Record<string, unknown>): Promise<void> {
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name }));
    await writeFile(join(at, "pithy.worker.jsonc"), JSON.stringify({ dev: dev ?? { autostart: true } }));
  }

  test("enumerates apps/* workers, named by their wrangler.jsonc, sorted, carrying their dev block", async () => {
    await writeWorker(join(dir, "apps", "web"), "pithy-web", { autostart: false, readySignal: "Local:\\s+http" });
    await writeWorker(join(dir, "apps", "api"), "pithy-api", { autostart: true });

    const workers = await discoverWorkers(dir);

    expect(workers).toEqual([
      {
        name: "pithy-api",
        dir: join(dir, "apps", "api"),
        dev: { autostart: true, readySignal: DEFAULT_READY_SIGNAL },
        hasWrangler: true,
      },
      {
        name: "pithy-web",
        dir: join(dir, "apps", "web"),
        dev: { autostart: false, readySignal: "Local:\\s+http" },
        hasWrangler: true,
      },
    ]);
  });

  test("discovers a non-Worker process (pithy.worker.jsonc, no wrangler.jsonc)", async () => {
    await writeWorker(join(dir, "apps", "api"), "pithy-api");
    const webDir = join(dir, "apps", "web");
    await mkdir(webDir, { recursive: true });
    await writeFile(
      join(webDir, "pithy.worker.jsonc"),
      JSON.stringify({ dev: { autostart: true, command: ["bun", "run", "dev"], readySignal: "Local:\\s+http" } }),
    );

    const workers = await discoverWorkers(dir);
    const web = workers.find((w) => w.name === "web");
    expect(web).toEqual({
      name: "web",
      dir: webDir,
      dev: { autostart: true, readySignal: "Local:\\s+http", command: ["bun", "run", "dev"] },
      hasWrangler: false,
    });
  });

  test("discovers a wrangler-only worker (no manifest) with a synthesized autostart dev block", async () => {
    const apiDir = join(dir, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "wrangler.jsonc"), JSON.stringify({ name: "pithy-api" }));

    const workers = await discoverWorkers(dir);
    expect(workers).toEqual([
      {
        name: "pithy-api",
        dir: apiDir,
        dev: { autostart: true, readySignal: DEFAULT_READY_SIGNAL },
        hasWrangler: true,
      },
    ]);
  });

  test("ignores apps/ entries with neither a manifest nor a wrangler.jsonc", async () => {
    await writeWorker(join(dir, "apps", "api"), "pithy-api");
    await mkdir(join(dir, "apps", "notes"), { recursive: true });

    const workers = await discoverWorkers(dir);

    expect(workers.map((w) => w.name)).toEqual(["pithy-api"]);
  });

  test("ignores a stray root wrangler.jsonc — every worker lives in apps/<name>", async () => {
    // There is no root worker. A leftover root wrangler.jsonc is not a Worker and must not be discovered,
    // or its capabilities and DO class migrations would attach to a script nothing deploys.
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "acme" }));
    await writeWorker(join(dir, "apps", "web"), "acme-web", { autostart: true, readySignal: "Local:\\s+http" });

    const names = (await discoverWorkers(dir)).map((w) => w.name);
    expect(names).toEqual(["acme-web"]);
  });

  test("returns nothing when apps/ holds no workers", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "acme" }));
    expect(await discoverWorkers(dir)).toEqual([]);
  });
});
