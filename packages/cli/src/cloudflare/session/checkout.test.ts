// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { registryRootFor } from "../../feature/ports";
import { bindingKeySync, checkoutRootSync } from "./checkout";

function sandbox(): { root: string; options: { env: NodeJS.ProcessEnv } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-bind-")));
  const config = join(root, "config");
  mkdirSync(config);
  return { root, options: { env: { PITHY_CONFIG_DIR: config } } };
}

/** A main checkout with a `.git` directory, and a linked worktree whose `.git` is a file pointing back. */
function repoWithWorktree(root: string): { main: string; worktree: string } {
  const main = join(root, "app");
  mkdirSync(join(main, ".git", "worktrees", "feat"), { recursive: true });
  const worktree = join(main, ".worktrees", "feat");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feat")}\n`);
  writeFileSync(join(main, ".git", "worktrees", "feat", "commondir"), "../..\n");
  return { main, worktree };
}

describe("checkoutRootSync", () => {
  test("a directory holding a .git directory is its own checkout root", () => {
    const { root } = sandbox();
    const { main } = repoWithWorktree(root);
    expect(checkoutRootSync(main)).toBe(main);
  });

  test("a linked worktree resolves to its main checkout, through gitdir and commondir, with no git call", () => {
    const { root } = sandbox();
    const { main, worktree } = repoWithWorktree(root);
    expect(checkoutRootSync(worktree)).toBe(main);
  });

  test("agrees with registryRootFor on a real repository and worktree, so either path finds the other's key", async () => {
    // The binding is written through the async path and read through the synchronous one. If the two
    // spell the main checkout differently, a bound worktree reads as unbound and nobody is told.
    const { root } = sandbox();
    const main = join(root, "real");
    mkdirSync(main);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", join(main, ".worktrees", "feat"));
    const worktree = join(main, ".worktrees", "feat");
    expect(bindingKeySync(worktree)).toBe(await registryRootFor(worktree));
    expect(bindingKeySync(join(main))).toBe(await registryRootFor(main));
  });

  test("a directory with no .git is not a checkout", () => {
    const { root } = sandbox();
    expect(checkoutRootSync(root)).toBeNull();
  });
});
