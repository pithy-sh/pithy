// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, rename, unlink, writeFile } from "node:fs/promises";

/** Options for {@link writeFileAtomic}. */
export interface WriteFileAtomicOptions {
  /**
   * The permission bits the landed file must have, e.g. `0o600`. Omit to leave the file to the umask,
   * which is what every caller writing non-secret config wants.
   */
  mode?: number;
}

/**
 * Write `content` to `path` atomically: write to a sibling `.tmp` file first, then rename.
 *
 * **`mode` is applied to the temp file, before the rename.** An atomic write is a rename, so the mode
 * that survives is the *temp* file's — chmod the target afterwards and the next write silently widens
 * it back to the umask default. That is a real leak, not a theoretical one: `.dev.secrets.jsonc` holds
 * OAuth client secrets, and 0644 makes them readable by every account on the machine from the second
 * write onwards.
 *
 * `chmod` rather than `writeFile`'s `mode` option, because that one is masked by the umask — a process
 * with `umask 0777` would get 0000 and the file would be unreadable by its own owner. `chmod` sets the
 * bits asked for.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  try {
    if (options.mode !== undefined) await chmod(tmp, options.mode);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
