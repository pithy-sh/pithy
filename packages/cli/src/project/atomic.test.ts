// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Buffer } from "node:buffer";
import type { Mode, PathLike } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeFileAtomic } from "./atomic";

/**
 * The temp file's suffix is random precisely so nobody can plant anything at it. To *test* the guard that
 * catches a planted file anyway, the randomness is pinned for one case — that is the only reason this mock
 * exists, and every other test leaves it alone and gets the real thing.
 */
const pinned = vi.hoisted(() => ({ suffix: null as string | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      pinned.suffix === null ? actual.randomBytes(size) : Buffer.from(pinned.suffix, "hex"),
  };
});

/**
 * The mode the temp file *already had* when the chmod ran. A write that creates the file at the umask
 * default and tightens it afterwards leaves a window where a plaintext credential is world-readable, and
 * the finished file looks identical either way — this is the only place the difference is observable.
 */
const observed = vi.hoisted(() => ({ modeAtChmod: null as number | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (path: PathLike, mode: Mode) => {
      observed.modeAtChmod = (await actual.stat(path)).mode & 0o777;
      await actual.chmod(path, mode);
    },
  };
});

/** The permission bits of whatever `path` finally resolves to. */
async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-atomic-"));
  pinned.suffix = null;
  observed.modeAtChmod = null;
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

describe("writeFileAtomic — the temp file", () => {
  let outside: string;
  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "pithy-atomic-outside-"));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  test("never writes to the predictable `<target>.tmp` path", async () => {
    // The old temp name was `${target}.tmp` — a name anyone who can write the project directory can
    // work out and plant a symlink at. The write followed it, so `.dev.vars` — CLOUDFLARE_API_TOKEN,
    // SECRETS_ENCRYPTION_KEYS — landed at the attacker's path, and the rename then installed the link
    // over the target so every later write went there too. No race: the name was fixed.
    const path = join(dir, ".dev.vars");
    await writeFile(path, "OLD=1\n");
    await chmod(path, 0o600);
    const loot = join(outside, "loot");
    await symlink(loot, `${path}.tmp`);

    await writeFileAtomic(path, "CLOUDFLARE_API_TOKEN=live\n", { mode: 0o600 });

    await expect(stat(loot)).rejects.toThrow();
    expect((await lstat(`${path}.tmp`)).isSymbolicLink()).toBe(true);
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("CLOUDFLARE_API_TOKEN=live\n");
  });

  test("refuses to write through a symlink planted at the temp path", async () => {
    // Even with the name unguessable, the open is exclusive: anything already at the path fails it
    // rather than being followed. Pinned randomness is the only way to stand where the attacker would.
    pinned.suffix = "0123456789abcdef";
    const path = join(dir, ".dev.vars");
    await writeFile(path, "OLD=1\n");
    const loot = join(outside, "loot");
    const tmp = `${path}.0123456789abcdef.tmp`;
    await symlink(loot, tmp);

    const error = await writeFileAtomic(path, "CLOUDFLARE_API_TOKEN=live\n", { mode: 0o600 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(tmp);
    await expect(stat(loot)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("OLD=1\n");
    // The planted link is left exactly where it is: deleting it is a write to a path we just refused.
    expect((await lstat(tmp)).isSymbolicLink()).toBe(true);
  });

  test("refuses a plain file left at the temp path rather than reusing it", async () => {
    // A leftover from a crashed run kept its own mode: `writeFile` truncates through O_CREAT, which
    // ignores the mode of a file that already exists. The new content inherited whatever it was.
    pinned.suffix = "0123456789abcdef";
    const path = join(dir, ".dev.vars");
    const tmp = `${path}.0123456789abcdef.tmp`;
    await writeFile(tmp, "leftover\n", { mode: 0o666 });

    await expect(writeFileAtomic(path, "TOKEN=live\n", { mode: 0o600 })).rejects.toThrow(PithyError);
    expect(await readFile(tmp, "utf8")).toBe("leftover\n");
  });

  test("creates the temp file already restricted, never widening it after the write", async () => {
    const path = join(dir, ".dev.vars.prod");
    observed.modeAtChmod = null;

    await writeFileAtomic(path, "CLOUDFLARE_API_TOKEN=live\n", { mode: 0o600 });

    expect(observed.modeAtChmod).toBe(0o600);
    expect(await modeOf(path)).toBe("600");
  });

  test("a dangling link into a directory that does not exist fails as a PithyError, not a raw ENOENT", async () => {
    // `--json` callers parse the error contract. A bare node ENOENT escaping it is unparseable.
    const link = join(dir, "dangling");
    await symlink(join(outside, "gone", "target"), link);

    const error = await writeFileAtomic(link, "x", { mode: 0o600 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(join(outside, "gone", "target"));
  });
});
