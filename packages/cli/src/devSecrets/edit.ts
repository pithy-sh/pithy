// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { ConflictError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { requireEditor, runEditor } from "../platform/editor";
import { writeFileAtomic } from "../project/atomic";
import { formatError } from "../terminal/output";
import { initialDevSecretsContent, readDevSecretsSource } from "./file";
import { ensureDevSecretsDir } from "./location";
import { tightenDirMode, tightenMode } from "./mode";

/**
 * `pithy secrets edit` — open the dev secrets file wherever it lives, and take back what comes out (#157).
 *
 * Since #156 the file is at `<config>/<project>/secrets.jsonc`, outside every checkout. That is the whole
 * point of it: nothing to gitignore, nothing a `git add -A` reaches, nothing an `npm pack` carries. It
 * also removes the obvious way to edit it, and "resolve the path yourself and open it" is not a workflow.
 * A symlink back into the project is the tempting answer and is the one thing that must not happen —
 * every tool that follows a link would see the file again, which is how #145 put a maintainer's
 * `.dev.vars` in a published tarball.
 *
 * **The edit is never the thing that is lost.** That is the invariant this module exists for, and every
 * decision below follows from it:
 *
 * - The editor opens on a **draft** beside the real file, never on the real file. So the real file is
 *   only ever replaced by content that has already parsed and validated — no editor's rename lands a
 *   half-written document on it, and no `:wq` of something malformed breaks every later command.
 * - A draft that does not validate is **re-opened on the adopter's own text**, with the problem printed
 *   above it. Re-opening the *file* would quietly discard everything they typed, and what they were
 *   typing may be the only copy of a credential that exists.
 * - A draft that still does not validate, that the editor abandoned, or that lost a race with another
 *   command **is kept**, and the refusal names its absolute path. Nothing here ever deletes text it
 *   could not write.
 * - A draft that is byte-identical to what it started from is deleted, because there is nothing in it
 *   to keep and it holds every value the real file does.
 *
 * **The draft is a plaintext copy of every secret in the project, so it lives where the real file
 * lives** — inside `<config>/<project>/`, which is held at `0700`, created `0600` through
 * {@link writeFileAtomic}, and named with 64 bits of randomness so nothing can be waiting at the path.
 * Not the OS temp directory: that is world-listable on a shared machine, and it is not covered by any of
 * the mode discipline this directory has (#150, #151).
 *
 * **Nothing it prints or throws carries a value.** The file holds OAuth client secrets and Stripe keys;
 * `comment-json` puts the whole source into its own `SyntaxError.message`, so every parse goes through
 * `loadDevSecrets`, whose errors carry a line, a column, and a secret *name* at worst. That is asserted
 * in `edit.test.ts` for both the syntax and the schema failure, because "the error carries no value" is
 * the kind of property that holds until one convenient interpolation.
 */

/** Opens `file` in the adopter's editor, waits, and resolves with its exit status. */
export type OpenEditor = (file: string) => Promise<number>;

/** What {@link editDevSecrets} needs. */
export interface EditDevSecretsOptions {
  /** The resolved absolute path of the dev secrets file — `location.ts` owns that resolution. */
  path: string;
  /**
   * Resolve the editor, then hand back the opener. **Called once, before any draft exists**, so a run
   * with no terminal or no usable editor refuses without leaving a copy of every secret on disk — and so
   * that a `$EDITOR` changed mid-session cannot swap editors between two rounds of the same edit.
   *
   * Defaults to the real one: `$VISUAL`, `$EDITOR`, platform default, refusing an editor that does not
   * wait and a run with no TTY. See `platform/editor.ts`.
   */
  editor?: () => OpenEditor;
  /**
   * Where the "that did not parse" notice goes. Defaults to stderr, which is where it belongs: stdout
   * is the `--json` contract, and this is a message for the person at the terminal.
   */
  report?: (text: string) => void;
}

/** What an edit did. Counts and flags — never a secret's name, and never a value. */
export interface EditDevSecretsResult {
  /** Whether the file was written. False for an edit that changed nothing, which is not a failure. */
  changed: boolean;
  /** How many secrets the file holds now. A count: the names are the adopter's, and `secrets ls` lists them. */
  secrets: number;
  /** How many times the edit had to be handed back. Zero is the ordinary case. */
  reopened: number;
}

/** Open the dev secrets file in the adopter's editor, validate what comes back, and write it. */
export async function editDevSecrets(options: EditDevSecretsOptions): Promise<EditDevSecretsResult> {
  const { path } = options;
  const report = options.report ?? ((text: string) => void process.stderr.write(text));
  // Before the draft. A refusal here — no terminal, an editor that returns immediately, none installed —
  // must not have left a plaintext copy of the project's secrets sitting in the config directory.
  const open = (options.editor ?? (() => defaultEditor(path)))();

  const original = await readDevSecretsSource(path);
  const base = original === null || original.trim().length === 0 ? initialDevSecretsContent() : original;
  const draft = draftPath(path);
  await ensureDevSecretsDir(path);
  await writeFileAtomic(draft, base, { mode: 0o600 });

  // `previous` is what the draft held when the editor was last opened on it. An adopter who saves
  // nothing after being shown the problem has given up, and that is the one stop condition here: a
  // fixed round count would either cut someone off mid-fix or spin forever on an editor that no-ops.
  //
  // Nothing below deletes the draft on a failure. Every `throw` here leaves it where the message says
  // it is, because it is the only place the adopter's text exists.
  let previous = base;
  for (let reopened = 0; ; reopened += 1) {
    const status = await open(draft);
    const edited = await readDraft(draft);

    // The editor deleted it, or never wrote it: there is nothing to keep and nothing to write.
    if (edited === null || edited === base) return await abandon(draft, path, original);
    if (status !== 0) throw abandonedByEditor(status, path, draft);

    const checked = validate(edited, draft);
    if (checked.file !== undefined) {
      await commit(path, edited, original);
      await unlink(draft).catch(() => {});
      return { changed: true, secrets: Object.keys(checked.file).length, reopened };
    }
    if (edited === previous) throw stillBroken(checked.problem.payload, path);

    report(`${formatError(checked.problem.payload)}\nNothing has been written. Re-opening your text.\n`);
    previous = edited;
  }
}

/** The real editor: resolved once against the real path, then run on whatever file it is given. */
function defaultEditor(path: string): OpenEditor {
  const editor = requireEditor(path);
  return (file) => runEditor(editor, file);
}

/**
 * `<dir>/secrets.edit-<hex>.jsonc` — beside the file, in the `0700` directory, with an unguessable name.
 *
 * The extension is kept so an editor still highlights JSONC, and the `.edit-` infix is deliberately not
 * the `.<hex>.tmp` shape `writeFileAtomic` sweeps: that sweep deletes anything of ours older than a
 * minute, and an edit that takes longer than a minute is an edit, not a corpse.
 */
function draftPath(path: string): string {
  const { dir, name, ext } = parse(path);
  return join(dir, `${name}.edit-${randomBytes(8).toString("hex")}${ext}`);
}

/** The draft's bytes, or null when the editor removed it. */
async function readDraft(draft: string): Promise<string | null> {
  return readFile(draft, "utf8").catch(() => null);
}

/**
 * Validate an edit the way every other reader of this file does — the same loader `pithy dev`, `pithy
 * add` and `pithy seed` go through, so an edit this accepts is an edit they accept.
 *
 * It answers with the parsed file rather than a boolean, so the count reported afterwards comes from the
 * parse that approved the text and not from a second one that could disagree with it. The fault comes
 * back rather than being thrown: a failure here is a round of the loop, not the end of the command.
 */
function validate(
  source: string,
  path: string,
): { file: DevSecretsFile; problem?: never } | { file?: never; problem: PithyError } {
  try {
    return { file: loadDevSecrets(source, { path }) };
  } catch (error) {
    if (error instanceof PithyError) return { problem: error };
    throw error;
  }
}

/** An edit that changed nothing: delete the draft — it holds every value the real file does. */
async function abandon(draft: string, path: string, original: string | null): Promise<EditDevSecretsResult> {
  await unlink(draft).catch(() => {});
  // The count is of what is *there*, which for an abandoned edit is whatever the file already held. A
  // file that does not parse counts as none rather than failing: the adopter just declined to fix it,
  // and answering with a second error about the same fault would be the command arguing with them.
  const held = original === null ? {} : (validate(original, path).file ?? {});
  return { changed: false, secrets: Object.keys(held).length, reopened: 0 };
}

/**
 * Write the validated text, refusing if the file moved underneath the edit.
 *
 * The race is ordinary rather than exotic: `pithy dev` and `pithy add` both mint into this file, and an
 * edit is open for as long as somebody is typing. A blind write would drop a freshly minted session key
 * that nothing else has a copy of. The check is a re-read rather than an mtime, because an mtime has a
 * resolution and a value does not.
 */
async function commit(path: string, edited: string, original: string | null): Promise<void> {
  const current = await readDevSecretsSource(path);
  if ((current ?? null) !== (original ?? null)) {
    throw new ConflictError({
      message: `${path} changed while you were editing, so nothing was written.`,
      action: "Another command wrote it — pithy add or pithy dev. Merge the two by hand.",
      detail: `dev secrets file '${path}' differs from the content the edit started from`,
    });
  }
  try {
    await writeFileAtomic(path, edited, { mode: 0o600 });
  } finally {
    // The same closing discipline every other write of this file has: narrowing only, and unconditional,
    // because the case it exists for is a file somebody else created at the umask.
    await tightenMode(path);
    await tightenDirMode(dirname(path));
  }
}

/** The editor exited non-zero on text that had changed. Kept, named, and not written. */
function abandonedByEditor(status: number, path: string, draft: string): PithyError {
  return new ValidationError({
    message: `Your editor exited with status ${status}, so ${path} is unchanged. Your text is in ${draft}.`,
    action: "Nothing was discarded. Move that file into place yourself if you meant to keep it.",
    detail: `editor exited ${status} with a changed draft at '${draft}'`,
  });
}

/**
 * The edit was handed back and came again unchanged and still invalid. Kept, named, and not written.
 *
 * The draft is not a parameter here because it is already in `problem.message`: the loader was given the
 * draft's path, since the draft is the file that was actually open. Naming the real file for a fault in
 * the draft would send the adopter to a file that is perfectly fine.
 */
function stillBroken(problem: ErrorPayload, path: string): PithyError {
  return new ValidationError({
    // `problem.message` names the draft, because the draft is the file that was open. It is quoted
    // whole: the fault an adopter can act on is the loader's own sentence, not a paraphrase of it.
    message: `${problem.message} ${path} is unchanged, and your text is kept.`,
    // Not the loader's own action. It says to fix the syntax, which is true and is what they just
    // declined to do; what they need to know is that the text is not gone and that a re-run opens the
    // real file rather than the draft, so the draft is theirs to move.
    action: "Nothing was discarded. Fix that file and move it into place, or start again.",
    detail: problem.detail,
  });
}
