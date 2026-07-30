// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  detectPackageManager,
  execArgs,
  installArgs,
  installPackage,
  promoteDependencies,
  uninstallArgs,
  uninstallPackage,
} from "./packageManager";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-pm-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
  test.each([
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("%s → %s", async (lockfile, expected) => {
    await writeFile(join(dir, lockfile), "");
    expect(await detectPackageManager(dir)).toBe(expected);
  });

  test("no lockfile defaults to npm — adoption is never gated behind one PM", async () => {
    expect(await detectPackageManager(dir)).toBe("npm");
  });

  test("bun wins when both bun and npm lockfiles are present (most specific first)", async () => {
    await writeFile(join(dir, "package-lock.json"), "");
    await writeFile(join(dir, "bun.lock"), "");
    expect(await detectPackageManager(dir)).toBe("bun");
  });
});

describe("installArgs", () => {
  test("npm installs, the others add", () => {
    expect(installArgs("npm", "@pithy-sh/auth")).toEqual(["install", "@pithy-sh/auth"]);
    expect(installArgs("pnpm", "@pithy-sh/auth")).toEqual(["add", "@pithy-sh/auth"]);
    expect(installArgs("yarn", "@pithy-sh/auth")).toEqual(["add", "@pithy-sh/auth"]);
    expect(installArgs("bun", "@pithy-sh/auth")).toEqual(["add", "@pithy-sh/auth"]);
  });

  test("takes many packages in one install invocation", () => {
    expect(installArgs("npm", ["hono@^4", "zod@^4"])).toEqual(["install", "hono@^4", "zod@^4"]);
  });
});

describe("uninstallArgs", () => {
  test("npm uninstalls, the others remove", () => {
    expect(uninstallArgs("npm", "@pithy-sh/auth")).toEqual(["uninstall", "@pithy-sh/auth"]);
    expect(uninstallArgs("pnpm", "@pithy-sh/auth")).toEqual(["remove", "@pithy-sh/auth"]);
    expect(uninstallArgs("yarn", "@pithy-sh/auth")).toEqual(["remove", "@pithy-sh/auth"]);
    expect(uninstallArgs("bun", "@pithy-sh/auth")).toEqual(["remove", "@pithy-sh/auth"]);
  });
});

describe("uninstallPackage", () => {
  test("detects the PM and runs its remove command in the project dir", async () => {
    await writeFile(join(dir, "bun.lock"), "");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = await uninstallPackage({
      projectDir: dir,
      pkg: "@pithy-sh/auth",
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
      },
    });

    expect(result.packageManager).toBe("bun");
    expect(calls).toEqual([{ command: "bun", args: ["remove", "@pithy-sh/auth"], cwd: dir }]);
  });
});

describe("promoteDependencies", () => {
  test("adds every package in one command with the detected PM", async () => {
    await writeFile(join(dir, "yarn.lock"), "");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = await promoteDependencies(dir, ["better-auth@^1.6.19", "zod@^4.0.0"], async (command, args, cwd) => {
      calls.push({ command, args, cwd });
    });

    expect(result.packageManager).toBe("yarn");
    expect(calls).toEqual([{ command: "yarn", args: ["add", "better-auth@^1.6.19", "zod@^4.0.0"], cwd: dir }]);
  });

  test("is a no-op when there is nothing to promote", async () => {
    let ran = false;
    await promoteDependencies(dir, [], async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });
});

describe("execArgs", () => {
  test("resolves a workspace-local bin per package manager", () => {
    expect(execArgs("bun", "wrangler", ["dev"])).toEqual({ command: "bun", args: ["x", "wrangler", "dev"] });
    expect(execArgs("pnpm", "wrangler", ["dev"])).toEqual({ command: "pnpm", args: ["exec", "wrangler", "dev"] });
    expect(execArgs("yarn", "wrangler", ["dev"])).toEqual({ command: "yarn", args: ["wrangler", "dev"] });
    expect(execArgs("npm", "wrangler", ["dev"])).toEqual({ command: "npx", args: ["wrangler", "dev"] });
  });
});

describe("installPackage", () => {
  test("detects the PM and runs its install command in the project dir", async () => {
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = await installPackage({
      projectDir: dir,
      pkg: "@pithy-sh/auth",
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
      },
    });

    expect(result.packageManager).toBe("pnpm");
    expect(calls).toEqual([{ command: "pnpm", args: ["add", "@pithy-sh/auth"], cwd: dir }]);
  });
});
