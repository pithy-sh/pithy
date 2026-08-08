// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { parse, stringify } from "comment-json";
import { writeFileAtomic } from "../project/atomic";
import { DEV_SECRETS_FILE_NAME, ensureDevSecretsDir } from "./location";
import { tightenDirMode, tightenMode } from "./mode";
import { ownProperties } from "./records";

/**
 * The dev secrets file as bytes on disk — the seam `@pithy-sh/secrets` deliberately left open. That
 * package is Workers-runtime code with no `node:` imports: it parses text and returns what should be
 * written. Reading, writing, the mode, and "absent means no secrets" are the CLI's.
 *
 * **Every function here takes the resolved absolute path, never a project root** (#156). The file
 * lives at `<config>/<project>/secrets.jsonc`, outside the checkout — see `location.ts`, which owns
 * the one resolution — so "the project's directory" is no longer the answer to where it is, and a
 * second module deriving it would be the second answer to a question that must have one.
 *
 * **The mode is not a detail.** The file holds OAuth client secrets, Stripe keys, and whatever else a
 * capability needs that cannot be minted. It is written `0600` on creation *and on every rewrite* —
 * see {@link writeFileAtomic}, where the rename is what used to widen it back to the umask default —
 * and narrowed on every write path whether or not a write was needed, which is the case the `mode`
 * option cannot reach: a file somebody else created at the umask that a re-run has nothing to add to.
 * The directory is held to `0700` on the same terms: its listing is the inventory of every secret name
 * this project has, and `mkdir`'s mode only applies to a directory it creates. See {@link tightenMode}
 * and {@link tightenDirMode}.
 *
 * **Nothing about `.gitignore` remains, because nothing is in the repository to ignore.** This module
 * used to verify an ignore rule before writing a byte — the guarantee that stood between a minted
 * session key and a commit. Moving the file out of the checkout removes the hazard rather than
 * guarding it: there is no path in the project, no `.tmp` sibling in the project, and nothing for a
 * `git add -A` to reach. `.dev.vars` still lives in the project and its ignore lines stay in the
 * template.
 *
 * **Writes merge, they never replace.** The file is hand-edited: comments say where a value came from,
 * and a trailing comma is the residue of deleting a line. So a write re-parses the adopter's own text
 * with `comment-json` and edits *that* tree, rather than stringifying what the loader returned — the
 * loader strips comments, and a write built from it would quietly delete every note in the file.
 *
 * **And a present secret always wins.** Minting over a value that is already there is how a re-run
 * invalidates every live session and breaks every magic link already in an inbox. The merge adds keys
 * and changes none. The one exception is explicit: a *provisioned* value, which somebody else issued.
 *
 * **Nothing thrown from here carries a byte of the file.** `comment-json` puts the whole source in its
 * `SyntaxError.message`, so every parse goes through {@link parseTree} — see there for what that cost.
 * What it does carry is the **absolute path**, in every error: the file is outside the checkout now, so
 * "your secrets file is malformed" names nothing the reader can open.
 */

/**
 * The header a file this command creates leads with. Three lines, because three things are not obvious
 * from the contents: where the file is (nothing in the project points at it), that the outer object is
 * always the envelope, and that the keys are registry names rather than env bindings.
 */
const HEADER = `// Local dev secret values. Machine-local, outside every checkout — nothing in the project points here.
// Keys are registry secret names — <capability>-<what>. The registry decides where each one is seeded.
// Every value is a full envelope: { "currentVersion": "1", "versions": { "1": <value> } }.
`;

/**
 * The bytes a file that does not exist yet starts from: the header, and an empty object.
 *
 * Exported for `edit.ts` — `pithy secrets edit` on a project with no file has to open the editor on
 * *something*, and an empty buffer is a document the adopter has to know the shape of before they can
 * type into it. It is the same header a mint would have created, so the first hand-written secret and
 * the first minted one land in a file that reads identically.
 */
export function initialDevSecretsContent(): string {
  return `${HEADER}{}\n`;
}

/**
 * The project's dev secrets, validated. An absent file is `{}` — a project has none until a capability
 * needs one, and that is not a fault. A file that is *there* and malformed is, and comes back as the
 * loader's `ValidationError` naming this project's real absolute path.
 */
export async function readDevSecrets(path: string): Promise<DevSecretsFile> {
  const source = await readDevSecretsSource(path);
  // Prototype-free, both branches. Every caller reads it as `file[name]` for a name the adopter typed,
  // and `{}` is the one an empty project hands to every lookup. See {@link ownProperties}.
  if (source === null) return ownProperties<never>({});
  return ownProperties(loadDevSecrets(source, { path }));
}

/**
 * The file's bytes, or `null` when there is no file — and **only** when there is no file.
 *
 * Exported for `edit.ts`, which needs the adopter's own text rather than the parsed value: an editor
 * opens on bytes, and every comment in the file is a byte the parse throws away. It reads through here
 * rather than calling `readFile` itself so that "there is no file yet" and "the file would not open"
 * stay one decision — a second reader answering `{}` for an EACCES is exactly the defect below.
 *
 * `ENOENT` is the one errno that means "no secrets yet". Every other one is a file that is there and
 * did not open: `EACCES` after someone tightened the mode, `EISDIR`, `EIO` on failing disk. Answering
 * `{}` for those was the same as answering "empty", so a write merged its one new value into an empty
 * base and the adopter's OAuth client secrets went with the next rename.
 *
 * The wrapped error carries the node error as `cause`. Its message is `EACCES: permission denied, open
 * '<path>'` — a path and an errno, never a byte of the file.
 */
export async function readDevSecretsSource(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as { code?: string } | null)?.code;
    if (code === "ENOENT") return null;
    throw new InternalError(
      {
        message: `${path} is there and could not be read.`,
        action: `Check that path and its permissions. It should be a file, mode 600.`,
        detail: `dev secrets file '${path}' failed to read: ${code ?? "unknown error"}`,
      },
      { cause },
    );
  }
}

/**
 * Merge `added` into the file body, keeping every comment, and keeping every value already there.
 * Pure — the caller owns the read and the write.
 *
 * Returns the source unchanged when there is nothing to add, so a re-run rewrites no bytes: the file's
 * mtime is what an adopter's editor watches, and churning it on every `pithy dev` would make the
 * idempotence the seeder works for invisible.
 */
export function mergeDevSecretsContent(content: string, added: DevSecretsFile): string {
  return mergeDevSecrets(content, added).content;
}

/**
 * `comment-json`'s parse, with the one thing that makes it safe to run on this file.
 *
 * **Its `SyntaxError.message` embeds the source.** `Unexpected token 'o', "{ … the entire file … }" is
 * not valid JSONC` — so a single missing brace, on the *write* path, printed every OAuth client secret
 * in the file to the terminal and into whatever logged the error. `loadDevSecrets` was taught this
 * already and has the sanitized error, with the line and column and nothing else; the write path
 * re-parsed with a bare `parse` and no catch, and this module's own docstring promised the opposite.
 *
 * Re-raising through the loader rather than composing a second error keeps one sentence for one fault:
 * the message an adopter sees for a malformed file is the same whichever command hit it first.
 */
function parseTree(source: string, path: string): Record<string, unknown> | null {
  try {
    return parse(source) as Record<string, unknown> | null;
  } catch {
    loadDevSecrets(source, { path });
    // Unreachable in practice: the same source that just failed `parse` fails the loader's parse too.
    throw new InternalError({
      message: `${path} could not be parsed.`,
      action: `Fix the syntax in that file and run the command again.`,
      detail: `dev secrets file '${path}' failed to parse on the write path`,
    });
  }
}

/** The merge, plus the names it actually landed — what {@link writeDevSecrets} reports to its caller. */
function mergeDevSecrets(
  content: string,
  added: DevSecretsFile,
  replace = false,
  path: string = DEV_SECRETS_FILE_NAME,
): { content: string; added: string[] } {
  const source = content.trim().length === 0 ? initialDevSecretsContent() : content;
  const tree = parseTree(source, path);
  // A file whose top level is not an object is the loader's error to raise, with its own actionable
  // message. Anything written here would land inside something that is not a secrets file.
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return { content, added: [] };

  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a secret named for an
  // `Object.prototype` key read as already present and was dropped — a mint the caller was told landed.
  const names = Object.keys(added).filter((name) =>
    replace ? !same(tree[name], added[name]) : !Object.hasOwn(tree, name),
  );
  if (names.length === 0) return { content, added: [] };
  for (const name of names) tree[name] = added[name];
  return { content: `${stringify(tree, null, 2)}\n`, added: names };
}

/** Whether two envelopes are the same value, so a re-provision of an unchanged secret rewrites no bytes. */
function same(current: unknown, next: unknown): boolean {
  return current !== undefined && JSON.stringify(current) === JSON.stringify(next);
}

/**
 * Add every secret in `added` that the file does not already carry, and return the names that landed.
 *
 * The return value is the whole point of the call for a caller that reports: `pithy add` says "minted"
 * only for what it actually minted, and says "left as it is" for the rest. Assuming the write happened
 * is how a command claims to have minted a value it did not.
 *
 * Nothing to add writes nothing at all, and creates no directory: an empty `secrets.jsonc` conjured by
 * a no-op `pithy add` would be one more thing to explain.
 *
 * **The mint is unconditional now, and that is the point of the move.** This used to verify the
 * project's `.gitignore` covered the file before writing a byte, and refuse the whole set when it could
 * not. There is nothing left to refuse: the file is not in the checkout, so no `.gitignore` governs it
 * and no commit can reach it.
 */
export async function writeDevSecrets(
  path: string,
  added: DevSecretsFile,
  options: WriteDevSecretsOptions = {},
): Promise<string[]> {
  try {
    if (Object.keys(added).length === 0) return [];
    // The merge base. A read that fails for anything but ENOENT throws rather than answering "empty":
    // merging into an empty base is how a write replaces a file of secrets with the one it is adding.
    const content = (await readDevSecretsSource(path)) ?? "";
    const merged = mergeDevSecrets(content, added, options.replace === true, path);
    if (merged.added.length === 0) return [];

    await ensureDevSecretsDir(path);
    await writeFileAtomic(path, merged.content, { mode: 0o600 });
    return merged.added;
  } finally {
    // Unconditionally, whatever happened above, and including the no-op return. The `mode` on the write
    // is right and it left the mode to a write that mostly never happens: every caller filters what is
    // already there first, so a re-run of `pithy add` reaches this function with nothing to add at all —
    // and a file created at the umask by an older pithy, an editor, or a `cp` kept 0644 forever while
    // holding the OAuth client secrets `.dev.vars` only carries a copy of.
    //
    // No file is still no file — {@link tightenMode} stats and returns — so a no-op add conjures
    // nothing. Narrowing only, so a deliberate 0400 survives. The directory is held the same way, for
    // the same reason: its listing names every secret this project has.
    await tightenMode(path);
    await tightenDirMode(dirname(path));
  }
}

/** How {@link writeDevSecrets} treats a name the file already carries. */
export interface WriteDevSecretsOptions {
  /**
   * Overwrite a value already in the file. **For a value somebody else issued, never for a mint.**
   *
   * The default — a present secret always wins — exists because minting over a live session key
   * invalidates every session and minting over a link key breaks every magic link already in an inbox.
   * A provisioner is the opposite case: `pithy turnstile provision` is handed the widget's secret by
   * Cloudflare, and keeping the old one leaves the project verifying against a widget it no longer has.
   *
   * An identical value still writes nothing, so a re-provision does not churn the file's mtime.
   */
  replace?: boolean;
}

/**
 * Delete each named secret from the file, and answer which ones were actually there.
 *
 * The counterpart to a provisioner's write. `pithy turnstile deprovision` deletes the widget; leaving
 * its secret behind would have the next `pithy dev` seed and inject a key for a widget that no longer
 * exists, which reads as "turnstile is configured" everywhere anyone would look.
 *
 * Comments and every other value survive, for the same reason a write merges rather than replaces: the
 * file is hand-maintained, and the note saying where a value came from is the useful part of it. No
 * file, or no name present, writes nothing at all.
 */
export async function removeDevSecrets(path: string, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const content = await readDevSecretsSource(path);
  if (content === null || content.trim().length === 0) return [];

  const tree = parseTree(content, path);
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return [];
  // `Object.hasOwn`, not `in`: a secret named for an `Object.prototype` key would otherwise read as
  // present in an empty file, and `delete` would report a removal that never happened.
  const removed = names.filter((name) => Object.hasOwn(tree, name));
  if (removed.length === 0) return [];
  for (const name of removed) delete tree[name];
  await writeFileAtomic(path, `${stringify(tree, null, 2)}\n`, { mode: 0o600 });
  return [...removed];
}
