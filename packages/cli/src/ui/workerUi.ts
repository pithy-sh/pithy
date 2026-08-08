// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { parse, stringify } from "comment-json";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile, requireRecord } from "../project/readOptionalFile";
import { WORKER_MANIFEST_FILE, type WorkerUi } from "../project/workerManifest";

/**
 * The `ui` block of `pithy.worker.jsonc` — the framework-stub contract as persisted.
 *
 * ```jsonc
 * "ui": { "stub": "react", "build": ["vite", "build"] }
 * ```
 *
 * `pithy deploy` reads `build` and runs it through the adopter's package manager before
 * `wrangler deploy`; `pithy ui sync` reads `stub` to know which worker already has a front end. The
 * block's presence **is** the "this worker has a UI" signal, which is why `pithy ui add` refuses on
 * a worker that already carries one rather than half-overwriting a scaffold.
 *
 * Read here from the raw JSONC rather than through `parseWorkerManifest`: the Zod manifest strips
 * what it does not declare, and this reader has to see the block whether or not the schema has caught
 * up with it. Writes go back comment-preserving (comment-json), mutating in place — replacing an
 * object or array would drop the adopter's notes, which live on it as symbol-keyed properties.
 */

/** A parsed `pithy.worker.jsonc`, loose — this module writes two known blocks and preserves the rest. */
type ManifestDocument = Record<string, unknown> & {
  dev?: Record<string, unknown>;
  ui?: Record<string, unknown>;
};

/**
 * Parse `<dir>/pithy.worker.jsonc` comment-preserving, or an empty document when the file is **absent**.
 *
 * Absent means `ENOENT` and nothing else — the decision is {@link readOptionalFile}'s, and the words are
 * this file's. A read that answered `{}` for every failure was #142 with a different file name: the caller
 * merges its two blocks into that empty base and {@link writeManifestDocument} renames the result over a
 * file whose every other block the process never saw. Committed rather than gitignored, so the loss is
 * recoverable from git — but only by someone who notices before committing over it.
 *
 * **Three ways in, and `{}` is the answer to exactly one of them.** The file is not there; the file is
 * there and will not open; the file opened and is not a document. The third was the last path left from
 * "the read succeeded" to "start from an empty base" (#204) — `typeof null === "object"` let `null`
 * through, and an array passed the same check and then lost every key `stringify` drops off it. Such a
 * file is malformed either way, which changes what the loss costs, not whether it is the same defect.
 *
 * The tag check that decides the third was written here and is {@link requireRecord}'s now (#209): the
 * two credential files reached the same conclusion independently, which is the count at which a rule
 * stops belonging to the call site. The words below are still this file's — a `pithy.worker.jsonc` names
 * a manifest object, not a document — and only the decision moved.
 */
export async function readManifestDocument(workerDir: string): Promise<ManifestDocument> {
  const path = join(workerDir, WORKER_MANIFEST_FILE);
  const raw = await readOptionalFile(path, {
    unreadable: ({ code, cause }) =>
      new ConflictError(
        {
          message: `Cannot update ${path}: Pithy could not read what is already in it.`,
          action: "Fix the file's permissions, or move it aside, and run the command again.",
          detail: `${code ?? "unknown error"} while reading ${path}`,
        },
        { cause },
      ),
  });
  if (raw === null) return {};
  let value: unknown;
  try {
    value = parse(raw);
  } catch (cause) {
    throw new InternalError({
      message: `${WORKER_MANIFEST_FILE} in ${workerDir} is not valid JSONC.`,
      action: "Fix the syntax, then run pithy ui add again.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return requireRecord(path, value, {
    notARecord: ({ found }) =>
      new ConflictError({
        message: `Cannot update ${path}: it holds ${found}, not a manifest object.`,
        action: "Restore it to a JSONC object, or move it aside, and run the command again.",
        detail: `${WORKER_MANIFEST_FILE} in ${workerDir} parsed to ${found}`,
      }),
  }) as ManifestDocument;
}

/** Write the document back, 2-space with a trailing newline — the repo's JSONC formatting. */
export async function writeManifestDocument(workerDir: string, document: ManifestDocument): Promise<void> {
  await writeFileAtomic(join(workerDir, WORKER_MANIFEST_FILE), `${stringify(document, null, 2)}\n`);
}

/** The `ui` block on a parsed document, or `null` when the worker has no front end. */
export function uiBlock(document: ManifestDocument): WorkerUi | null {
  const block = document.ui;
  if (typeof block !== "object" || block === null) return null;
  const stub = (block as { stub?: unknown }).stub;
  const build = (block as { build?: unknown }).build;
  if (typeof stub !== "string") return null;
  return {
    stub,
    build: Array.isArray(build) ? build.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

/** The `ui` block for a worker directory, or `null`. The "does this worker already have a UI?" check. */
export async function readWorkerUi(workerDir: string): Promise<WorkerUi | null> {
  return uiBlock(await readManifestDocument(workerDir));
}
