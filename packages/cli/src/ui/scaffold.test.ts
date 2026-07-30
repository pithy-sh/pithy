// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
