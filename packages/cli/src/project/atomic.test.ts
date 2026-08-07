// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeFileAtomic } from "./atomic";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-atomic-"));
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes the content to the target path", async () => {
    const path = join(dir, "file.txt");
    await writeFileAtomic(path, "hello");
    expect(await readFile(path, "utf8")).toBe("hello");
  });

  test("overwrites an existing file", async () => {
    const path = join(dir, "file.txt");
    await writeFile(path, "old");
    await writeFileAtomic(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
  });

  test("leaves no tmp file behind on success", async () => {
    const path = join(dir, "file.txt");
    await writeFileAtomic(path, "content");
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });

  test("applies the requested mode to the file it lands", async () => {
    const path = join(dir, "secret.jsonc");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("the mode survives a rewrite — the rename must not carry a umask-default temp file over it", async () => {
    // The bug this pins: an atomic write is a rename, so the *temp* file's mode is the one that
    // survives. Chmod the target and the second write silently widened it back to 0644, which for
    // `.dev.secrets.jsonc` is OAuth client secrets readable by every account on the machine.
    const path = join(dir, "secret.jsonc");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    await writeFileAtomic(path, '{ "a": 1 }', { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("no mode asked for leaves the file to the umask, as every other caller expects", async () => {
    const path = join(dir, "plain.txt");
    await writeFileAtomic(path, "hello");
    expect((await stat(path)).mode & 0o777).not.toBe(0o600);
  });

  test("preserves the original when the temp write fails (directory not writable)", async () => {
    const path = join(dir, "file.txt");
    await writeFile(path, "original");
    // Remove write permission so the tmp write fails before rename. Note: this relies on
    // the test NOT running as root, where chmod has no effect — standard CI and dev are fine.
    await chmod(dir, 0o555);
    await expect(writeFileAtomic(path, "replaced")).rejects.toThrow();
    // Restore write permission to read for verification.
    await chmod(dir, 0o755);
    expect(await readFile(path, "utf8")).toBe("original");
  });
});
