// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fakeInstall, fakePackument, fakeRegistry } from "../test-utils/fakeInstall";
import { runPackageStep } from "./apply";

const ROOT = `${JSON.stringify(
  {
    name: "replay",
    private: true,
    workspaces: ["apps/*"],
    dependencies: { zod: "^4.4.0", "@pithy-sh/auth": "^0.2.0", "@pithy-sh/core": "^0.7.2" },
    devDependencies: { "@pithy-sh/cli": "^0.9.4" },
  },
  null,
  2,
)}\n`;
const BOARD = `${JSON.stringify({ name: "board", dependencies: { "@pithy-sh/auth": "^0.2.0" } }, null, 2)}\n`;
const LOCK = '{\n  "lockfileVersion": 1,\n  "packages": {}\n}\n';

describe("runPackageStep", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-apply-"));
    await writeFile(join(dir, "package.json"), ROOT);
    await writeFile(join(dir, "bun.lock"), LOCK);
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "package.json"), BOARD);
    // What is installed now: the floors.
    await fakeInstall()("bun", ["install"], dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const registry = (cli = ["0.9.4"]) =>
    fakeRegistry({
      "@pithy-sh/auth": fakePackument("@pithy-sh/auth", ["0.2.0", "0.2.3", "0.3.1"]),
      "@pithy-sh/core": fakePackument("@pithy-sh/core", ["0.7.2"]),
      "@pithy-sh/cli": fakePackument("@pithy-sh/cli", cli),
    });

  test("rewrites only the entries that move; key order and the trailing newline survive", async () => {
    const run = fakeInstall();
    const result = await runPackageStep({
      projectDir: dir,
      latest: false,
      dryRun: false,
      fetch: registry(),
      runInstall: run,
    });
    expect(result.report.installed).toBe(true);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(
      ROOT.replace('"@pithy-sh/auth": "^0.2.0"', '"@pithy-sh/auth": "^0.2.3"'),
    );
    expect(await readFile(join(dir, "apps", "board", "package.json"), "utf8")).toBe(BOARD.replace("^0.2.0", "^0.2.3"));
  });

  test("installs once, at the root, with the detected package manager's bare install", async () => {
    const run = fakeInstall();
    await runPackageStep({ projectDir: dir, latest: false, dryRun: false, fetch: registry(), runInstall: run });
    expect(run.calls).toEqual([["bun", ["install"], dir]]);
  });

  test("a dry run writes nothing and never calls the installer", async () => {
    const run = fakeInstall();
    const result = await runPackageStep({
      projectDir: dir,
      latest: false,
      dryRun: true,
      fetch: registry(),
      runInstall: run,
    });
    expect(run.calls).toEqual([]);
    expect(result.report).toMatchObject({ state: "read", installed: false, packageManager: "bun" });
    expect(result.report.moves).toHaveLength(2);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(ROOT);
  });

  test("nothing to move: nothing written, nothing installed", async () => {
    const run = fakeInstall();
    const fetch = fakeRegistry({
      "@pithy-sh/auth": fakePackument("@pithy-sh/auth", ["0.2.0"]),
      "@pithy-sh/core": fakePackument("@pithy-sh/core", ["0.7.2"]),
      "@pithy-sh/cli": fakePackument("@pithy-sh/cli", ["0.9.4"]),
    });
    const result = await runPackageStep({ projectDir: dir, latest: false, dryRun: false, fetch, runInstall: run });
    expect(run.calls).toEqual([]);
    expect(result.report.installed).toBe(false);
  });

  test("an install that fails restores every package.json and the lockfile byte for byte", async () => {
    const run = async (_pm: string, _args: string[], cwd: string) => {
      // A package manager that got partway: the lockfile rewritten, then the network went.
      await writeFile(join(cwd, "bun.lock"), "half-written");
      throw new Error("ECONNRESET");
    };
    const failed = runPackageStep({
      projectDir: dir,
      latest: false,
      dryRun: false,
      fetch: registry(),
      runInstall: run,
    });
    await expect(failed).rejects.toBeInstanceOf(InternalError);
    await expect(failed).rejects.toMatchObject({
      payload: {
        message: "bun install failed. package.json files restored.",
        action: "Run bun install to settle node_modules.",
      },
    });
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(ROOT);
    expect(await readFile(join(dir, "apps", "board", "package.json"), "utf8")).toBe(BOARD);
    expect(await readFile(join(dir, "bun.lock"), "utf8")).toBe(LOCK);
  });

  test("an install that leaves a package below its target is a mismatch, per manifest", async () => {
    const run = fakeInstall({ hold: ["@pithy-sh/auth"] });
    const result = await runPackageStep({
      projectDir: dir,
      latest: false,
      dryRun: false,
      fetch: registry(),
      runInstall: run,
    });
    expect(result.report.mismatches).toEqual([
      { name: "@pithy-sh/auth", manifest: "package.json", expected: "0.2.3", installed: "0.2.0" },
      { name: "@pithy-sh/auth", manifest: "apps/board/package.json", expected: "0.2.3", installed: "0.2.0" },
    ]);
  });

  test("a moved CLI is reported, so the reconcile can be left to the new one", async () => {
    const result = await runPackageStep({
      projectDir: dir,
      latest: false,
      dryRun: false,
      fetch: registry(["0.9.4", "0.9.5"]),
      runInstall: fakeInstall(),
    });
    expect(result.cliMoved).toBe("0.9.5");
    const dry = await runPackageStep({
      projectDir: dir,
      latest: false,
      dryRun: true,
      fetch: registry(["0.9.4", "0.9.6"]),
      runInstall: fakeInstall(),
    });
    expect(dry.cliMoved).toBeNull();
  });

  test("a registry that does not answer writes nothing and installs nothing", async () => {
    const run = fakeInstall();
    const fetch = fakeRegistry({ "@pithy-sh/auth": fakePackument("@pithy-sh/auth", ["0.2.0", "0.2.3"]) });
    const result = await runPackageStep({ projectDir: dir, latest: false, dryRun: false, fetch, runInstall: run });
    expect(result.report).toMatchObject({ state: "unavailable", installed: false, moves: [], held: [] });
    expect(run.calls).toEqual([]);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(ROOT);
  });
});
