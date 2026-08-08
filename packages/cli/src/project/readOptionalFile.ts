// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { InternalError, type PithyError } from "@pithy-sh/core/src/error/pithyError";
import { errnoOf } from "./atomic";

/**
 * The one place a failed file read is turned into "there is no file".
 *
 * **Only `ENOENT` means the file is not there.** Every other errno is a file that exists and did not
 * open: `EACCES` after someone tightened a mode, `EISDIR`, `ELOOP`, `EIO` on a failing disk. That
 * sentence is one line long and this codebase has now paid for it three times, in three files, written
 * by three separate changes:
 *
 * - `.dev.vars` (`../devSecrets/devVars.ts`). A read that answered "empty" for `EACCES` meant the next
 *   content was built from an empty base and renamed over a file full of values the process never saw —
 *   an adopter's `CLOUDFLARE_API_TOKEN` and every other line, gone, with the run reporting a clean write.
 * - `dev.json` (`../devSecrets/bootstrapVars.ts`). Read-modify-write over a file with other tenants: a
 *   present-but-unreadable one would have been replaced, silently deleting a developer's dev-login
 *   preferences.
 * - `pithy.manifest.json` (`../capabilities/manifests.ts`, #184). A present-but-invalid manifest read as
 *   absent made the capability vanish from `pithy add --list`, `upgrade` and `doctor` with no message at
 *   all — the three commands most likely to be run when something is missing were the three that stayed
 *   silent.
 *
 * Three producers is this repository's usual count for a rule that lives at call sites instead of at the
 * thing being called. The mechanism is not carelessness: `.catch(() => null)` is *shorter* than the
 * correct version, so the wrong thing is the thing that gets typed. A primitive inverts that, and gives
 * the invariant one place to be tested rather than a fresh test per reader — which is what a fourth
 * reader silently goes without.
 *
 * **What stays at the call site is the sentence the adopter reads.** A `.dev.vars` that will not open and
 * a `dev.json` that will not open want different words and different error classes, and neither belongs
 * here; `options.unreadable` is where a caller keeps its own. What may not stay at the call site is the
 * decision about which errno means absence.
 *
 * The gate for this rule is in `./readOptionalFile.test.ts` — stated about any module that writes, not
 * about the three readers above, because enumerating the known ones is exactly what produced the second
 * and the third.
 */

/**
 * What one read produced. Three answers, because collapsing any two of them is the defect above — and a
 * caller that must not throw needs all three as values rather than as an exception it has to catch.
 */
export type FileRead =
  /** The file is there and these are its bytes. */
  | { readonly state: "read"; readonly text: string }
  /** `ENOENT`, and nothing else: nothing has been written at that path. */
  | { readonly state: "absent" }
  /** The file is there and did not open. The errno says which failure it was; the cause is node's own. */
  | { readonly state: "unreadable"; readonly code: string | undefined; readonly cause: unknown };

/** What a call site is told about a read that failed for anything but `ENOENT`. */
export interface UnreadableFile {
  /** The path that would not open, exactly as it was asked for. */
  readonly path: string;
  /** The errno string, or `undefined` when the failure carried none. Never the file's contents. */
  readonly code: string | undefined;
  /** Node's own error, to be carried as `cause` so nothing about the failure is lost. */
  readonly cause: unknown;
}

/** How {@link readOptionalFile} refuses. */
export interface ReadOptionalFileOptions {
  /**
   * The refusal this file deserves, in this command's words — `.dev.vars` and `dev.json` each have their
   * own, and both predate this module. Returning anything but a `PithyError` is not possible, so a
   * caller cannot quietly turn the refusal back into an absence here.
   */
  readonly unreadable?: (failure: UnreadableFile) => PithyError;
}

/**
 * The file's bytes, or `null` when there is no file — **and only when there is no file.**
 *
 * Anything else throws, naming the path and the errno and carrying node's error as `cause`. The message
 * holds the path because the operator has to look at it; it never holds a byte of the file, which for
 * every file this was written for would be a credential.
 */
export async function readOptionalFile(path: string, options: ReadOptionalFileOptions = {}): Promise<string | null> {
  const read = await readFileOutcome(path);
  if (read.state === "read") return read.text;
  if (read.state === "absent") return null;
  const failure = { path, code: read.code, cause: read.cause };
  throw options.unreadable?.(failure) ?? defaultRefusal(failure);
}

/**
 * The same read, as a value rather than an exception: bytes, absence, or the failure that is neither.
 *
 * For the caller that was asked about *many* files and must still answer for the rest. `availableManifests`
 * scans every installed package: one that ships no manifest is ordinary and silent, one whose manifest will
 * not open is a fault to report by name, and a throw would take the listing of the other fifteen with it.
 */
export async function readFileOutcome(path: string): Promise<FileRead> {
  try {
    return { state: "read", text: await readFile(path, "utf8") };
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", code, cause };
  }
}

/** The refusal a caller that named no words of its own gets: the path, the errno, and node's error. */
function defaultRefusal({ path, code, cause }: UnreadableFile): PithyError {
  return new InternalError(
    {
      message: `${path} is there and could not be read.`,
      action: "Check that path and its permissions, then run the command again.",
      detail: `${code ?? "unknown error"} while reading ${path}`,
    },
    { cause },
  );
}
