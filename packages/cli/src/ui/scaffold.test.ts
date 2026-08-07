// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scaffoldFiles } from "./scaffold";

describe("scaffoldFiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ui-scaffold-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the record, creating parent directories", async () => {
    const result = await scaffoldFiles({
      workerDir: dir,
      files: { "index.html": "<!doctype html>\n", "src/routes/app/home.tsx": 'export const path = "/";\n' },
    });
    expect(result.written).toEqual(["index.html", "src/routes/app/home.tsx"]);
    expect(result.skipped).toEqual([]);
    expect(await readFile(join(dir, "src/routes/app/home.tsx"), "utf8")).toContain("export const path");
  });

  test("a collision is a clean error naming every colliding path, and NOTHING is written", async () => {
    await writeFile(join(dir, "index.html"), "mine\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "client.tsx"), "also mine\n");

    try {
      await scaffoldFiles({
        workerDir: dir,
        files: {
          "index.html": "theirs\n",
          "src/client.tsx": "theirs\n",
          "src/styles.css": "body {}\n",
        },
      });
      expect.unreachable("expected a collision to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.message).toContain("index.html");
      expect(payload.message).toContain("src/client.tsx");
      expect(payload.action).toContain("pithy ui add");
    }

    // Byte-identical, and the non-colliding file was never written either — all or nothing.
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("mine\n");
    expect(await readFile(join(dir, "src", "client.tsx"), "utf8")).toBe("also mine\n");
    expect(await readdir(join(dir, "src"))).toEqual(["client.tsx"]);
  });

  test("refuses a symlinked directory on the way to a file, and writes nothing through it", async () => {
    // `exists()` here was `access`, which follows the link and answers about the destination — so a link at
    // `apps/<worker>/src` read as "src/client.tsx is missing", cleared the gate, and `pithy ui add react`
    // wrote six files of the front end outside the project and exited 0. Reproduced against the real CLI.
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dir, "src"));

    await expect(
      scaffoldFiles({ workerDir: dir, files: { "index.html": "<!doctype html>\n", "src/client.tsx": "theirs\n" } }),
    ).rejects.toThrow(PithyError);

    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(dir)).toEqual(["outside", "src"]); // index.html was never written either
  });

  test("a backfill is held to the same rule — a link is refused, not quietly skipped", async () => {
    // `strict: false` skips a file that is already there, which is safe because nothing is written. A
    // symlinked *directory* is the opposite case: the file under it does not exist, so the backfill writes,
    // and it writes outside the project.
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dir, "src"));

    await expect(
      scaffoldFiles({ workerDir: dir, files: { "src/styles.css": "body {}\n" }, strict: false }),
    ).rejects.toThrow(PithyError);
    expect(await readdir(outside)).toEqual([]);
  });

  test("with strict off, an existing file is skipped and left byte-identical", async () => {
    await writeFile(join(dir, "index.html"), "mine\n");
    const result = await scaffoldFiles({
      workerDir: dir,
      files: { "index.html": "theirs\n", "src/styles.css": "body {}\n" },
      strict: false,
    });
    expect(result.written).toEqual(["src/styles.css"]);
    expect(result.skipped).toEqual(["index.html"]);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("mine\n");
  });
});
