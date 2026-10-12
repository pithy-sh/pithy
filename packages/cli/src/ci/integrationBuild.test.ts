// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

/**
 * **`integration.yml` builds what its tests import (#709).**
 *
 * Its first run failed before a single test: the workflow installs and runs `bun run test:integration`,
 * with no build, and turbo's `test:integration` declared no `dependsOn`. Every `@pithy-sh/*` import
 * resolves through an `exports` map into `dist/`, which a fresh checkout does not have, so every suite
 * died on `Cannot find module`. Nobody saw it because the workflow runs only on a release tag or by hand.
 *
 * `ci.yml`'s test jobs get their build from turbo — `test` depends on `^build` and `build` — so this does
 * it the same way, and asks turbo for the plan rather than reading the config: a `dependsOn` that is
 * present and does not do what it looks like is the failure a plan shows and a parse does not.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

/** One task in turbo's plan. */
interface Planned {
  taskId: string;
  task: string;
  package: string;
  command: string;
  dependencies: string[];
}

/** Turbo's plan for `task` across the workspace. */
async function plan(task: string): Promise<Planned[]> {
  const { stdout } = await promisify(execFile)(TURBO, ["run", task, "--dry=json"], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(stdout) as { tasks: Planned[] }).tasks;
}

/** What turbo plans for a package that does not define the script. It never runs. */
const NO_SCRIPT = "<NONEXISTENT>";

describe("the integration suites run on a build", () => {
  test("the workflow runs them through turbo, where the build is declared", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "integration.yml"), "utf8");
    expect(workflow).toMatch(/^\s*run: bun run test:integration\s*$/m);
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["test:integration"]).toMatch(/^turbo run test:integration\b/);
  });

  test("every package with an integration suite builds itself and what it depends on first", {
    timeout: 60_000,
  }, async () => {
    const tasks = await plan("test:integration");
    const suites = tasks.filter((entry) => entry.task === "test:integration" && entry.command !== NO_SCRIPT);
    // Not vacuous: these are the packages that hold live suites today.
    expect(suites.map((entry) => entry.package)).toEqual(
      expect.arrayContaining(["@pithy-sh/cli", "@pithy-sh/cloudflare", "@pithy-sh/secrets"]),
    );
    for (const suite of suites) {
      expect(suite.dependencies, suite.taskId).toContain(`${suite.package}#build`);
    }
    // `^build` too: the CLI's suites import core and cloudflare through their `exports` maps.
    const cli = suites.find((entry) => entry.package === "@pithy-sh/cli");
    expect(cli?.dependencies).toEqual(expect.arrayContaining(["@pithy-sh/core#build", "@pithy-sh/cloudflare#build"]));
  });
});
