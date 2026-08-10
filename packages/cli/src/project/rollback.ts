// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { readFileOutcome } from "./readOptionalFile";
import { pathExists } from "./scaffold";

/**
 * Run a set of writes so a failure leaves the tree exactly as it found it.
 *
 * **The invariant is over the outcome, not the order.** A scaffolding command that writes and then does
 * something that can fail leaves the adopter holding half a project — and worse, holding one its own
 * refusal mistakes for a finished one. `pithy ui add` wrote its whole template and then composed the
 * app; a composition that threw left the files written, the wiring absent, and the retry refused by the
 * "this Worker already has a front end" guard, which is correct in itself and cannot tell a finished
 * front end from one abandoned a minute ago (#259). The way out was deleting files by hand, which is
 * precisely what a scaffolder exists to prevent.
 *
 * Ordering alone does not close it. Putting the step that fails first removes the *known* failure, and
 * the next one added goes back on the end of the list. This states the property instead, so a command
 * built out of it cannot regress into the old shape: whatever throws, and wherever, the tree is
 * restored.
 *
 * `pithy worker add` has done this by hand since #158 — it deletes the Worker directory it just created
 * when the wiring throws. This is that, generalized to a set of files rather than one new directory, so
 * a command that edits files an adopter already owns can have the same guarantee.
 *
 * **Text only.** A snapshot is the file's characters, which is what every path this covers holds: a
 * scaffolder's templates are `Record<string, string>` by construction, and the four documents it edits
 * are JSON and JSONC. A binary asset would need bytes, and adding one is a reason to revisit this rather
 * than a case it silently mishandles.
 *
 * **Best effort on the way back, and deliberately silent about it.** A restore that itself fails is
 * swallowed and the original error is rethrown: the failure the caller was told about is the more
 * useful answer, and replacing it with a second one buries the cause. Same trade `addWorker` documents.
 */

/** One path's state before the run: its contents, or absence. */
interface Snapshot {
  path: string;
  content: string | null;
}

/**
 * Read one path's contents, or record that nothing is there.
 *
 * **Only `ENOENT` is absence**, and here that rule has teeth beyond the usual: a file recorded as absent
 * is one the rollback *deletes*. Reading `EACCES` as "not there" would make this function destroy the
 * very file it exists to protect. So an unreadable path refuses the whole run, before a byte is written
 * — the one moment when refusing costs nothing.
 */
async function snapshot(path: string): Promise<Snapshot> {
  const read = await readFileOutcome(path);
  if (read.state === "absent") return { path, content: null };
  if (read.state === "unreadable") {
    throw new InternalError({
      message: `${path} could not be read, so this command cannot undo itself if it fails.`,
      action: "Fix that file's permissions, then run the command again.",
      detail: `${read.code ?? "unknown errno"} while snapshotting for rollback.`,
    });
  }
  return { path, content: read.text };
}

/**
 * Every directory between `root` (exclusive) and `path` (exclusive) that does not exist yet, outermost
 * first.
 *
 * Recorded because a restore that only removes files leaves the directories they were created in, and an
 * empty `src/routes/pithy/` is a tree that reads clean to a person and fails a comparison. `root` itself
 * is never a candidate: it is the project, and it was there before the run.
 */
async function missingAncestors(root: string, path: string): Promise<string[]> {
  const missing: string[] = [];
  const base = resolve(root);
  let dir = dirname(resolve(path));
  // `pathExists` is `lstat`: a symlink standing where a directory should be is *something*, and treating
  // it as absence would have this function remove an adopter's link on the way out.
  while (dir !== base && !relative(base, dir).startsWith("..") && dir !== dirname(dir)) {
    if (await pathExists(dir)) break; // this one is there, and so is every ancestor above it
    missing.push(dir);
    dir = dirname(dir);
  }
  return missing.reverse();
}

/** What a rollback scope covers: the boundary it will not delete past, and the files it may restore. */
export interface RollbackScope {
  /** The directory every path lives under, and the one this never removes — the project root. */
  root: string;
  /**
   * Every file the run may create or modify, absolute. A path the run touches that is not listed here is
   * not restored, so a command's list is part of its contract: `ui/flow.ts` builds it from the plan it is
   * about to write plus the four documents it edits.
   */
  paths: readonly string[];
}

/** Put one path back the way it was: its contents, or gone. */
async function restore(entry: Snapshot): Promise<void> {
  try {
    if (entry.content === null) {
      await rm(entry.path, { force: true });
      return;
    }
    // `writeFile` truncates in place, so a file that was there keeps the mode it had. Nothing here
    // changes a permission, which is what makes restoring a `0600` file safe.
    await mkdir(dirname(entry.path), { recursive: true });
    await writeFile(entry.path, entry.content);
  } catch {
    // See the module note: the original failure is the one worth reporting.
  }
}

/**
 * Snapshot `scope.paths`, run `write`, and restore every one of them if it throws — including removing
 * the directories the run had to create. The original error is rethrown untouched.
 *
 * On success nothing is restored and nothing is copied anywhere: the snapshot is held in memory for the
 * duration of the run and dropped. These are config files and template sources, so the cost is bytes.
 */
export async function withRollback<T>(scope: RollbackScope, write: () => Promise<T>): Promise<T> {
  const before = await Promise.all(scope.paths.map(snapshot));
  const created = new Set<string>();
  for (const entry of before) {
    if (entry.content !== null) continue;
    for (const dir of await missingAncestors(scope.root, entry.path)) created.add(dir);
  }

  try {
    return await write();
  } catch (cause) {
    for (const entry of before) await restore(entry);
    // Deepest first, and `rmdir` rather than a recursive remove: a directory that is not empty is one the
    // adopter has something in, and removing it would be this function causing the loss it exists to
    // prevent. `rmdir` refuses a non-empty directory, so the refusal is the filesystem's, not a check
    // that can be wrong.
    for (const dir of [...created].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      await rmdir(dir).catch(() => {});
    }
    throw cause;
  }
}
