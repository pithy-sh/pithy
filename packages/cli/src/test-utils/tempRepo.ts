// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";

/**
 * The two halves of "a test made a git repository in a temp directory and then deleted it", which is a
 * race unless both are handled.
 *
 * ## Why a repo is not an ordinary directory to delete
 *
 * `git commit` can leave work running after it exits. Auto-maintenance — `gc --auto`, and the
 * commit-graph and `pack-refs` steps under it — is spawned in the background and detached, so the
 * command returns while a second process is still writing inside `.git`. A recursive delete that starts
 * in that window unlinks a directory's contents, then finds a file back in it, and `rmdir` fails:
 *
 * ```
 * Error: ENOTEMPTY: directory not empty, rmdir '/tmp/pithy-pack-ke283n/checkout/.git/info'
 * ```
 *
 * It reproduces on a loaded machine and essentially never on an idle one, which is why it arrived from
 * CI rather than from anybody's laptop.
 *
 * ## Both halves, because either alone is a coin flip
 *
 * {@link GIT_NO_MAINTENANCE} removes the cause: with `gc.auto=0` and `maintenance.auto=false` there is no
 * second process to race. {@link removeTempDir} survives it anyway — Node's `rm` retries exactly the
 * errno family this produces (`ENOTEMPTY`, `EBUSY`, `EPERM`, `EMFILE`), and it defaults to **no** retries.
 *
 * Configuration is passed per invocation rather than written into the repo, so it holds for `init`
 * itself. A `git config` line lands after the repository already exists, which is one command too late.
 */
export const GIT_NO_MAINTENANCE = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"] as const;

/**
 * Delete a temp directory, tolerating a writer that has not finished.
 *
 * `force` so a directory already gone is not an error — a test that cleans up twice, or one whose
 * fixture never got created, should not fail in teardown. The retries are the part that matters: ten
 * attempts over roughly a second, which is far longer than any background git step needs and still short
 * enough that a genuinely stuck delete fails the suite rather than hanging it.
 */
export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
