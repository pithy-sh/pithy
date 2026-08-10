// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, expect, test } from "vitest";
import { withRollback } from "./rollback";

/**
 * The primitive on its own: what "leaves the tree as it found it" has to mean, one case at a time.
 *
 * `ui/rollback.test.ts` proves the property through the real command. This proves the pieces that command
 * relies on and would not notice going wrong — a directory the run had to create, a file whose contents
 * were replaced rather than created, and the one case where getting it wrong destroys an adopter's file.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-rollback-"));
});
afterEach(async () => {
  await chmod(join(dir, "locked.txt"), 0o644).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

test("a created file and the directories it needed are both gone again", async () => {
  const path = join(dir, "src", "routes", "pithy", "sign-in.tsx");
  await expect(
    withRollback({ root: dir, paths: [path] }, async () => {
      await mkdir(join(dir, "src", "routes", "pithy"), { recursive: true });
      await writeFile(path, "screen\n");
      throw new Error("compose failed");
    }),
  ).rejects.toThrow("compose failed");

  // Not just the file: an empty `src/routes/pithy/` is a tree that reads clean to a person and fails a
  // byte-for-byte comparison, which is the only kind a gate can make.
  expect(await readdir(dir)).toEqual([]);
});

test("a file that already existed is put back with its own contents", async () => {
  const path = join(dir, "wrangler.jsonc");
  await writeFile(path, '{ "name": "board" }\n');
  await expect(
    withRollback({ root: dir, paths: [path] }, async () => {
      await writeFile(path, '{ "name": "board", "assets": {} }\n');
      throw new Error("later step failed");
    }),
  ).rejects.toThrow("later step failed");
  expect(await readFile(path, "utf8")).toBe('{ "name": "board" }\n');
});

test("a directory that was already there is never removed", async () => {
  const kept = join(dir, "src");
  await mkdir(kept, { recursive: true });
  const path = join(kept, "main.tsx");
  await expect(
    withRollback({ root: dir, paths: [path] }, async () => {
      await writeFile(path, "app\n");
      throw new Error("nope");
    }),
  ).rejects.toThrow("nope");
  expect(await readdir(dir)).toEqual(["src"]);
  expect(await readdir(kept)).toEqual([]);
});

test("nothing is touched when the run succeeds", async () => {
  const path = join(dir, "kept.txt");
  const result = await withRollback({ root: dir, paths: [path] }, async () => {
    await writeFile(path, "written\n");
    return "done";
  });
  expect(result).toBe("done");
  expect(await readFile(path, "utf8")).toBe("written\n");
});

test("an unreadable path refuses the run rather than being recorded as absent", async () => {
  // The case where the shortcut destroys data. A file that exists and will not open reads as `EACCES`,
  // and `.catch(() => null)` would record it as absent — so the rollback would *delete* it. Refusing
  // before anything is written costs nothing; the alternative costs the adopter their file.
  const path = join(dir, "locked.txt");
  await writeFile(path, "secret\n");
  await chmod(path, 0o000);

  let ran = false;
  await expect(
    withRollback({ root: dir, paths: [path] }, async () => {
      ran = true;
    }),
  ).rejects.toThrow(PithyError);
  expect(ran).toBe(false);
  await chmod(path, 0o644);
  expect(await readFile(path, "utf8")).toBe("secret\n");
});
