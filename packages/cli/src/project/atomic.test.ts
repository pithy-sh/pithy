// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Buffer } from "node:buffer";
import type { Mode, PathLike, Stats } from "node:fs";
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Who owns a symlink is the whole containment rule, and a test cannot make a link it does not own:
 * `symlink(2)` stamps the caller's uid on it and only root may `chown` it afterwards. That property is
 * exactly why the rule is sound and exactly why the hostile case has to be staged here — this map forces
 * the uid `lstat` reports for one path, and nothing else in the file touches it.
 */
const owner = vi.hoisted(() => ({ byPath: new Map<string, number>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (path: PathLike, mode: Mode) => {
      observed.modeAtChmod = (await actual.stat(path)).mode & 0o777;
      await actual.chmod(path, mode);
    },
    lstat: async (path: PathLike) => {
      const real = await actual.lstat(path);
      const uid = owner.byPath.get(String(path));
      return uid === undefined ? real : (Object.create(real, { uid: { value: uid } }) as Stats);
    },
  };
});

/** The permission bits of whatever `path` finally resolves to. */
async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pithy-atomic-")));
  pinned.suffix = null;
  observed.modeAtChmod = null;
  owner.byPath.clear();
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
    outside = await realpath(await mkdtemp(join(tmpdir(), "pithy-atomic-outside-")));
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

/**
 * The escape moved one step earlier, it did not close. `c35ffa7` made the *temp* path unguessable and
 * exclusive; the target path itself was still followed wherever it pointed. Plant a link at `.dev.vars`
 * rather than at `.dev.vars.<rand>.tmp` and a live `CLOUDFLARE_API_TOKEN` lands outside the project exactly
 * as before — the write follows the link, adopts the destination's mode, and renames onto it.
 *
 * **Containment cannot be by path, and these tests are what pins that.** The link this must follow and the
 * link it must refuse are indistinguishable by where they point: `scripts/worktree.ts` links a worktree's
 * `.dev.vars` at the *main checkout's*, which is outside every root this function could compute. Refusing
 * by location reintroduces #146; following by location is the hole. What separates them is who made the
 * link, so that is what the rule asks.
 */
describe("writeFileAtomic — a symlink somebody else planted", () => {
  let outside: string;
  let foreign: number;
  beforeEach(async () => {
    outside = await realpath(await mkdtemp(join(tmpdir(), "pithy-atomic-planted-")));
    // Any uid that is not ours and is not root's. Never 0, since `geteuid() + 1` cannot wrap to it.
    foreign = (process.geteuid?.() ?? 0) + 1;
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  test("refuses to follow a link at the target that somebody else owns", async () => {
    const path = join(dir, ".dev.vars");
    const loot = join(outside, "loot");
    await symlink(loot, path);
    owner.byPath.set(path, foreign);

    const error = await writeFileAtomic(path, "CLOUDFLARE_API_TOKEN=live\n", { mode: 0o600 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(path);
    await expect(stat(loot)).rejects.toThrow();
    // Left where it is. Deleting it is a write to the very path we just refused to write.
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  test("refuses one partway up the path, not only at the target", async () => {
    // A link at `apps/` carries every write below it out of the project, and the final component is an
    // ordinary file the whole way. Checking only the target answers about the wrong inode.
    const elsewhere = join(outside, "elsewhere");
    await mkdir(elsewhere);
    const apps = join(dir, "apps");
    await symlink(elsewhere, apps);
    owner.byPath.set(apps, foreign);

    const error = await writeFileAtomic(join(apps, ".dev.vars"), "CLOUDFLARE_API_TOKEN=live\n", {
      mode: 0o600,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(apps);
    await expect(stat(join(elsewhere, ".dev.vars"))).rejects.toThrow();
  });

  test("refuses one planted mid-chain, behind a link that is ours", async () => {
    // The first hop being legitimate says nothing about the second. Every hop is asked.
    const loot = join(outside, "loot");
    const middle = join(dir, "middle");
    await symlink(loot, middle);
    owner.byPath.set(middle, foreign);
    const path = join(dir, ".dev.vars");
    await symlink(middle, path);

    await expect(writeFileAtomic(path, "CLOUDFLARE_API_TOKEN=live\n", { mode: 0o600 })).rejects.toThrow(PithyError);
    await expect(stat(loot)).rejects.toThrow();
  });

  test("follows a link the operator made, even one that leaves the project", async () => {
    // A worktree's `.dev.vars` is a symlink to the main checkout's (`scripts/worktree.ts`), and writing
    // through it is the point — a rename over it detaches the share into a stale private copy (#146).
    // The destination is outside every root available here, so only ownership can tell this from the case
    // above. It is the same shape as the attack and the opposite answer.
    const main = join(outside, ".dev.vars");
    await writeFile(main, "SHARED=abc\n");
    await chmod(main, 0o600);
    const worktree = join(dir, ".dev.vars");
    await symlink(main, worktree);

    await writeFileAtomic(worktree, "SHARED=rotated\n", { mode: 0o600 });

    expect((await lstat(worktree)).isSymbolicLink()).toBe(true);
    expect(await readFile(main, "utf8")).toBe("SHARED=rotated\n");
    expect(await modeOf(main)).toBe("600");
  });

  test("follows a root-owned link, which is not an escalation", async () => {
    // Root can read the file whatever we do, so refusing buys nothing and breaks a root-provisioned
    // checkout run as an ordinary user. The allowance is deliberate, so it is pinned.
    const shared = join(dir, "shared");
    await writeFile(shared, "OLD=1\n");
    const link = join(dir, "provisioned");
    await symlink(shared, link);
    owner.byPath.set(link, 0);

    await writeFileAtomic(link, "NEW=1\n");

    expect(await readFile(shared, "utf8")).toBe("NEW=1\n");
  });
});

/**
 * The random suffix that closed the plantable temp name opened a leak: every killed run leaves a *distinct*
 * `.dev.vars.<rand>.tmp` holding the whole plaintext credential file, and nothing reclaimed them. The old
 * fixed name was at least overwritten by the next run. `*.tmp` keeps them out of git and out of `npm pack`;
 * it does not keep them off the disk.
 *
 * The next successful write to the same target sweeps them. Not an exit handler — SIGKILL, a pulled power
 * cord and an OOM kill are precisely the cases that leave one, and none of them run a handler.
 */
describe("writeFileAtomic — the temp files a killed run leaves", () => {
  /** Ten minutes. A write here takes milliseconds; nothing this old is still in flight. */
  const LONG_AGO = new Date(Date.now() - 10 * 60_000);

  async function aged(path: string, contents: string): Promise<string> {
    await writeFile(path, contents, { mode: 0o600 });
    await utimes(path, LONG_AGO, LONG_AGO);
    return path;
  }

  test("sweeps its own stale temp files, each of which holds the whole credential file", async () => {
    const path = join(dir, ".dev.vars");
    const first = await aged(`${path}.0011223344556677.tmp`, "CLOUDFLARE_API_TOKEN=live\n");
    const second = await aged(`${path}.8899aabbccddeeff.tmp`, "CLOUDFLARE_API_TOKEN=live\n");

    await writeFileAtomic(path, "CLOUDFLARE_API_TOKEN=rotated\n", { mode: 0o600 });

    await expect(stat(first)).rejects.toThrow();
    await expect(stat(second)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("CLOUDFLARE_API_TOKEN=rotated\n");
  });

  test("leaves one new enough to be another write still in flight", async () => {
    const path = join(dir, ".dev.vars");
    const live = `${path}.8899aabbccddeeff.tmp`;
    await writeFile(live, "IN=flight\n");

    await writeFileAtomic(path, "TOKEN=rotated\n", { mode: 0o600 });

    expect(await readFile(live, "utf8")).toBe("IN=flight\n");
  });

  test("touches nothing that is not the shape it writes", async () => {
    const path = join(dir, ".dev.vars");
    const kept = [
      `${path}.tmp`, // The old fixed name. It may be an adopter's file; the shape we produce is not this.
      `${path}.zz.tmp`, // Right ends, wrong middle.
      `${path}.0011223344556677.bak`, // Right middle, wrong end.
      join(dir, "other.0011223344556677.tmp"), // Our shape, another target's.
    ];
    for (const leftover of kept) await aged(leftover, "not ours\n");

    await writeFileAtomic(path, "TOKEN=rotated\n", { mode: 0o600 });

    for (const leftover of kept) expect(await readFile(leftover, "utf8")).toBe("not ours\n");
  });

  test("never unlinks a symlink left at a temp name", async () => {
    // Removing a planted link is a write to a path the exclusive open just refused. It stays, and so does
    // whatever it points at.
    const path = join(dir, ".dev.vars");
    const planted = `${path}.0011223344556677.tmp`;
    await symlink(join(outsideOf(dir), "loot"), planted);
    await lutimes(planted, LONG_AGO, LONG_AGO);

    await writeFileAtomic(path, "TOKEN=rotated\n", { mode: 0o600 });

    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
  });

  test("a sweep that cannot run does not fail the write", async () => {
    // Best effort by construction: the bytes are already renamed into place when it runs.
    const path = join(dir, "sub", "file.txt");
    await mkdir(dirname(path));
    await writeFileAtomic(path, "content\n");
    expect(await readFile(path, "utf8")).toBe("content\n");
  });
});

/** A sibling of `dir` that does not exist. Only its name is needed. */
function outsideOf(path: string): string {
  return join(dirname(path), "pithy-atomic-nowhere");
}

/**
 * The gate on the gate. This escape has now had five producers across four rounds, and each round fixed the
 * reported one while another sat untouched a file away. {@link writeFileAtomic} is the answer for a file
 * write; this is what stops a sixth from being written beside it.
 *
 * A hand-rolled temp-file-plus-rename gets none of what is above it: no exclusive create, no unguessable
 * name, no ownership check on the links it writes through, no mode carried onto the temp file, and no sweep
 * of what a killed run leaves. Every one of those was a shipped bug here.
 *
 * `rename` itself is not banned — `worker rename` moves a directory, which is its ordinary use. The shape
 * this looks for is `rename` plus a `.tmp` path, which is the atomic-write idiom and nothing else.
 */
describe("the gate on the gate", () => {
  const CLI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  test("no module rolls its own temp-file-plus-rename", async () => {
    const entries = await readdir(CLI_SRC, { recursive: true, withFileTypes: true });
    const handRolled: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const path = join(entry.parentPath, entry.name);
      if (
        path.includes(`${sep}test-utils${sep}`) ||
        path === fileURLToPath(import.meta.url).replace(/\.test\.ts$/, ".ts")
      )
        continue;
      const source = await readFile(path, "utf8");
      const importsRename = /import\s+\{[^}]*\brename\b[^}]*\}\s+from\s+"node:fs(?:\/promises)?"/.test(source);
      if (importsRename && /\.tmp[`"']/.test(source)) handRolled.push(relative(CLI_SRC, path));
    }

    // `seed/media.ts` is the fifth producer, found while closing the fourth. Its sidecar is an asset-id
    // manifest rather than a credential, so it is listed rather than left silent — and this fails the day
    // somebody routes it through `writeFileAtomic`, which is the day to delete the line.
    expect(handRolled.sort(), "route it through writeFileAtomic, then delete it from this list").toEqual([
      join("seed", "media.ts"),
    ]);
  });
});
