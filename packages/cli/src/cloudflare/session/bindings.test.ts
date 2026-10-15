// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  bindProfile,
  boundProfileSync,
  profilesPath,
  readBindingsSync,
  setDefaultProfile,
  unbindApplying,
  unbindProfile,
} from "./bindings";

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

describe("boundProfileSync", () => {
  test("nothing bound and no default is no profile", () => {
    const { root, options } = sandbox();
    expect(boundProfileSync(root, options)).toBeNull();
  });

  test("a directory bound to a profile, and every directory under it, resolve to that profile", async () => {
    const { root, options } = sandbox();
    const project = join(root, "plain");
    mkdirSync(join(project, "apps", "api"), { recursive: true });
    await bindProfile(project, "pithy", options);
    expect(boundProfileSync(project, options)).toEqual({ profile: "pithy", via: "directory", key: project });
    expect(boundProfileSync(join(project, "apps", "api"), options)?.profile).toBe("pithy");
  });

  test("a binding on the main checkout covers its worktrees, so four features sign in once", async () => {
    const { root, options } = sandbox();
    const { main, worktree } = repoWithWorktree(root);
    await bindProfile(main, "pithy", options);
    expect(boundProfileSync(worktree, options)).toEqual({ profile: "pithy", via: "directory", key: main });
  });

  test("the nearest binding wins over one further up", async () => {
    const { root, options } = sandbox();
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    await bindProfile(outer, "outer", options);
    await bindProfile(inner, "inner", options);
    expect(boundProfileSync(inner, options)?.profile).toBe("inner");
  });

  test("the default applies where nothing is bound, and says it came from the default", async () => {
    const { root, options } = sandbox();
    await setDefaultProfile("main", options);
    expect(boundProfileSync(root, options)).toEqual({ profile: "main", via: "default", key: null });
  });

  test("unbinding removes the directory's entry and leaves the rest", async () => {
    const { root, options } = sandbox();
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    await bindProfile(a, "one", options);
    await bindProfile(b, "two", options);
    expect(await unbindProfile(a, options)).toBe(true);
    expect(boundProfileSync(a, options)).toBeNull();
    expect(boundProfileSync(b, options)?.profile).toBe("two");
    expect(await unbindProfile(a, options)).toBe(false);
  });
});

describe("profiles.json", () => {
  test("lives at the config root and is 0664, because it holds no secret", async () => {
    const { root, options } = sandbox();
    await bindProfile(root, "pithy", options);
    expect(profilesPath(options)).toBe(join(options.env.PITHY_CONFIG_DIR ?? "", "profiles.json"));
    if (process.platform !== "win32") expect(statSync(profilesPath(options)).mode & 0o777).toBe(0o664);
  });

  test("a malformed file reads as no bindings rather than stopping every command", () => {
    const { options } = sandbox();
    writeFileSync(profilesPath(options), "{ not json");
    expect(readBindingsSync(options)).toEqual({ bindings: {} });
  });
});

describe("a profiles.json that will not open", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "is refused by a writer rather than overwritten, so no other directory loses its binding",
    async () => {
      const { root, options } = sandbox();
      await bindProfile(root, "keep", options);
      chmodSync(profilesPath(options), 0o000);
      try {
        await expect(bindProfile(join(root, "config"), "other", options)).rejects.toThrow(/could not read/);
      } finally {
        chmodSync(profilesPath(options), 0o664);
      }
      expect(readBindingsSync(options).bindings[root]).toBe("keep");
    },
  );
});

describe("unbindApplying", () => {
  test("removes the binding a command here would use: a parent's, then the default — never a key nothing used", async () => {
    const { root, options } = sandbox();
    const parent = join(root, "parent");
    const child = join(parent, "apps", "api");
    mkdirSync(child, { recursive: true });
    await bindProfile(parent, "pithy", options);
    await setDefaultProfile("main", options);
    expect(await unbindApplying(child, options)).toEqual({ removed: "directory", key: parent });
    expect(boundProfileSync(child, options)?.via).toBe("default");
    expect(await unbindApplying(child, options)).toEqual({ removed: "default", key: null });
    expect(boundProfileSync(child, options)).toBeNull();
    expect(await unbindApplying(child, options)).toBeNull();
  });
});
