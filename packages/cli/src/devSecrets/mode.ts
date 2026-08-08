// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Stats } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Group and other bits — everything a file holding a session key or a client secret must not carry. */
const SHARED_BITS = 0o077;

/**
 * Take the group and other bits off a dev secrets file, and change nothing else.
 *
 * **Shared by both files, because the rule is about their contents and not about their names.**
 * `.dev.vars` got this first; the secrets file did not, and it is the more sensitive of the two —
 * `.dev.vars` holds env bindings and the dev master key, the JSONC file holds every application secret
 * including the OAuth client secrets. Two funnels, one rule, and a private copy in each is how they drift.
 *
 * **Narrowing only.** An adopter's deliberate 0400 survives, 0664 becomes 0600. A mode is never widened
 * from here: this runs on every write, and a rule that could widen would be a rule that eventually does.
 *
 * **Only a regular file we own.** A directory or a device at that path is not ours to re-mode, and
 * neither is another account's file — on a shared checkout that would be an unrequested change to
 * somebody else's permissions. Best effort throughout: the bytes are already written, and a mode that
 * could not be set is not worth failing a `pithy dev` over.
 */
export function tightenMode(path: string): Promise<void> {
  return tighten(path, (entry) => entry.isFile());
}

/**
 * The same rule for the directory the secrets file sits in — `<config>/<project>/`, 0700.
 *
 * A directory is not ours to re-mode in general, which is why {@link tightenMode} refuses one. This one
 * is: `pithy` creates `<config>/<project>/` itself, for its own files (#156, #131). Its mode matters
 * separately from the file's, because a listing of it is the inventory of every secret name this project
 * has — `auth-google-credentials` names the provider, `stripe-webhook-secret` names the vendor — and
 * `mkdir`'s `mode` argument only applies on creation. A directory an older pithy, a `cp -r`, or a restore
 * left at 0755 would otherwise stay 0755 for as long as the project exists.
 */
export function tightenDirMode(path: string): Promise<void> {
  return tighten(path, (entry) => entry.isDirectory());
}

/**
 * Make sure the directory holding `file` exists and is `0700`, on this call and on every later one.
 *
 * `mkdir`'s `mode` only applies to a directory it creates, and it is masked by the umask besides — so a
 * directory already there keeps whatever mode it was made with. The narrowing runs unconditionally for
 * the same reason a file's does: the case it exists for is the directory somebody else created.
 *
 * **One implementation, because there are three kinds of file under this root now** — `secrets.jsonc`,
 * `dev.json`, and the account's `cloudflare.json` — and every one of them is a credential whose *listing*
 * is a finding on its own. A private copy per writer is how the third one lands at the umask default.
 */
export async function ensureOwnerOnlyDirFor(file: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tightenDirMode(dir);
}

/** The one narrowing, so the file rule and the directory rule cannot drift apart. */
async function tighten(path: string, accept: (entry: Stats) => boolean): Promise<void> {
  const entry = await stat(path).catch(() => null);
  if (entry === null || !accept(entry)) return;
  const us = process.geteuid?.();
  if (us !== undefined && entry.uid !== us) return;
  const mode = entry.mode & 0o7777;
  if ((mode & SHARED_BITS) === 0) return;
  await chmod(path, mode & ~SHARED_BITS).catch(() => {});
}
