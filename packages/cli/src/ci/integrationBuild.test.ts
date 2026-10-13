// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { LIVE_FIXTURES } from "@pithy-sh/cloudflare/src/test-utils/fixtures";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

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
 *
 * **And it hands them their credentials.** The second run built, and then every live suite reported
 * `CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN are not set` with both set on the job: turbo runs in strict
 * env mode, so a task sees only the variables it declares, and `test:integration` declared none. So the plan
 * is asked for those too, against the keys the suites actually read: the fixture registry, the credential
 * loader's list, and every `process.env.X` a live suite or its harness names.
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
  environmentVariables: { specified: { passThroughEnv: string[] | null } };
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

  test("every package with an integration suite is handed every variable a live suite reads", {
    timeout: 60_000,
  }, async () => {
    const read = new Set<string>([
      ...CLOUDFLARE_ENV_KEYS,
      ...Object.values(LIVE_FIXTURES).flatMap((fixture) => fixture.keys),
    ]);
    for (const path of sourcePaths(join(REPO_ROOT, "packages"), { keep: (name) => name.endsWith(".ts") })) {
      // A live suite reads what it says and what the helpers it imports say. A unit test that sits beside those
      // helpers in test-utils/ is neither: it runs in `test`, never in `test:integration`.
      const liveSuite = path.endsWith(".integration.test.ts");
      const helper = path.includes(`${sep}test-utils${sep}`) && !path.endsWith(".test.ts");
      if (!liveSuite && !helper) continue;
      const text = readSource(path) ?? "";
      for (const match of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)) {
        read.add((match[1] ?? match[2]) as string);
      }
    }
    // Not vacuous: the credentials, a fixture-only key, and a key only a suite names.
    expect([...read]).toEqual(
      expect.arrayContaining(["CLOUDFLARE_API_TOKEN", "WORKERS_ROUTE_ZONE", "PITHY_EMAIL_LIVE"]),
    );
    const tasks = await plan("test:integration");
    const suites = tasks.filter((entry) => entry.task === "test:integration" && entry.command !== NO_SCRIPT);
    for (const suite of suites) {
      // `specified`, not `passthrough`: the latter lists only what this shell happens to have set.
      const handed = new Set(suite.environmentVariables.specified.passThroughEnv ?? []);
      expect([...read].filter((key) => !handed.has(key)).sort(), suite.taskId).toEqual([]);
    }
  });
});
