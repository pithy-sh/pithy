// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../main";
import type { WorkerConfig } from "../project/config";
import { addWorker, removeWorker } from "../project/workerCommand";
import type { WorkerTarget } from "../project/workers";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { runUiAdd, runUiSync } from "../ui/flow";
import { describeCli } from "./describe";

/**
 * **`idempotent` is a claim about a second run, so it is checked by making one (#697).**
 *
 * The rule `pithy schema` publishes: a command is idempotent when running it again with the same arguments,
 * after it succeeded, succeeds and changes nothing further. A second run that is refused is not idempotent,
 * however clean the refusal: an agent that retries a step it cannot see the end of reads `idempotent: true`
 * as "safe to run again", and a retry that exits 3 is the answer it was promised it would not get. `ui add`
 * was published `true` and refused its own re-run with `core/conflict`, which is how this test came to exist.
 *
 * Every command here runs offline against a temporary project, twice, through the same function its command
 * calls. The project tree is compared across the second run, so "changes nothing further" is a fact about
 * the bytes rather than about what the report says. The rest of the tree reaches Cloudflare or a person and
 * cannot be driven here; their flags were audited by reading each command's re-run path.
 */

/** Run `once` twice. Whether the second succeeded and left `dir` byte-identical. */
async function rerunChangesNothing(dir: string, once: () => Promise<unknown>): Promise<boolean> {
  await once();
  const before = await snapshotTree(dir);
  try {
    await once();
  } catch {
    return false;
  }
  return JSON.stringify([...(await snapshotTree(dir))]) === JSON.stringify([...before]);
}

/** What `pithy schema` publishes for `path`. */
async function published(path: string): Promise<boolean> {
  const command = (await describeCli(main)).commands.find((entry) => entry.path === path);
  if (command === undefined) throw new Error(`no command ${path}`);
  return command.idempotent;
}

/** A capability mounting one route, enough for a route table. */
const ROUTED: WorkerConfig = {
  capabilities: [
    defineCapability({
      name: "leaderboard",
      requiredBindings: [],
      routes: (app) => {
        app.get("/leaderboard", (c) => c.json({}));
      },
    }),
  ],
};

let projectDir: string;
let workerDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-idempotent-"));
  workerDir = join(projectDir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "replay-board"\n}\n');
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{\n  "dev": {}\n}\n');
  await writeFile(join(workerDir, "package.json"), `${JSON.stringify({ name: "replay-board" }, null, 2)}\n`);
  await writeFile(join(projectDir, "tsconfig.json"), `${JSON.stringify({ files: [], references: [] }, null, 2)}\n`);
  await writeFile(join(projectDir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** The workers under `apps/`, as discovery would report them, without discovery. */
function discover(names: string[]): () => Promise<WorkerTarget[]> {
  return async () =>
    names.map((name) => ({
      name,
      dir: join(projectDir, "apps", name),
      dev: { readySignal: "Ready on https?://" },
      hasWrangler: true,
    }));
}

const uiAdd = () =>
  runUiAdd({ projectDir, workerDir, config: ROUTED, framework: "react", packageManager: "bun", auth: false });

describe("a command's published idempotent flag is what its second run does", () => {
  test("ui add: the second run is refused, so it is not idempotent", async () => {
    const observed = await rerunChangesNothing(projectDir, uiAdd);
    expect(observed).toBe(false);
    expect(await published("ui add")).toBe(observed);
  });

  test("ui sync: the second run moves nothing, so it is idempotent", async () => {
    await uiAdd();
    const observed = await rerunChangesNothing(projectDir, () => runUiSync({ projectDir, workerDir, config: ROUTED }));
    expect(observed).toBe(true);
    expect(await published("ui sync")).toBe(observed);
  });

  test("worker add: the directory exists the second time, so it is not idempotent", async () => {
    const observed = await rerunChangesNothing(projectDir, () =>
      addWorker({
        projectDir,
        name: "web",
        mainRoot: projectDir,
        install: async () => {},
        discoverWorkers: discover(["board", "web"]),
      }),
    );
    expect(observed).toBe(false);
    expect(await published("worker add")).toBe(observed);
  });

  test("worker remove: the worker is gone the second time, so it is not idempotent", async () => {
    let present = ["board"];
    const observed = await rerunChangesNothing(projectDir, async () => {
      await removeWorker({ projectDir, name: "board", mainRoot: projectDir, discoverWorkers: discover(present) });
      present = [];
    });
    expect(observed).toBe(false);
    expect(await published("worker remove")).toBe(observed);
  });

  /** The probe itself: a run that refuses, and a run that writes, are each told apart from a clean re-run. */
  test("the probe tells a refusal and a write apart from a clean re-run", async () => {
    let calls = 0;
    expect(
      await rerunChangesNothing(projectDir, async () => {
        calls += 1;
        if (calls > 1) throw new Error("refused");
      }),
    ).toBe(false);
    expect(
      await rerunChangesNothing(projectDir, async () => {
        calls += 1;
        await writeFile(join(projectDir, `run-${calls}`), "x");
      }),
    ).toBe(false);
    expect(await rerunChangesNothing(projectDir, async () => {})).toBe(true);
  });
});
