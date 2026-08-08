// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { readFileOutcome } from "../project/readOptionalFile";

/** Mode for an rc file we create from scratch: owner read/write, group/other read (POSIX `0644`). */
const RC_FILE_MODE = 0o644;

/**
 * Read an rc file, returning `''` when it does not exist yet (the common first-install case).
 *
 * "Does not exist" is {@link readFileOutcome}'s decision, not this module's — an rc file that is there
 * and will not open must not read as an empty one, because `removeFromRcFile` rewrites what it read.
 *
 * Through the outcome rather than `readOptionalFile` because this reader rethrows node's own error
 * untouched, and `readOptionalFile`'s refusal is a `PithyError` by construction. Wrapping it would be a
 * behaviour change, which routing is not allowed to be.
 */
export async function readRcFile(path: string): Promise<string> {
  const read = await readFileOutcome(path);
  if (read.state === "read") return read.text;
  if (read.state === "absent") return "";
  throw read.cause;
}

/** True when `target` resolves to `home` itself or a path beneath it. */
function isInsideHome(home: string, target: string): boolean {
  const rel = relative(home, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Append text to an rc file, creating it (mode `0644`, with parent directories) when missing.
 *
 * Two safety refusals, per docs/CLI.md §2.5:
 * - **Symlink escape.** If the path is a symlink whose real target lands outside the user's home
 *   directory, refuse — following it could clobber a file the user never meant to expose.
 * - **Read-only file.** If the file exists without an owner write bit, refuse with a clean error that
 *   points to manual install, never a raw stack trace.
 *
 * The write itself is append-only: we never read-modify-write the whole file on install.
 */
export async function appendToRcFile(path: string, text: string): Promise<void> {
  const home = existsSync(osHomedir()) ? realpathSync(osHomedir()) : osHomedir();

  // Symlink-escape guard. lstat does not follow the link, so it fires even for a *dangling* symlink — the
  // case a plain `existsSync` (which follows) would silently skip, letting us create a file at the escaped
  // target. Resolve the target with realpath when it exists (following the whole chain), else from the raw
  // link (dangling), and refuse when it lands outside the user's home directory.
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) {
    let target: string;
    try {
      target = realpathSync(path);
    } catch {
      const raw = readlinkSync(path);
      target = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
    }
    if (!isInsideHome(home, target)) {
      throw new ConflictError({
        message: `${path} is a symlink that points outside your home directory.`,
        action: "Refusing to follow it. Add the Pithy alias to your shell config yourself.",
        detail: `Symlink target resolved to ${target}, outside ${home}.`,
      });
    }
  }

  // Permission guard: an existing file with no owner write bit is read-only to us. `statSync` follows the
  // link, so this checks the real target (skipped for a dangling link, which has no target to write yet).
  if (existsSync(path) && (statSync(path).mode & 0o200) === 0) {
    throw new ValidationError({
      message: `Can't write to ${path} — it's read-only.`,
      action: "Make it writable, or add the Pithy alias to your shell config yourself.",
    });
  }

  const existedBefore = existsSync(path);
  if (!existedBefore && !info) await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text);
  // Force the exact mode on a brand-new regular file we created, regardless of the process umask.
  if (!existedBefore && !info) await chmod(path, RC_FILE_MODE);
}

/**
 * Remove exactly the marker-delimited block (`open` … `close`, inclusive) from an rc file, leaving
 * everything else byte-intact. Returns whether a block was found and removed. This is the one
 * read-modify-write path — removal must parse and rewrite — but it touches only our own lines.
 */
export async function removeFromRcFile(path: string, open: string, close: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const contents = await readFile(path, "utf8");
  const lines = contents.split("\n");
  const openIdx = lines.indexOf(open);
  const closeIdx = lines.indexOf(close);
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return false;

  // Also drop the single blank line we inserted before the block on install, if it is still there.
  const start = openIdx > 0 && lines[openIdx - 1] === "" ? openIdx - 1 : openIdx;
  lines.splice(start, closeIdx - start + 1);
  await writeFile(path, lines.join("\n"));
  return true;
}
