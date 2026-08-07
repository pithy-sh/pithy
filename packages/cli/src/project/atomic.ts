// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readdir, readlink, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { ConflictError, InternalError, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";

/** How many links deep a walk may go before it is called a loop. Well past anything deliberate. */
const MAX_LINK_DEPTH = 16;

/** Bytes of randomness in a temp file's name. 64 bits: nothing to guess, nothing to plant at. */
const TEMP_SUFFIX_BYTES = 8;

/** The tail every temp file this module writes carries, and the only shape {@link sweepStaleTemps} removes. */
const TEMP_SUFFIX = ".tmp";

/**
 * How old a temp file has to be before it is treated as a corpse rather than a write in flight. A write
 * here is a few milliseconds of one small file; a minute is not slow, it is dead.
 */
const STALE_TEMP_MS = 60_000;

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /**
   * The mode a **newly created** file lands with — for the files that hold credentials, where the umask
   * is not a permission policy. Ignored when the target already exists *and is ours*: those permissions
   * are the adopter's, tighter or looser than ours, and a write is not the moment to overrule them. A
   * target somebody else owns has its mode ignored instead — see {@link adoptableModeOf}.
   */
  mode?: number;
}

/**
 * Write `content` to `path` atomically: write to a sibling `.tmp` file first, then rename.
 *
 * **The rename replaces the target, so everything the target *was* has to be carried onto the temp file
 * first.** Two things were not, and both failed silently.
 *
 * Its **mode**. `pithy init` chmods `.dev.vars` to 0600, and the first `pithy add` or `pithy token mint
 * --store dev-vars` wrote through here and handed it back the temp file's 0644 — at exactly the moment
 * it started holding `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS`. An existing target's mode is
 * kept; `options.mode` is the mode for creating one that is not there yet. Kept only from a target that is
 * *ours*, though — a mode read off a file is an instruction taken from a file, and pre-creating `.dev.vars`
 * at 0666 is one line of work for anyone who can write the directory. See {@link adoptableModeOf}.
 *
 * Its **link**. `apps/<worker>/.dev.vars` is a symlink to the project's shared file, and a rename over a
 * symlink does not follow it — it deletes it and leaves a private regular file holding a stale copy.
 * Nothing repairs that afterwards: the wiring then correctly sees a regular file and reports it `kept`
 * forever, so the worker silently stops seeing every secret the shared file gains. The link is resolved
 * and written *through* — a dangling one has its destination created rather than the link replaced — and
 * a chain that loops is refused rather than followed.
 *
 * **The temp file is somewhere nobody could have got to first.** Its name was `${target}.tmp`: a path
 * anyone able to write the project directory could work out and plant a symlink at. The write followed
 * that link, chmod'd its destination, and the rename then installed the link permanently over the target
 * — so `.dev.vars` and every later write of it went wherever the planter chose. There was no race to win.
 * The name now carries {@link TEMP_SUFFIX_BYTES} random bytes, and the file is created **exclusively**, so
 * anything already at the path fails the open instead of being written through.
 *
 * **And the temp file is only ever touched through the descriptor that created it.** The exclusive create
 * closed the *write* half of that and left the *chmod* half open: `chmod(tmp, mode)` resolves the name a
 * second time, so swapping the temp file for a symlink in the window after the open chmod'd the link's
 * destination instead — an arbitrary chmod on any file the invoking user owns, which for a mode of 0666 is
 * an arbitrary disclosure. A path-based operation after a path-based create is the shape of the bug, every
 * time. The handle is held: `fchmod` and the write both go through the descriptor, so there is no second
 * resolution of the name to win. What remains path-based is the `rename` itself, which Node gives no
 * descriptor-relative form of — so before it runs, the inode at the name is checked against the inode the
 * bytes actually went into ({@link ensureUnswapped}). That turns a reliable swap into the same narrow race
 * the walk below already documents; it does not close it.
 *
 * **And the link is only followed when we could have made it.** Closing the temp path moved that same
 * escape one step earlier rather than shutting it: plant the link at `.dev.vars` instead of at its temp
 * file and a live `CLOUDFLARE_API_TOKEN` lands outside the project exactly as before. See
 * {@link resolveWritePath} for why the rule is ownership and not location — the short of it is that the
 * link this must follow points outside the project too.
 *
 * **What a killed run leaves is reclaimed.** An unguessable temp name means every interrupted write leaves
 * a *distinct* file holding the whole plaintext of what it was writing, where the old fixed name was at
 * least overwritten by the next run. `*.tmp` keeps those out of git and out of `npm pack`; it does not keep
 * them off the disk. A finished write sweeps its target's stale siblings ({@link sweepStaleTemps}). Not an
 * exit handler: SIGKILL, an OOM kill and a pulled power cord are exactly the cases that leave one, and none
 * of them run a handler.
 */
export async function writeFileAtomic(path: string, content: string, options?: AtomicWriteOptions): Promise<void> {
  const target = await resolveWritePath(path);
  const mode = (await adoptableModeOf(target)) ?? options?.mode;
  const tmp = `${target}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}${TEMP_SUFFIX}`;

  let handle: FileHandle;
  try {
    // `wx` is O_CREAT|O_EXCL: the file is always brand new, so the mode here is the mode it is *born*
    // with rather than one it is widened to afterwards. Both halves matter. Exclusivity is the guard —
    // a planted file or symlink fails the open rather than being followed. Creating restricted is the
    // window — a file created at the umask default and tightened later spends an interval holding a
    // plaintext credential world-readable, and a crashed run's leftover would have kept its own mode
    // through O_CREAT.
    handle = await open(tmp, "wx", mode ?? 0o666);
  } catch (err) {
    // Nothing is unlinked here: we did not create it, so removing it would be a write to the very path
    // we just refused — and if the open failed for any other reason, that file is somebody else's.
    throw writeFailure(target, tmp, err);
  }

  let written: Stats;
  try {
    // `fchmod`, before a byte is written and through the descriptor rather than the name. Before,
    // because the umask can only clear bits and may have cleared one the target actually had, so this
    // is what makes the mode exact — and doing it while the file is still empty means the content never
    // exists at a mode wider than asked for. Through the descriptor, because the name is the attacker's
    // to change and the inode is not.
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(content);
    // `fstat` before the close. This is the inode the bytes are in, and the only way to ask later
    // whether the name still refers to it.
    written = await handle.stat();
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw writeFailure(target, tmp, err);
  }

  await ensureUnswapped(tmp, target, written);
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw writeFailure(target, tmp, err);
  }
  // After the rename, never before: the bytes are already in place, so a sweep that cannot run costs the
  // caller nothing. It never throws for the same reason.
  await sweepStaleTemps(target);
}

/**
 * Refuse to rename a temp file that is no longer the one this write created.
 *
 * `rename` is the last path-based step and there is no descriptor-relative form of it in Node, so the
 * name is resolved once more here whatever we do. Comparing the inode at the name against the inode the
 * bytes went into means a swap has to land inside the gap between this check and the rename rather than
 * anywhere in the whole write — the same narrow race {@link ensureOurs} already records, not a closure of
 * it. Left unchecked it is not a race at all: replace the temp file with a symlink any time before the
 * rename and the link gets installed over the target, which is exactly the escape the random name and the
 * exclusive create were meant to end.
 */
async function ensureUnswapped(tmp: string, target: string, written: Stats): Promise<void> {
  const now = await lstat(tmp).catch(() => undefined);
  if (now !== undefined && now.dev === written.dev && now.ino === written.ino) return;
  // Nothing is unlinked. Whatever is at that name now is not ours to remove — and our own inode already
  // is unlinked, because replacing the name is what did it, so the close above reclaimed it and the
  // plaintext with it.
  throw new ConflictError({
    message: `Refusing to write ${target}: its temporary file ${tmp} was replaced while it was being written.`,
    action: "Run this again. If nothing of yours could have done that, treat it as hostile.",
    detail: now === undefined ? `${tmp} no longer exists.` : `${tmp} is a different inode than the one written.`,
  });
}

/**
 * Turn a `node:fs` failure into the error contract. `--json` callers parse that contract, so a raw errno
 * escaping it is unreadable to them — and the two that actually happen here each have something to say.
 * The paths go in `message` because the operator has to look at them; the errno stays in `detail`.
 */
function writeFailure(target: string, tmp: string, err: unknown): PithyError {
  if (err instanceof PithyError) return err;
  const code = errnoOf(err);
  const detail = `${code ?? "unknown error"} while writing ${tmp}.`;
  if (code === "EEXIST") {
    return new ConflictError(
      {
        message: `Refusing to write ${target}: something is already at its temporary file ${tmp}.`,
        action: "Delete it and run this again. If you did not put it there, treat it as hostile.",
        detail,
      },
      { cause: err },
    );
  }
  if (code === "ENOENT") {
    return new NotFoundError(
      {
        message: `Cannot write ${target}: the directory it is in does not exist.`,
        action: "Create the directory, or fix the symlink pointing into it.",
        detail,
      },
      { cause: err },
    );
  }
  return new InternalError(
    {
      message: `Could not write ${target}.`,
      action: "Check the file and its directory are writable.",
      detail,
    },
    { cause: err },
  );
}

/** The `errno` string off a `node:fs` rejection, without asserting a shape onto an unknown value. */
function errnoOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code: unknown = Reflect.get(err, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * The permission bits worth carrying onto the temp file, or undefined when there are none to take.
 *
 * `lstat`, not `stat`: `path` comes out of {@link resolveWritePath} with every link already followed and
 * checked, so a link here would be one that appeared since — not one to read a mode through.
 *
 * **Only from a file we own.** Adopting the target's mode is what keeps an adopter's deliberate 0640, but
 * it is also an instruction taken from a file, and whoever wrote the file wrote the instruction. Someone
 * who can write the project directory but not read the 0600 file in it — the position every attack here is
 * launched from — pre-creates `.dev.vars` at 0666, and the freshly minted `CLOUDFLARE_API_TOKEN` lands
 * world-readable with the write reporting nothing wrong. A mode is only adopted from a file whose uid is
 * ours; otherwise the caller's mode stands, which is the mode that knows what it is about to write.
 *
 * Deliberately stricter than {@link ensureOurs}, which allows root. A root-owned *link* sends a write
 * somewhere root chose, and root can read anything of ours regardless — nothing is given away. A root-owned
 * *mode* of 0666 gives it to everybody else, which is not root's to hand out on our behalf.
 *
 * The same limit as {@link ensureOurs} applies: a platform with no uid model — Windows — has nothing to
 * compare and adopts unconditionally.
 */
async function adoptableModeOf(path: string): Promise<number | undefined> {
  try {
    const entry = await lstat(path);
    const us = process.geteuid?.();
    if (us !== undefined && entry.uid !== us) return undefined;
    return entry.mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** Root can already read and write anything of ours, so a link it made redirects nothing it did not have. */
const ROOT_UID = 0;

/**
 * Refuse a symlink somebody else made.
 *
 * This is the whole containment rule, and it is about the link's **owner**, not its destination, because
 * destination cannot separate the two cases:
 *
 * - `apps/<worker>/.dev.vars` → the project's shared file. Must be followed (#146): a rename over it
 *   detaches the share into a private copy holding a stale credential set, silently and permanently.
 * - a **worktree's** root `.dev.vars` → the **main checkout's**, which `scripts/worktree.ts` links
 *   absolutely and which lives outside the worktree entirely. Must also be followed.
 * - `.dev.vars` → `/tmp/loot`, planted by whoever can write the directory. Must be refused.
 *
 * The second and the third are the same shape: an absolute link out of the tree, to a path nothing here
 * can classify. Containing to a project root would refuse both and put #146 back; a root is not even
 * available at this depth. What actually differs is who made the link. Every legitimate one is made by the
 * developer running this command — by `worktree.ts`, by `vars:local`, by the worker wiring. A planted one
 * is made by a different uid: someone who can write a directory in the project but cannot read the 0600
 * file in it, which is exactly the position this attack is launched from. `symlink(2)` stamps the creating
 * uid on the link and only root may `chown` it afterwards, so that owner is not forgeable by the planter.
 *
 * Where the same uid made the link, it is ours by definition and there is nothing left to defend: anything
 * running as us can already read every file we could write.
 *
 * Two limits, stated rather than papered over. A platform with no uid model — Windows — has nothing to
 * compare and is not protected by this. And the check and the `readlink` after it are separate syscalls,
 * so a planter who can win a window that narrow is not stopped; closing that needs `openat`, which Node
 * does not expose for a directory-relative walk.
 */
function ensureOurs(link: string, uid: number, requested: string): void {
  const us = process.geteuid?.();
  if (us === undefined || uid === us || uid === ROOT_UID) return;
  throw new ConflictError({
    message: `Refusing to write ${requested}: ${link} is a symlink somebody else owns.`,
    action: "Delete it and run this again. If you did not put it there, treat it as hostile.",
    detail: `The link is owned by uid ${uid}; this process runs as uid ${us}.`,
  });
}

/** The non-empty parts of a path below its root. `parse().root` is what makes this correct on Windows too. */
function partsOf(path: string): string[] {
  return path.slice(parse(path).root.length).split(sep).filter(Boolean);
}

/**
 * Where the write actually lands — every component resolved, and every symlink on the way checked by
 * {@link ensureOurs}.
 *
 * The walk is component by component rather than a `readlink` on the last one, because a link three
 * directories up carries a write out of the project just as completely as a link at the target, and the
 * target reads as an ordinary file the whole time. `apps/` was the shape that did it (#147), and asking
 * only about the final component is what let it through.
 *
 * A dangling link resolves to the path it names, so the write creates that file and the link keeps
 * pointing at it. A missing directory resolves to the literal path below it and the write reports it. A
 * cycle is refused: following it never ends, and picking one link in it to overwrite would be a guess at
 * what the caller meant.
 *
 * **Nothing below a component that does not exist is normalised.** The walk used to hand the remainder to
 * `join`, which collapses `..` *lexically* — `missing/../apps/.dev.vars` came back as `apps/.dev.vars`,
 * a path the kernel would have refused outright and, worse, one whose surviving components were then
 * traversed by the open with no ownership check on them at all. Plant the link at `apps` and it is
 * followed. Do not lexically normalise a path you are about to hand to a syscall — that is the same
 * mistake as following a link because the name looked fine. Past the first missing component the walk
 * resolves nothing: components are appended verbatim, `..` included, and the syscall judges the path it
 * was actually given.
 */
async function resolveWritePath(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : join(process.cwd(), path);
  let resolved = parse(absolute).root;
  let pending = partsOf(absolute);
  let hops = 0;
  /** Set the moment a component turns out not to be there. Nothing after it can be resolved. */
  let missing = false;

  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    if (missing) {
      // Verbatim, not `join`. `join` would collapse a `..` here against a directory that does not exist,
      // inventing a path the caller never named and the kernel would never have reached.
      resolved = `${resolved}${sep}${part}`;
      continue;
    }
    if (part === "..") {
      // Safe only here, above the first missing component: every directory to the left has been walked
      // and every link in it expanded, so `resolved` is physical and its parent is the kernel's parent.
      resolved = dirname(resolved);
      continue;
    }

    const next = join(resolved, part);
    let link: string;
    try {
      const entry = await lstat(next);
      if (!entry.isSymbolicLink()) {
        resolved = next;
        continue;
      }
      ensureOurs(next, entry.uid, path);
      link = await readlink(next);
    } catch (err) {
      if (err instanceof PithyError) throw err;
      // Nothing here, or it stopped being a link between the two calls. Either way there is no link left
      // to follow: the rest is taken literally and the write reports whatever it finds.
      resolved = next;
      missing = true;
      continue;
    }

    hops += 1;
    if (hops > MAX_LINK_DEPTH) {
      throw new InternalError({
        message: `Refusing to write ${path}: its symlink chain never ends.`,
        action: "Fix the link — something points back at itself.",
        detail: `More than ${MAX_LINK_DEPTH} symlinks deep from ${path}.`,
      });
    }
    // A relative link is read from the directory holding it, which `resolved` already is. `..` inside one
    // is resolved after the hop, against where the link landed — the same order the kernel walks.
    if (isAbsolute(link)) resolved = parse(link).root;
    pending = [...partsOf(link), ...pending];
  }
  return resolved;
}

/**
 * Delete the stale temp files of `target` — what runs killed between the create and the rename left holding
 * a full copy of whatever was being written, `.dev.vars` included.
 *
 * Four conditions, each one load-bearing:
 *
 * - **Exactly the name this module writes**: `<target>.<16 hex>.tmp`. Not `<target>.tmp` — that was the old
 *   fixed name, and it is also a plausible file of an adopter's own. We remove our litter, not theirs.
 * - **A regular file.** A symlink planted at a temp name stays: unlinking it is a write to the path the
 *   exclusive open just refused, and a directory there is not ours to touch either.
 * - **Ours.** Another uid's file is not litter we may collect.
 * - **Old.** A concurrent write is a live temp file with a fresh mtime, and deleting one would break it.
 *
 * Best effort throughout: this runs after a successful rename, so nothing it does or fails to do changes
 * what the caller got. What it cannot reclaim is a leftover beside a target nothing writes again.
 */
async function sweepStaleTemps(target: string): Promise<void> {
  const us = process.geteuid?.();
  const directory = dirname(target);
  const prefix = `${basename(target)}.`;
  const width = prefix.length + TEMP_SUFFIX_BYTES * 2 + TEMP_SUFFIX.length;
  const cutoff = Date.now() - STALE_TEMP_MS;

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.length !== width || !name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
    if (!/^[0-9a-f]+$/.test(name.slice(prefix.length, -TEMP_SUFFIX.length))) continue;
    const stale = join(directory, name);
    try {
      const entry = await lstat(stale);
      if (!entry.isFile() || entry.mtimeMs > cutoff) continue;
      if (us !== undefined && entry.uid !== us) continue;
      await unlink(stale);
    } catch {
      // Already gone, or not ours to remove. The write this followed still succeeded either way.
    }
  }
}
