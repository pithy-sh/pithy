// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a project's local D1 stores live, under its root: the directory `pithy migrate --env dev` persists to. */
const LOCAL_D1 = join(".wrangler", "state", "v3", "d1");

/**
 * **Run `work` against a private copy of the project's local D1 store, then remove the copy (#697).**
 *
 * `pithy migrate --dry-run` reads the local store to say what is pending, and Miniflare can write to a store
 * merely by opening it — a database file created, a journal touched. A plan that leaves a byte behind has
 * written something, so it never opens the project's own `.wrangler/state`: it opens this copy, under the
 * system temporary directory, and the copy is gone before this returns, whether `work` finished or threw.
 *
 * A project that has never migrated has no store, and `work` is handed an empty root — which reads as a store
 * with nothing applied, and that is the truth.
 */
export async function inLocalStateCopy<T>(projectDir: string, work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pithy-migrate-plan-"));
  try {
    try {
      await cp(join(projectDir, LOCAL_D1), join(root, LOCAL_D1), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return await work(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
