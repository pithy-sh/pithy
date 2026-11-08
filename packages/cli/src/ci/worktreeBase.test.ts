// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GIT_NO_MAINTENANCE, removeTempDir, scratchGitEnv } from "../test-utils/tempRepo";

/**
 * **`scripts/worktree.ts setup` cuts a branch from whichever of local `main` and `origin/main` holds the other.**
 *
 * The script sits outside this package's `rootDir`, so its exported `cutBase` is run through `bun -e` against
 * scratch repositories: an `origin`, the clone the worktree is cut in, and a second clone that pushes behind its back.
 */

const SCRIPT = resolve(import.meta.dirname, "..", "..", "..", "..", "scripts", "worktree.ts");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_NO_MAINTENANCE, ...args], {
    cwd,
    env: {
      ...scratchGitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
}

/** An `origin` holding one commit on `main`, and two clones of it. */
function repos(): { here: string; elsewhere: string } {
  const dir = mkdtempSync(join(tmpdir(), "pithy-worktree-base-"));
  scratch.push(dir);
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(dir, "seed");
  git(dir, "init", "-q", "-b", "main", seed);
  commit(seed, "first");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, join(dir, "here"));
  git(dir, "clone", "-q", origin, join(dir, "elsewhere"));
  return { here: join(dir, "here"), elsewhere: join(dir, "elsewhere") };
}

/** What `cutBase` answers in `root`. */
function cutBase(root: string): { base: string; note: string | null } {
  const program = `import { cutBase } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(cutBase(${JSON.stringify(root)})));`;
  return JSON.parse(execFileSync("bun", ["-e", program], { env: scratchGitEnv(), encoding: "utf8" }));
}

describe("cutBase", () => {
  test("level with origin: local main, no note", () => {
    const { here } = repos();
    expect(cutBase(here)).toEqual({ base: "main", note: null });
  });

  test("behind with nothing of its own: fetches, and cuts from origin/main without moving the checkout", () => {
    const { here, elsewhere } = repos();
    commit(elsewhere, "merged-elsewhere");
    git(elsewhere, "push", "-q", "origin", "main");
    const before = git(here, "rev-parse", "main");

    expect(cutBase(here)).toEqual({
      base: "origin/main",
      note: "main is 1 commit(s) behind origin/main. Cutting from origin/main.",
    });
    expect(git(here, "rev-parse", "main")).toBe(before);
  });

  test("ahead with an unpushed merge: local main, so the merge is kept", () => {
    const { here } = repos();
    commit(here, "merged-here");
    expect(cutBase(here)).toEqual({ base: "main", note: null });
  });

  test("diverged: local main, and says so", () => {
    const { here, elsewhere } = repos();
    commit(elsewhere, "merged-elsewhere");
    git(elsewhere, "push", "-q", "origin", "main");
    commit(here, "merged-here");
    expect(cutBase(here)).toEqual({
      base: "main",
      note: "main and origin/main have diverged: 1 commit(s) here, 1 there. Cutting from local main.",
    });
  });

  test("no origin: local main", () => {
    const dir = mkdtempSync(join(tmpdir(), "pithy-worktree-base-"));
    scratch.push(dir);
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "only");
    expect(cutBase(dir)).toEqual({ base: "main", note: null });
  });
});
