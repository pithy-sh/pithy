// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react-native/src/templates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runAdd } from "../capabilities/flow";
import { resolveSingleWorker } from "../project/workerScope";
import { runCaptured } from "../test-utils/payloadContract";
import { runUiAdd } from "./flow";

/**
 * **A freshly scaffolded Expo app's screen tests pass under its own `test` script.**
 *
 * The app's `vitest.config.ts` is `nativeTestProject` from `@pithy-sh/ui-react-native/testing/vitest`, and its
 * tests import stand-ins by package path, so what is on trial is the published package as an app installs it.
 * `@pithy-sh/ui-react-native` is therefore packed and unpacked into the project's `node_modules` as a real
 * directory, where Node loads the preset's build and Vitest transforms the stand-ins' TypeScript. Everything else
 * the app needs is linked from that package's own `node_modules`, which holds React Native, Expo, the runner and
 * the kit packages the screens import, and the Worker's capabilities come from this CLI's. The project stays outside any `node_modules`, as an adopter's does.
 *
 * A fresh scaffold composes no auth, so it is the bare home screen and its test. Composing auth and adding the
 * app's screens again writes the sign-in screen and its test, and the run takes both.
 *
 * A project whose root config predates the app's runner would collect those tests in plain Node, so adding the app
 * there leaves them out and says how to add them, and the project's own test run stays green.
 */

const exec = promisify(execFile);

/** `@pithy-sh/ui-react-native`'s root, whose `node_modules` supplies the app. */
const PACKAGE = dirname(TEMPLATE_DIR);

/** This CLI's root, whose `node_modules` holds every kit capability. */
const CLI = join(import.meta.dirname, "..", "..");

let root: string;
let tarball: string;
let project: string;
let installed: string;

/** Symlink `target` at `path`, resolved. An existing entry wins, so the first source linked is the one used. */
async function linkOne(target: string, path: string): Promise<void> {
  await symlink(await realpath(target), path).catch(() => undefined);
}

/** Link every package in the `node_modules` at `source` into the one at `target`, merging scopes. */
async function linkPackages(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source)) {
    if (entry.startsWith(".")) continue;
    if (!entry.startsWith("@")) {
      await linkOne(join(source, entry), join(target, entry));
      continue;
    }
    await mkdir(join(target, entry), { recursive: true });
    for (const scoped of await readdir(join(source, entry))) {
      await linkOne(join(source, entry, scoped), join(target, entry, scoped));
    }
  }
}

/** Run Vitest in `cwd` with `dir`'s copy, as a `test` script does. */
async function vitestIn(dir: string, cwd: string): Promise<{ code: number; output: string }> {
  const vitest = join(dir, "node_modules", "vitest", "vitest.mjs");
  return await new Promise((settle) => {
    const child = spawn(process.execPath, [vitest, "run", "--reporter=verbose"], {
      cwd,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", (code) => settle({ code: code ?? 1, output }));
  });
}

/** Run the app's own Vitest in `apps/app`, as its `test` script does. */
const appTests = (dir = project) => vitestIn(dir, join(dir, "apps", "app"));

/** Scaffold `name` with `pithy init` and give it a `node_modules` holding the packed package and everything else. */
async function scaffold(name: string, args: string[]): Promise<{ dir: string; installed: string }> {
  const dir = join(root, name);
  await runCaptured("init", ["--dir", dir, "--name", name, ...args, "--json"]);
  const at = join(dir, "node_modules", "@pithy-sh", "ui-react-native");
  await mkdir(at, { recursive: true });
  await exec("tar", ["-xzf", tarball, "-C", at, "--strip-components=1"]);
  await linkPackages(join(PACKAGE, "node_modules"), join(dir, "node_modules"));
  // The capabilities auth composes with, for the Worker's config to load once it is added. The app's own packages
  // are linked first, so they win.
  await linkPackages(join(CLI, "node_modules"), join(dir, "node_modules"));
  return { dir, installed: at };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-native-tests-"));
  tarball = join(root, "ui-react-native.tgz");
  await exec("bun", ["pm", "pack", "--quiet", "--filename", tarball], { cwd: PACKAGE });
  ({ dir: project, installed } = await scaffold("acme", ["--target", "both", "--react-native"]));
}, 180_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pithy init --target both --react-native", () => {
  test("the app's test script runs the home screen's test, and it passes", async () => {
    const pkg = JSON.parse(await readFile(join(project, "apps", "app", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe("vitest run");
    // The package as an install leaves it, not a link back into this checkout.
    expect((await lstat(installed)).isSymbolicLink()).toBe(false);
    const { code, output } = await appTests();
    expect({ code, output }).toMatchObject({ code: 0 });
    // `passWithNoTests` is on, so a run that collected nothing would exit 0 too.
    expect(output).toContain("src/routes/app/home.test.tsx");
    expect(output).toMatch(/Tests\s+3 passed/);
  }, 180_000);

  test("with auth composed and the screens added again, the sign-in test runs and passes too", async () => {
    const workerDir = join(project, "apps", "api");
    await runAdd({
      account: null,
      projectDir: project,
      workerDir,
      worker: "api",
      project: "acme",
      capability: "auth",
      withPrerequisites: true,
      install: async () => ({ packageManager: "bun" }),
      migrate: async () => [],
    });
    const target = await resolveSingleWorker({ projectDir: project, worker: "api" });
    await runUiAdd({
      projectDir: project,
      workerDir: target.dir,
      config: target.config,
      framework: "react-native",
      app: "app",
      auth: true,
      payments: false,
      packageManager: "bun",
      kitRanges: { installedFrom: [], latest: async () => "0.9.0" },
    });
    await expect(
      readFile(join(project, "apps", "app", "src", "routes", "pithy", "sign-in.test.tsx"), "utf8"),
    ).resolves.toContain("@pithy-sh/ui-react-native/testing/expo-secure-store");
    const { code, output } = await appTests();
    expect({ code, output }).toMatchObject({ code: 0 });
    expect(output).toContain("src/routes/pithy/sign-in.test.tsx");
    expect(output).toContain("src/routes/app/home.test.tsx");
    expect(output).toMatch(/Tests\s+5 passed/);
  }, 240_000);
});

/**
 * The root `vitest.config.ts` a project scaffolded before the app had a runner of its own: its `node` project
 * collects every app's `src` tests in plain Node and leaves none of them out. The Workers project is left off, as
 * it is beside the point here and its pool is not in the link farm.
 */
const ROOT_CONFIG_BEFORE = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["apps/*/src/**/*.test.{ts,tsx}"],
          exclude: ["apps/*/src/**/*.workers.test.{ts,tsx}"],
        },
      },
    ],
  },
});
`;

describe("pithy ui add react-native in a project whose root config predates the app's runner", () => {
  let old: string;

  beforeAll(async () => {
    ({ dir: old } = await scaffold("legacy", ["--target", "mobile"]));
    await writeFile(join(old, "vitest.config.ts"), ROOT_CONFIG_BEFORE);
  }, 180_000);

  /** Add the Expo app, as `pithy ui add react-native --app app` does. */
  async function addApp() {
    const target = await resolveSingleWorker({ projectDir: old, worker: "api" });
    return runUiAdd({
      projectDir: old,
      workerDir: target.dir,
      config: target.config,
      framework: "react-native",
      app: "app",
      auth: false,
      payments: false,
      packageManager: "bun",
      kitRanges: { installedFrom: [], latest: async () => "0.9.0" },
    });
  }

  test("leaves the screen tests out, says how to add them, and the root test run stays green", async () => {
    const report = await addApp();
    expect(report.screenTests).toEqual({
      seeded: false,
      remedy: expect.stringContaining('Add "apps/app/**" to the node project\'s exclude'),
    });
    const app = join(old, "apps", "app");
    for (const file of ["vitest.config.ts", join("src", "routes", "app", "home.test.tsx")]) {
      await expect(lstat(join(app, file)), file).rejects.toThrow();
    }
    const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts.test).toBeUndefined();
    expect(pkg.devDependencies?.vitest).toBeUndefined();

    const { code, output } = await vitestIn(old, old);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 180_000);

  test("and the test it held back is one that root run would have failed on", async () => {
    // The counterfactual, so the green above is the skip's doing: the bare home test, dropped where the scaffold
    // would have written it, is collected by the old node project and cannot load `react-native` there.
    const seeded = join(old, "apps", "app", "src", "routes", "app", "home.test.tsx");
    await cp(join(TEMPLATE_DIR, "src", "routes", "app", "home.bare.test.tsx"), seeded);
    try {
      const { code, output } = await vitestIn(old, old);
      expect(code, output).not.toBe(0);
      expect(output).toContain("home.test.tsx");
    } finally {
      await rm(seeded, { force: true });
    }
  }, 180_000);

  test("following the remedy adds the tests, and both runs are green", async () => {
    await writeFile(
      join(old, "vitest.config.ts"),
      ROOT_CONFIG_BEFORE.replace(
        'exclude: ["apps/*/src/**/*.workers.test.{ts,tsx}"]',
        'exclude: ["apps/*/src/**/*.workers.test.{ts,tsx}", "apps/app/**"]',
      ),
    );
    const report = await addApp();
    expect(report.screenTests).toEqual({ seeded: true, remedy: null });
    expect(report.created).toEqual(expect.arrayContaining(["vitest.config.ts", "src/routes/app/home.test.tsx"]));

    const rootRun = await vitestIn(old, old);
    expect(rootRun).toMatchObject({ code: 0 });
    const appRun = await appTests(old);
    expect(appRun).toMatchObject({ code: 0 });
    expect(appRun.output).toMatch(/Tests\s+3 passed/);
  }, 180_000);
});
