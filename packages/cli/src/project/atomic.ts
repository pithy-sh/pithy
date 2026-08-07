// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import { chmod, lstat, readlink, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ConflictError, InternalError, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";

/** How many links deep a chain may go before it is called a loop. Well past anything deliberate. */
const MAX_LINK_DEPTH = 16;

/** Bytes of randomness in a temp file's name. 64 bits: nothing to guess, nothing to plant at. */
const TEMP_SUFFIX_BYTES = 8;

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /**
   * The mode a **newly created** file lands with — for the files that hold credentials, where the umask
   * is not a permission policy. Ignored when the target already exists: those permissions are the
   * adopter's, tighter or looser than ours, and a write is not the moment to overrule them.
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
 * kept; `options.mode` is the mode for creating one that is not there yet.
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
 */
export async function writeFileAtomic(path: string, content: string, options?: AtomicWriteOptions): Promise<void> {
  const target = await resolveLink(path);
  const mode = (await modeOf(target)) ?? options?.mode;
  const tmp = `${target}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}.tmp`;
  try {
    // `wx` is O_CREAT|O_EXCL: the file is always brand new, so the mode below is the mode it is *born*
    // with rather than one it is widened to afterwards. Both halves matter. Exclusivity is the guard —
    // a planted file or symlink fails the open rather than being followed. Creating restricted is the
    // window — a chmod after the write leaves an interval where a plaintext credential is on disk at
    // the umask default, and a crashed run's leftover would have kept its own mode through O_CREAT.
    await writeFile(tmp, content, { flag: "wx", mode: mode ?? 0o666 });
  } catch (err) {
    // Nothing is unlinked here: we did not create it, so removing it would be a write to the very path
    // we just refused — and if the open failed for any other reason, that file is somebody else's.
    throw writeFailure(target, tmp, err);
  }
  try {
    // The umask above can only clear bits, so it can have cleared one the target actually had. This is
    // what makes the mode exact, including a target deliberately wider than the umask allows.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw writeFailure(target, tmp, err);
  }
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

/** The permission bits of the file at `path`, or undefined when nothing is there to read them from. */
async function modeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Where a chain of symlinks ends — the path to write. A dangling link resolves to the path it names, so
 * the write creates that file and the link keeps pointing at it. A cycle is refused: following it is an
 * infinite loop, and picking a link in it to overwrite would guess which one the caller meant.
 */
async function resolveLink(path: string): Promise<string> {
  let current = path;
  for (let depth = 0; depth <= MAX_LINK_DEPTH; depth += 1) {
    let link: string;
    try {
      if (!(await lstat(current)).isSymbolicLink()) return current;
      link = await readlink(current);
    } catch {
      return current; // Nothing there, or it stopped being a link mid-walk — write at this path.
    }
    current = isAbsolute(link) ? link : resolve(dirname(current), link);
  }
  throw new InternalError({
    message: `Refusing to write ${path}: its symlink chain never ends.`,
    action: "Fix the link — something points back at itself.",
    detail: `More than ${MAX_LINK_DEPTH} symlinks deep from ${path}.`,
  });
}
