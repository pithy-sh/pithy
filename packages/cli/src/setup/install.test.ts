// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { removeTempDir } from "../test-utils/tempRepo";
import { frozenInstallArgs, installDependencies, planInstall } from "./install";

/**
 * **`pithy setup` installs with the project's own package manager, against the lockfile it has (#764).** The
 * manager is the lockfile's, the install is the one that refuses to move it, and a project with no lockfile yet
 * gets the one install that writes its first — which changes nothing a checkout already tracks.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function project(lockfile?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-setup-install-"));
  dirs.push(dir);
  if (lockfile !== undefined) await writeFile(join(dir, lockfile), "lock\n");
  return dir;
}

describe("frozenInstallArgs", () => {
  test.each([
    ["bun", ["install", "--frozen-lockfile"]],
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["yarn", ["install", "--frozen-lockfile"]],
    ["npm", ["ci"]],
  ] as const)("%s refuses to rewrite its lockfile", (pm, argv) => {
    expect(frozenInstallArgs(pm)).toEqual(argv);
  });
});

describe("planInstall", () => {
  test.each([
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const)("%s installs with %s, frozen", async (lockfile, pm) => {
    const dir = await project(lockfile);

    expect(await planInstall(dir, {})).toEqual({
      packageManager: pm,
      lockfile,
      command: pm,
      args: frozenInstallArgs(pm),
    });
  });

  test("no lockfile installs with the manager that launched pithy, which writes the first one", async () => {
    const dir = await project();

    expect(await planInstall(dir, { npm_config_user_agent: "pnpm/10.0.0 node/v22" }, { bun: "1.4.2" })).toEqual({
      packageManager: "pnpm",
      lockfile: null,
      command: "pnpm",
      args: ["install"],
    });
  });

  test("no lockfile and no launcher installs with Bun when pithy runs under it", async () => {
    const dir = await project();

    expect((await planInstall(dir, {}, { bun: "1.4.2" })).packageManager).toBe("bun");
  });

  test("no lockfile, no launcher and no Bun falls back to npm, as every other install does", async () => {
    const dir = await project();

    expect((await planInstall(dir, {}, {})).packageManager).toBe("npm");
  });
});

describe("installDependencies", () => {
  test("runs the planned install in the project, and leaves the lockfile as it was", async () => {
    const dir = await project("bun.lock");
    const runs: { command: string; args: string[]; cwd: string }[] = [];

    const install = await installDependencies({
      projectDir: dir,
      env: {},
      run: async (command, args, cwd) => {
        runs.push({ command, args, cwd });
      },
    });

    expect(runs).toEqual([{ command: "bun", args: ["install", "--frozen-lockfile"], cwd: dir }]);
    expect(install.lockfile).toBe("bun.lock");
    expect(await readFile(join(dir, "bun.lock"), "utf8")).toBe("lock\n");
  });

  test("a failed install names the command to run by hand, and says the lockfile is behind", async () => {
    const dir = await project("bun.lock");

    const failure = await installDependencies({
      projectDir: dir,
      env: {},
      run: async () => {
        throw new Error("lockfile had changes, but lockfile is frozen");
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      payload: {
        message: "bun install --frozen-lockfile failed.",
        action:
          "Setup never rewrites bun.lock. If package.json changed, run bun install, commit the lockfile, and run pithy setup again.",
      },
    });
  });
});
