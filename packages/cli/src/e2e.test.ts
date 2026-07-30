// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, expect, test } from "vitest";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

/**
 * The Phase 0 definition of done, executed end to end: an empty directory becomes
 * a Worker that boots, validates per-env config, serves `GET /health`, and runs
 * its (empty) migration registry clean.
 *
 * The scaffold lands inside the package — not the OS tmpdir — so its
 * `@pithy-sh/core` and `hono` imports resolve against the workspace node_modules
 * (the "linked workspace packages" leg). A literal `bun install` would instead
 * reach for the unpublished `@pithy-sh/core@^0.0.0` on npm; the in-package
 * scaffold is the faithful local stand-in, matching `bin.test.ts`.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", ".e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("empty dir → init → boots, serves /health 200, migrates the empty registry clean", async () => {
  const target = join(dir, "app");

  // 1. Scaffold non-interactively — the way an agent drives it (spec §10.20).
  await run("bun", [bin, "init", "--name", "smoke-app", "--dir", target, "--json"]);

  // 2. The scaffold's worker lives in apps/api and carries dev, staging, and production config paths.
  const workerDir = join(target, "apps", "api");
  const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
    compatibility_date: string;
    compatibility_flags: string[];
    env: { staging: unknown; production: unknown };
  };
  expect(wrangler.env.staging).toBeDefined();
  expect(wrangler.env.production).toBeDefined();

  // 3. Bundle the Worker entry — resolving `@pithy-sh/core` and `hono` — and boot
  //    it under Miniflare, the same workerd runtime `wrangler dev` runs locally,
  //    using the scaffold's own compatibility settings.
  const bundle = join(target, ".worker.mjs");
  await run("bun", ["build", join(workerDir, "src", "index.ts"), "--outfile", bundle, "--target=node"]);
  const miniflare = new Miniflare({
    modules: true,
    script: await readFile(bundle, "utf8"),
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
  });
  try {
    const res = await miniflare.dispatchFetch("http://localhost/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  } finally {
    await miniflare.dispose();
  }

  // 4. The empty migration registry runs clean — no databases, no error — reported per worker.
  const { stdout } = await run("bun", [bin, "migrate", "--json"], { cwd: target });
  expect(JSON.parse(stdout.trim())).toEqual({
    command: "migrate",
    env: "dev",
    rollback: false,
    workers: [{ worker: "smoke-app-api", databases: [] }],
  });
});
