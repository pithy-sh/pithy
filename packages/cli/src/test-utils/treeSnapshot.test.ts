// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { snapshotTree } from "./treeSnapshot";

/** The before-and-after a dry run is held to, so every kind of write has to change it. */
describe("snapshotTree", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-snapshot-"));
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", "file.txt"), "one");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an unchanged tree snapshots the same", async () => {
    expect(await snapshotTree(dir)).toEqual(await snapshotTree(dir));
  });

  test("an edit, a new file, a new empty directory and a new link each change it", async () => {
    const before = await snapshotTree(dir);
    await writeFile(join(dir, "a", "file.txt"), "two");
    const edited = await snapshotTree(dir);
    expect(edited).not.toEqual(before);
    await mkdir(join(dir, "empty"));
    const withDir = await snapshotTree(dir);
    expect(withDir.get("empty")).toBe("dir");
    await symlink("a/file.txt", join(dir, "link"));
    expect((await snapshotTree(dir)).get("link")).toBe("link:a/file.txt");
  });
});
