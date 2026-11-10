// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import { snapshotTree } from "../test-utils/treeSnapshot";

/** An app capability declaring a database and a bucket the scaffolded stanzas lack. */
const APP_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({
  name: "app",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "r2", name: "PUBLISHED" },
  ],
});

export default { capabilities: [], app };
`;

/** A Worker composing one queue and no app, so a project with no name skips the queue rather than refusing. */
const QUEUE_ONLY_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const jobs = defineCapability({
  name: "jobs",
  requiredBindings: [{ type: "queue", name: "JOBS" }],
});

export default { capabilities: [jobs] };
`;

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  await linkKitPackages(dir, ["core"]);
  worker = join(dir, "apps", "board");
  await writeFile(join(worker, "pithy.config.ts"), APP_CONFIG);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The run again, from a fresh `cwd` spy: `runCaptured` restores every mock it made when it returns. */
async function again(args: string[]): Promise<string[]> {
  vi.restoreAllMocks();
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  return runCaptured("worker sync", args);
}

describe("pithy worker sync --dry-run", () => {
  test("--json: the published payload with its plan, and nothing written", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("worker sync", ["--worker", "board", "--dry-run", "--json"]);

    await expectConforms("worker sync", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "worker.sync", dryRun: true, worker: "board" });
    expect(payload.bindings[0]?.written).toEqual([
      { binding: "DB", type: "d1" },
      { binding: "PUBLISHED", type: "r2" },
    ]);
    const plan = Plan.parse(payload.plan);
    expect(plan.files.map((file) => [file.path, file.action])).toEqual([["apps/board/wrangler.jsonc", "edit"]]);
    expect(plan.files[0]?.diff).toContain('+  "r2_buckets": [{ "binding": "PUBLISHED" }],');
    expect(plan.files[0]?.changes).toContain("dev: DB, PUBLISHED written.");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("the plan is the bytes the real run writes", async () => {
    const dry = JSON.parse((await runCaptured("worker sync", ["--worker", "board", "--dry-run", "--json"])).join(""));
    const real = JSON.parse((await again(["--worker", "board", "--json"])).join(""));
    expect(real.dryRun).toBe(false);
    expect(real).not.toHaveProperty("plan");
    const { plan: _plan, dryRun: _dryRun, ...reported } = dry;
    const { dryRun: _realDryRun, ...realReported } = real;
    expect(reported).toEqual(realReported);
  });

  test("text: the plan, then the dry-run line in place of Done.", async () => {
    const before = await snapshotTree(dir);
    const lines = (await runCaptured("worker sync", ["--worker", "board", "--dry-run"])).join("").trimEnd().split("\n");
    expect(lines[0]).toBe("Would edit apps/board/wrangler.jsonc.");
    expect(lines).toContain("  staging: DB, PUBLISHED written.");
    expect(lines.at(-1)).toBe("Dry run. Nothing written.");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("a Worker already in sync plans nothing", async () => {
    await runCaptured("worker sync", ["--worker", "board"]);
    const before = await snapshotTree(dir);
    const payload = JSON.parse((await again(["--worker", "board", "--dry-run", "--json"])).join(""));
    expect(Plan.parse(payload.plan).files).toEqual([]);
    const lines = (await again(["--worker", "board", "--dry-run"])).join("").trimEnd().split("\n");
    expect(lines).toEqual(["Nothing to change.", "Dry run. Nothing written."]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("a Worker whose every binding is skipped plans the sentences the real run prints", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await writeFile(join(worker, "pithy.config.ts"), QUEUE_ONLY_CONFIG);
    const before = await snapshotTree(dir);
    const dry = (await again(["--worker", "board", "--dry-run"])).join("").trimEnd().split("\n");
    const payload = JSON.parse((await again(["--worker", "board", "--dry-run", "--json"])).join(""));
    expect(await snapshotTree(dir)).toEqual(before);
    const real = (await again(["--worker", "board"])).join("").trimEnd().split("\n");

    const skipped = real.filter((line) => line.includes("JOBS not written: no project name is resolved."));
    expect(skipped.length).toBeGreaterThan(0);
    const plan = Plan.parse(payload.plan);
    expect(plan.files).toEqual([]);
    expect(plan.notes).toEqual(skipped);
    expect(dry).toEqual([...skipped, "Dry run. Nothing written."]);
  });

  test("refuses as the real run does, writing nothing", async () => {
    await writeFile(
      join(worker, "pithy.config.ts"),
      APP_CONFIG.replace("{ capabilities: [], app }", "{ capabilities: [], app, declinedBindings: { PUBLISHED: 42 } }"),
    );
    const before = await snapshotTree(dir);
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(runCaptured("worker sync", ["--worker", "board", "--dry-run"])).rejects.toThrow(/exit/);
    const said = errors.join("");
    expect(said).toContain("This Worker's `declinedBindings` declaration is not valid.");
    expect(said).not.toContain("pithy-plan-");
    expect(await snapshotTree(dir)).toEqual(before);
  });
});
