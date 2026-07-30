// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";

/**
 * Create, never overwrite.
 *
 * A stub is scaffolded once and then it belongs to the adopter. Pithy may add files that do not exist
 * yet — an OTP screen today, whatever templates follow — because a new file cannot clobber work
 * somebody did. It may never rewrite one. That asymmetry is the whole ownership rule, and it is what
 * lets `pithy ui add --auth` backfill a scaffold created with `--no-auth`.
 *
 * The check runs over **every** path before anything is written, so a collision is a clean error
 * rather than a half-written directory.
 */

/** What one scaffold run wrote. */
export interface ScaffoldResult {
  /** The worker-relative paths written, sorted. Empty when every file already existed. */
  written: string[];
  /** The worker-relative paths already present and therefore left byte-identical, sorted. */
  skipped: string[];
}

/** True if `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a stub's file record into `workerDir`, creating parent directories.
 *
 * Every path that already exists is a `ConflictError` naming all of them, and nothing is written —
 * `strict` is the initial `pithy ui add`, where a collision means the worker already has a front end
 * of some sort and guessing which file to keep is not ours to do.
 *
 * With `strict` off (the backfill path) an existing file is skipped and reported instead. Either way
 * no existing byte changes.
 */
export async function scaffoldFiles(options: {
  /** The worker's directory — `apps/<name>`. */
  workerDir: string;
  /** The stub's file record: worker-relative path → contents. */
  files: Record<string, string>;
  /** Refuse the whole run if any path exists (the default). Off for a backfill, which skips instead. */
  strict?: boolean;
}): Promise<ScaffoldResult> {
  const entries = Object.entries(options.files).sort(([a], [b]) => a.localeCompare(b));

  const skipped: string[] = [];
  for (const [rel] of entries) {
    if (await exists(join(options.workerDir, rel))) skipped.push(rel);
  }

  if (skipped.length > 0 && options.strict !== false) {
    throw new ConflictError({
      message: `${skipped.length === 1 ? "This file already exists" : "These files already exist"}: ${skipped.join(", ")}.`,
      action: "Pithy never overwrites a file it did not just write. Move or delete them, then run pithy ui add again.",
    });
  }

  const written: string[] = [];
  for (const [rel, contents] of entries) {
    if (skipped.includes(rel)) continue;
    const path = join(options.workerDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, contents);
    written.push(rel);
  }

  return { written, skipped };
}
