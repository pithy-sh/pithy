// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "./worker";

const sync = (worker.subCommands as Record<string, CommandDef>).sync as CommandDef;

const INSTRUCTION = "Export a WorkflowEntrypoint subclass";

let dir: string;
let cwd: string;
let workerDir: string;

/**
 * Project `replay`, Worker `apps/board`, declaring a digest and a sweep job. The project and Worker names differ,
 * so a check that resolved main against the wrong one reads nothing.
 */
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-exports-"));
  cwd = process.cwd();
  process.chdir(dir);
  workerDir = join(dir, "apps", "board");
  await mkdir(join(workerDir, "src"), { recursive: true });
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
  await wrangler({ main: "src/index.ts" });
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    `export default {
  app: {
    name: "board",
    requiredBindings: [],
    workflows: {
      digest: { binding: "DIGEST", className: "DigestWorkflow", schedule: "0 4 * * *" },
      sweep: { binding: "SWEEP", className: "SweepWorkflow" },
    },
  },
  capabilities: [],
};
`,
  );
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

async function wrangler(extra: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    `${JSON.stringify({ name: "replay-board", ...extra, env: { prod: { vars: { ENVIRONMENT: "prod" } } } }, null, 2)}\n`,
  );
}

async function entry(source: string): Promise<void> {
  await writeFile(join(workerDir, "src", "index.ts"), source);
}

/** `pithy worker sync --env prod` with `flags`, run from the project root, with what it printed. */
async function run(flags: Record<string, boolean> = {}): Promise<string> {
  const written: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await sync.run?.({ args: { json: false, env: "prod", ...flags }, rawArgs: [] } as never);
  } finally {
    stdout.mockRestore();
  }
  return written.join("");
}

describe("pithy worker sync and the Workflow classes main exports", () => {
  test("says nothing about exports when main exports every class", async () => {
    await entry('export default {};\nexport class DigestWorkflow {}\nexport { SweepWorkflow } from "./sweep";\n');

    const said = await run();
    expect(said).toContain("prod: DIGEST, SWEEP bound.");
    expect(said).not.toContain(INSTRUCTION);
  });

  test("names exactly the class main does not export", async () => {
    await entry("export default {};\nexport class DigestWorkflow {}\n");

    const said = await run();
    expect(said).toContain(`${INSTRUCTION} from src/index.ts for each: SweepWorkflow.`);
    expect(said).not.toContain("DigestWorkflow.");
  });

  test("says so on a run that changed nothing too", async () => {
    await entry("export default {};\n");
    await run();

    const said = await run();
    expect(said).toContain("is already in sync.");
    expect(said).toContain(`${INSTRUCTION} from src/index.ts for each: DigestWorkflow, SweepWorkflow.`);
  });

  test("says it could not read main, instead of the instruction", async () => {
    const said = await run();
    expect(said).toContain("Could not check main exports each Workflow class: src/index.ts could not be read.");
    expect(said).not.toContain(INSTRUCTION);
  });

  test("a wrangler.jsonc naming no main says that", async () => {
    await wrangler({});

    const said = await run();
    expect(said).toContain("Could not check main exports each Workflow class: wrangler.jsonc names no main module.");
    expect(said).not.toContain(INSTRUCTION);
  });

  test("--json carries the classes main does not export", async () => {
    await entry("export default {};\nexport class DigestWorkflow {}\n");

    const payload = JSON.parse(await run({ json: true }));
    expect(payload.exports).toEqual({ state: "missing", main: "src/index.ts", missing: ["SweepWorkflow"] });
  });

  test("--json says main could not be read", async () => {
    const payload = JSON.parse(await run({ json: true }));
    expect(payload.exports).toEqual({ state: "unreadable", reason: "src/index.ts could not be read" });
  });

  test("--json says every class is exported", async () => {
    await entry("export default {};\nexport class DigestWorkflow {}\nexport class SweepWorkflow {}\n");

    const payload = JSON.parse(await run({ json: true }));
    expect(payload.exports).toEqual({ state: "exported" });
  });

  test("--dry-run plans the line the real run prints", async () => {
    await entry("export default {};\nexport class DigestWorkflow {}\n");
    const line = `${INSTRUCTION} from src/index.ts for each: SweepWorkflow.`;

    const planned = await run({ "dry-run": true });
    expect(planned).toContain(line);
    expect(planned).toContain("Dry run. Nothing written.");
    const payload = JSON.parse(await run({ "dry-run": true, json: true }));
    expect(payload.plan.notes).toContain(line);
    expect(payload.exports).toEqual({ state: "missing", main: "src/index.ts", missing: ["SweepWorkflow"] });
    expect(await run()).toContain(line);
  });
});
