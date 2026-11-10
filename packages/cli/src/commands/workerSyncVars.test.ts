// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import { snapshotTree } from "../test-utils/treeSnapshot";

/** A Worker declaring one var and nothing else: no app, no domains, no bindings. */
const VARS_CONFIG = `import { defineVars } from "@pithy-sh/core/src/worker/vars";
import { z } from "zod";

export const VARS = defineVars({
  READY_AFTER_MINUTES: {
    description: "Minutes after the cron the next file is ready.",
    schema: z.number().int().min(0),
    default: 15,
    environments: { prod: 30 },
  },
});

export default { capabilities: [], vars: VARS };
`;

type Config = { vars?: Record<string, unknown>; env: Record<string, { vars?: Record<string, unknown> }> };

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-vars-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  await linkKitPackages(dir, ["core"]);
  const zod = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await symlink(await realpath(zod), join(dir, "node_modules", "zod"));
  worker = join(dir, "apps", "board");
  await writeFile(join(worker, "pithy.config.ts"), VARS_CONFIG);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function again(args: string[]): Promise<string[]> {
  vi.restoreAllMocks();
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  return runCaptured("worker sync", args);
}

async function wrangler(): Promise<Config> {
  return parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Config;
}

describe("pithy worker sync writes declared vars", () => {
  test("--json: each stanza's var, at its environment's value or the default", async () => {
    const written = await runCaptured("worker sync", ["--worker", "board", "--json"]);
    await expectConforms("worker sync", written);
    const payload = JSON.parse(written.join(""));
    expect(payload.vars).toEqual([
      { env: "dev", written: [{ name: "READY_AFTER_MINUTES", value: 15 }], invalid: [] },
      { env: "staging", written: [{ name: "READY_AFTER_MINUTES", value: 15 }], invalid: [] },
      { env: "prod", written: [{ name: "READY_AFTER_MINUTES", value: 30 }], invalid: [] },
    ]);
    const config = await wrangler();
    expect(config.vars?.READY_AFTER_MINUTES).toBe(15);
    expect(config.env.staging?.vars?.READY_AFTER_MINUTES).toBe(15);
    expect(config.env.prod?.vars?.READY_AFTER_MINUTES).toBe(30);
    expect(config.env.prod?.vars?.ENVIRONMENT).toBe("prod");
  });

  test("text: one line per stanza written, then already in sync on the second run", async () => {
    const first = (await runCaptured("worker sync", ["--worker", "board"])).join("");
    expect(first).toContain("prod: READY_AFTER_MINUTES written.");
    const second = (await again(["--worker", "board"])).join("");
    expect(second).toContain("is already in sync.");
  });

  test("reports a hand-set value its declaration refuses, and keeps it", async () => {
    const text = (await readFile(join(worker, "wrangler.jsonc"), "utf8")).replace(
      '"ENVIRONMENT": "prod",',
      '"ENVIRONMENT": "prod",\n        "READY_AFTER_MINUTES": "soon",',
    );
    await writeFile(join(worker, "wrangler.jsonc"), text);
    const said = (await runCaptured("worker sync", ["--worker", "board"])).join("");
    expect(said).toMatch(/prod: READY_AFTER_MINUTES is "soon", which its declaration refuses: .+\. Kept\./);
    expect((await wrangler()).env.prod?.vars?.READY_AFTER_MINUTES).toBe("soon");
  });

  test("--dry-run plans each var write and writes nothing", async () => {
    const before = await snapshotTree(dir);
    const payload = JSON.parse(
      (await runCaptured("worker sync", ["--worker", "board", "--dry-run", "--json"])).join(""),
    );
    const plan = Plan.parse(payload.plan);
    expect(plan.files.map((file) => file.path)).toEqual(["apps/board/wrangler.jsonc"]);
    expect(plan.files[0]?.changes).toContain("prod: READY_AFTER_MINUTES written.");
    expect(plan.files[0]?.diff).toContain('"READY_AFTER_MINUTES": 30');
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("a stanza another write seeds this run takes its environment's value, not the top level's", async () => {
    await writeFile(
      join(worker, "pithy.config.ts"),
      VARS_CONFIG.replace(
        "export default { capabilities: [], vars: VARS };",
        'export default { capabilities: [], vars: VARS, domains: { prod: { pattern: "api.acme.com", zone: "acme.com" } } };',
      ),
    );
    await writeFile(
      join(worker, "wrangler.jsonc"),
      JSON.stringify({ name: "replay-board", vars: { ENVIRONMENT: "dev", READY_AFTER_MINUTES: 15 } }),
    );
    await runCaptured("worker sync", ["--worker", "board"]);
    const config = await wrangler();
    expect(config.env.prod?.vars?.READY_AFTER_MINUTES).toBe(30);
    expect(config.env.prod?.vars?.ENVIRONMENT).toBe("prod");
    expect((await again(["--worker", "board"])).join("")).toContain("is already in sync.");
  });

  test("rewrites a stanza holding the top level's value where the declaration gives it its own", async () => {
    await runCaptured("worker sync", ["--worker", "board"]);
    const text = (await readFile(join(worker, "wrangler.jsonc"), "utf8")).replace(
      '"READY_AFTER_MINUTES": 30',
      '"READY_AFTER_MINUTES": 15',
    );
    await writeFile(join(worker, "wrangler.jsonc"), text);
    const said = (await again(["--worker", "board"])).join("");
    expect(said).toContain("prod: READY_AFTER_MINUTES written.");
    expect((await wrangler()).env.prod?.vars?.READY_AFTER_MINUTES).toBe(30);
  });
});
