// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, lstat, readlink, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";

/** How many links deep a chain may go before it is called a loop. Well past anything deliberate. */
const MAX_LINK_DEPTH = 16;

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
 */
export async function writeFileAtomic(path: string, content: string, options?: AtomicWriteOptions): Promise<void> {
  const target = await resolveLink(path);
  const mode = (await modeOf(target)) ?? options?.mode;
  const tmp = `${target}.tmp`;
  // Created restricted, not widened afterwards: a chmod after the write leaves a window where the
  // secret sits on disk world-readable. The umask can only clear bits, so the chmod below is what
  // makes the mode exact — including the case where the target is deliberately wider than the umask.
  await writeFile(tmp, content, mode === undefined ? {} : { mode });
  try {
    // Always, not only on create: `writeFile` truncates a `.tmp` left by a crashed run without
    // touching its mode, and O_CREAT masks the requested mode with the umask.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
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
