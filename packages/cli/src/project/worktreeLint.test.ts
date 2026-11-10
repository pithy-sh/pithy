// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWorktree, type GitRunner } from "../feature/worktree";
import { scaffoldProject } from "./scaffold";

/**
 * **A feature worktree lints the same files as the main checkout.**
 *
 * `pithy feature create` puts every worktree at `<root>/.worktrees/<issue>-<slug>`, so each file in one has
 * `.worktrees` in its absolute path. A linter that matches an exclusion against that path skips the whole
 * worktree, so none of the work done there is linted: Biome then checks no file and fails with `No files were
 * processed`, an error that names no pattern. Both linters are
 * run here, in a project `pithy init` scaffolded and a worktree `pithy feature create` cut from it, and must count
 * the same, nonzero number of files in each: the main checkout's count is the worktree's because it leaves the
 * worktrees out.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const BIOME = join(REPO, "node_modules", "@biomejs", "biome", "bin", "biome");
const OXLINT = join(REPO, "node_modules", "oxlint", "bin", "oxlint");

const exec = promisify(execFile);

let root: string;
let main: string;
let worktree: string;

/** What a run printed, uncoloured. */
function run(cwd: string, command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr };
}

/** How many files `biome check .` checked, from its summary line. */
function biomeCount(cwd: string): number {
  const { stdout, stderr } = run(cwd, BIOME, ["check", "."]);
  const match = /Checked (\d+) files?/.exec(`${stdout}${stderr}`);
  if (!match) throw new Error(`biome printed no count in ${cwd}`);
  return Number(match[1]);
}

/** How many files `oxlint` linted, from its JSON report. */
function oxlintCount(cwd: string): number {
  const report = JSON.parse(run(cwd, OXLINT, ["--format", "json"]).stdout) as { number_of_files: number };
  return report.number_of_files;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pithy-worktree-lint-")));
  main = join(root, "replay");
  await scaffoldProject({ targetDir: main, appName: "replay", worker: "board", lint: "oxlint" });
  const git: GitRunner = async (args, cwd) => (await exec("git", args, { cwd: cwd ?? main })).stdout.trim();
  await git(["init", "-q", "-b", "main"]);
  await git(["add", "-A"]);
  await git(["-c", "user.name=Pithy", "-c", "user.email=pithy@example.com", "commit", "-qm", "init"]);
  worktree = (await createWorktree({ issue: "1", slug: "probe", git })).wtPath;
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("linting a pithy feature create worktree", () => {
  test("biome checks the same nonzero file count in the worktree as in the main checkout", () => {
    const inMain = biomeCount(main);
    expect(inMain).toBeGreaterThan(0);
    expect(biomeCount(worktree)).toBe(inMain);
  }, 60_000);

  test("oxlint lints the same nonzero file count in the worktree as in the main checkout", () => {
    const inMain = oxlintCount(main);
    expect(inMain).toBeGreaterThan(0);
    expect(oxlintCount(worktree)).toBe(inMain);
  }, 60_000);
});
