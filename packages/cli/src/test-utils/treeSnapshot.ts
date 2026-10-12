// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * **Every file under `dir`, by path, as a hash of its bytes** — the before-and-after a `--dry-run` test
 * compares to prove the run wrote nothing (#697). A symlink is recorded by where it points, never
 * followed, so a link swapped for another is a change and a link into a large tree costs nothing. Empty
 * directories are recorded too: a dry run that leaves one behind has written something. A file that cannot
 * be read is recorded by its mode, so a fixture can lock one and still be compared.
 */
export async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.length === 0 && current !== dir) snapshot.set(rel(current), "dir");
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) snapshot.set(rel(path), `link:${await readlink(path)}`);
      else if (entry.isDirectory()) await walk(path);
      else {
        const bytes = await readFile(path).catch(() => null);
        snapshot.set(
          rel(path),
          bytes === null
            ? `unreadable:${((await lstat(path)).mode & 0o777).toString(8)}`
            : createHash("sha256").update(bytes).digest("hex"),
        );
      }
    }
  };
  const rel = (path: string) => relative(dir, path).split(sep).join("/");
  await walk(dir);
  return snapshot;
}
