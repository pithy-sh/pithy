// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";
import { ensureScaffoldPath, pathExists } from "../project/scaffold";

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
  /** The worker's directory — `apps/<name>`. Every path below it is checked; the directory itself is the
   * caller's, and `pithy worker add` is what gates *that* one. */
  workerDir: string;
  /** The stub's file record: worker-relative path → contents. */
  files: Record<string, string>;
  /** Refuse the whole run if any path exists (the default). Off for a backfill, which skips instead. */
  strict?: boolean;
}): Promise<ScaffoldResult> {
  const entries = Object.entries(options.files).sort(([a], [b]) => a.localeCompare(b));

  const skipped: string[] = [];
  for (const [rel] of entries) {
    const path = join(options.workerDir, rel);
    // Every directory this run would create or write through, before any of it is created. `exists()` here
    // was `access`, which follows a link and answers about its destination — so a symlink at
    // `apps/<worker>/src` read as "src/client.tsx is missing", cleared the gate, and `pithy ui add react`
    // wrote six files of the front end outside the project and exited 0. Reproduced against the real CLI.
    //
    // The refusal covers the backfill (`strict: false`) too, and that is not the same rule as the skip
    // below. A file already *there* is safe to skip because nothing is written to it. A link where a
    // directory belongs is the opposite: the file under it does not exist, so the backfill writes — outside.
    await ensureScaffoldPath(options.workerDir, dirname(path));
    if (await pathExists(path)) skipped.push(rel);
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
