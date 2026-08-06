// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeFileAtomic } from "./atomic";

/** The permission bits of whatever `path` finally resolves to. */
async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

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

describe("writeFileAtomic — the target's permissions", () => {
  test("keeps the mode of the file it rewrites", async () => {
    // `.dev.vars` is chmod 0600 at `pithy init`, and then holds CLOUDFLARE_API_TOKEN and
    // SECRETS_ENCRYPTION_KEYS. A rename-based write brings the temp file's own mode with it, so the
    // first `pithy add` widened the one credential file in the project to whatever the umask said.
    const path = join(dir, "secrets");
    await writeFile(path, "OLD=1\n");
    await chmod(path, 0o600);

    await writeFileAtomic(path, "NEW=1\n");

    expect(await modeOf(path)).toBe("600");
    expect(await readFile(path, "utf8")).toBe("NEW=1\n");
  });

  test("creates a new file with the mode the caller asked for", async () => {
    const path = join(dir, "fresh");
    await writeFileAtomic(path, "TOKEN=abc\n", { mode: 0o600 });
    expect(await modeOf(path)).toBe("600");
  });

  test("the caller's mode never widens a file that already has one", async () => {
    // An existing file's permissions are the adopter's decision, tighter or looser than ours.
    const path = join(dir, "theirs");
    await writeFile(path, "OLD=1\n");
    await chmod(path, 0o400);
    await writeFileAtomic(path, "NEW=1\n", { mode: 0o600 });
    expect(await modeOf(path)).toBe("400");
  });
});

describe("writeFileAtomic — a symlinked target", () => {
  test("writes through the link instead of replacing it with a private copy", async () => {
    // `apps/<worker>/.dev.vars` links to the project's shared one. A rename over the link detaches it
    // into a regular file holding a stale copy — and the wiring then correctly reports it `kept`
    // forever, so the worker silently stops seeing every secret the shared file gains.
    const shared = join(dir, ".dev.vars");
    await writeFile(shared, "SHARED=abc\n");
    const link = join(dir, "apps-board-dev-vars");
    await symlink(shared, link);

    await writeFileAtomic(link, "SHARED=rotated\n");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(shared);
    expect(await readFile(shared, "utf8")).toBe("SHARED=rotated\n");
  });

  test("keeps the mode of the file at the end of the link, not the link's own", async () => {
    const shared = join(dir, ".dev.vars");
    await writeFile(shared, "SHARED=abc\n");
    await chmod(shared, 0o600);
    const link = join(dir, "linked");
    await symlink(shared, link);

    await writeFileAtomic(link, "SHARED=rotated\n");

    expect(await modeOf(shared)).toBe("600");
  });

  test("follows a relative link, the spelling the wiring actually writes", async () => {
    const shared = join(dir, ".dev.vars");
    await writeFile(shared, "SHARED=abc\n");
    const link = join(dir, "relative");
    await symlink("./.dev.vars", link);

    await writeFileAtomic(link, "SHARED=rotated\n");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(shared, "utf8")).toBe("SHARED=rotated\n");
  });

  test("creates what a dangling link points at, rather than replacing the link", async () => {
    const missing = join(dir, "not-yet");
    const link = join(dir, "dangling");
    await symlink(missing, link);

    await writeFileAtomic(link, "MADE=1\n", { mode: 0o600 });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(missing, "utf8")).toBe("MADE=1\n");
    expect(await modeOf(missing)).toBe("600");
  });

  test("refuses a link that loops, rather than following it forever", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await symlink(a, b);
    await symlink(b, a);
    await expect(writeFileAtomic(a, "x")).rejects.toThrow(/link/i);
  });
});
