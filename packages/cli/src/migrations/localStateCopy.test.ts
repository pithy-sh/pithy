// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { inLocalStateCopy } from "./localStateCopy";

/** `pithy migrate --dry-run` reads a copy of the local store, never the store (#697). */
describe("inLocalStateCopy", () => {
  let dir: string;
  const store = () => join(dir, ".wrangler", "state", "v3", "d1");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-local-copy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the work reads the store's bytes, writes to the copy, and the project is untouched", async () => {
    await mkdir(join(store(), "miniflare-D1DatabaseObject"), { recursive: true });
    await writeFile(join(store(), "miniflare-D1DatabaseObject", "db.sqlite"), "ledger");
    const before = await snapshotTree(dir);

    const seen = await inLocalStateCopy(dir, async (root) => {
      const copy = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject", "db.sqlite");
      const bytes = await readFile(copy, "utf8");
      await writeFile(copy, "opened");
      return bytes;
    });

    expect(seen).toBe("ledger");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("a project with no store hands the work an empty root, and still writes nothing", async () => {
    const before = await snapshotTree(dir);
    const root = await inLocalStateCopy(dir, async (copy) => copy);
    expect(await snapshotTree(dir)).toEqual(before);
    // The copy is gone once the work is done.
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("the copy is removed when the work throws, and the throw is the work's", async () => {
    let root = "";
    await expect(
      inLocalStateCopy(dir, async (copy) => {
        root = copy;
        throw new Error("the work failed");
      }),
    ).rejects.toThrow("the work failed");
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
