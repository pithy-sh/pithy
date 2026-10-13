// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  closeSync,
  type Dirent,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The code a filesystem error carries, or `undefined`. */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * **Copy one path of a live tree as it is at the moment it is read, with no check in front of the read (#711).**
 *
 * Other suites write files into this repository's tree and remove them while a copy of it is being taken. A copy
 * that asked first — `lstat`, then `cp` — had a gap between the question and the read, and a file removed in that
 * gap failed the copy with `ENOENT` on a run nobody changed. Here there is no question: a symbolic link is read
 * as a link, and anything else is opened, and once it is open it is read through the descriptor, which a later
 * removal cannot take away. A path that is already gone is reported as not copied. A directory is not this
 * function's: the caller lists files.
 *
 * `opened` is a test's hook into the moment after the open and before the read. Nothing else passes it.
 */
export function copyEntryOnce(from: string, to: string, opened?: (path: string) => void): boolean {
  try {
    const link = readlinkSync(from);
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(link, to);
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    if (codeOf(error) !== "EINVAL") throw error;
  }
  let fd: number;
  try {
    fd = openSync(from, "r");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    opened?.(from);
    const data = readFileSync(fd);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data, { mode: stat.mode & 0o777 });
    return true;
  } finally {
    closeSync(fd);
  }
}

/** What {@link copyTreeOnce} is told. */
export interface TreeCopyOptions {
  /** A name never copied, decided before anything is read: a file a parallel suite writes and removes. */
  readonly skip?: (name: string) => boolean;
  /** A test's hook into the moment after a directory is listed and before its entries are read. Nothing else passes it. */
  readonly listed?: (directory: string) => void;
}

/**
 * **Copy a live tree as it is while it is read, tolerating whatever vanishes meanwhile (#711).**
 *
 * `fs.cp` lists a directory, then `lstat`s each entry, so a file another suite removed between the two failed the
 * copy with `ENOENT` — `packages/email`'s `.wrangler.feature.json`, mid-way through a full run. A name filter answers
 * only for the names it knows. Here each directory is listed once and each entry copied by {@link copyEntryOnce},
 * so an entry gone by the time it is read is passed over, and a directory gone by the time it is listed copies
 * nothing. A symbolic link is copied as a link, never followed, to where it pointed — absolute, as `fs.cp` writes it,
 * so a package's `node_modules` links still reach the workspace from the copy.
 */
export function copyTreeOnce(from: string, to: string, options: TreeCopyOptions = {}): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return;
    throw error;
  }
  mkdirSync(to, { recursive: true });
  options.listed?.(from);
  for (const entry of entries) {
    if (options.skip?.(entry.name) === true) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTreeOnce(source, target, options);
    else if (entry.isSymbolicLink()) copyLinkOnce(source, target);
    else copyEntryOnce(source, target);
  }
}

/** A symbolic link, copied as a link to the absolute path it pointed at; one already gone is passed over. */
function copyLinkOnce(from: string, to: string): void {
  let link: string;
  try {
    link = readlinkSync(from);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(resolve(dirname(from), link), to);
}
