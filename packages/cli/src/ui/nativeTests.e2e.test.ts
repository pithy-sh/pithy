// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
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
 */

const exec = promisify(execFile);

/** `@pithy-sh/ui-react-native`'s root, whose `node_modules` supplies the app. */
const PACKAGE = dirname(TEMPLATE_DIR);

/** This CLI's root, whose `node_modules` holds every kit capability. */
const CLI = join(import.meta.dirname, "..", "..");

let root: string;
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

/** Run the app's own Vitest in `apps/app`, as its `test` script does. */
async function appTests(): Promise<{ code: number; output: string }> {
  const vitest = join(project, "node_modules", "vitest", "vitest.mjs");
  return await new Promise((settle) => {
    const child = spawn(process.execPath, [vitest, "run", "--reporter=verbose"], {
      cwd: join(project, "apps", "app"),
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-native-tests-"));
  project = join(root, "acme");
  await runCaptured("init", ["--dir", project, "--name", "acme", "--target", "both", "--react-native", "--json"]);

  installed = join(project, "node_modules", "@pithy-sh", "ui-react-native");
  await mkdir(installed, { recursive: true });
  const tarball = join(root, "ui-react-native.tgz");
  await exec("bun", ["pm", "pack", "--quiet", "--filename", tarball], { cwd: PACKAGE });
  await exec("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
  await linkPackages(join(PACKAGE, "node_modules"), join(project, "node_modules"));
  // The capabilities auth composes with, for the Worker's config to load once it is added. The app's own packages
  // are linked first, so they win.
  await linkPackages(join(CLI, "node_modules"), join(project, "node_modules"));
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
