// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, stat } from "node:fs/promises";

/** Group and other bits — everything a file holding a session key or a client secret must not carry. */
const SHARED_BITS = 0o077;

/**
 * Take the group and other bits off a dev secrets file, and change nothing else.
 *
 * **Shared by both files, because the rule is about their contents and not about their names.**
 * `.dev.vars` got this first; `.dev.secrets.jsonc` did not, and it is the more sensitive of the two —
 * `.dev.vars` holds a transitional copy, the JSONC file holds the OAuth client secrets that copy is made
 * from. Two funnels, one rule, and a private copy in each is how they drift.
 *
 * **Narrowing only.** An adopter's deliberate 0400 survives, 0664 becomes 0600. A mode is never widened
 * from here: this runs on every write, and a rule that could widen would be a rule that eventually does.
 *
 * **Only a regular file we own.** A directory or a device at that path is not ours to re-mode, and
 * neither is another account's file — on a shared checkout that would be an unrequested change to
 * somebody else's permissions. Best effort throughout: the bytes are already written, and a mode that
 * could not be set is not worth failing a `pithy dev` over.
 */
export async function tightenMode(path: string): Promise<void> {
  const entry = await stat(path).catch(() => null);
  if (entry === null || !entry.isFile()) return;
  const us = process.geteuid?.();
  if (us !== undefined && entry.uid !== us) return;
  const mode = entry.mode & 0o7777;
  if ((mode & SHARED_BITS) === 0) return;
  await chmod(path, mode & ~SHARED_BITS).catch(() => {});
}
