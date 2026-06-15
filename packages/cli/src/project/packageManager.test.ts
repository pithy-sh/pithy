import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectPackageManager, installArgs, installPackage } from "./packageManager";

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
