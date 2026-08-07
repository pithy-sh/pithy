// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { committedFiles } from "./templateFiles";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-index-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("committedFiles", () => {
  test("lists what the index holds, and nothing a working tree merely happens to hold", async () => {
    // The index, not a commit: `ls-files --cached` reads staged content, which is what `git add` writes.
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}\n");
    await writeFile(join(dir, "apps", "api", "index.ts"), "export {};\n");
    await writeFile(join(dir, ".gitignore"), ".dev.vars\n");
    // The two shapes an exclusion filter has to predict, and did not: gitignored, and merely untracked.
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=real\n");
    await writeFile(join(dir, "scratch.md"), "notes\n");
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "add", "package.json", "apps/api/index.ts", ".gitignore"]);

    expect(committedFiles(dir)).toEqual([".gitignore", join("apps", "api", "index.ts"), "package.json"]);
  });

  test("answers null where there is no index to read, rather than throwing at the adopter", async () => {
    // An installed CLI runs `pithy init` outside any repository. That is the ordinary case, not an error,
    // and git's `fatal: not a git repository` must not reach the terminal either.
    expect(committedFiles(dir)).toBeNull();
  });

  test("answers null for a repository that has nothing under the directory", async () => {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    await mkdir(join(dir, "empty"), { recursive: true });

    expect(committedFiles(join(dir, "empty"))).toBeNull();
  });
});
