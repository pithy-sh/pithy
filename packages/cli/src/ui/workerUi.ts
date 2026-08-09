// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { parse, stringify } from "comment-json";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";
import { readMergeBase } from "../project/readOptionalFile";
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
 * What the type above claims, as a check rather than as a cast — the two blocks this module assigns
 * into, and every other one of the adopter's kept untouched.
 *
 * `catchall` rather than a closed object for the same reason `dev.json`'s schema has one: a manifest holds
 * bindings, routes, a name and whatever the schema has not caught up with, and a write here must round-trip
 * all of it. What is declared is only what this module *dereferences* — `document.ui` is read as an object
 * and `document.dev` is assigned as one.
 */
const ManifestBlocks = z
  .object({
    dev: z
      .record(z.string().describe("A key of the dev block."), z.unknown().describe("Its value, whatever it is."))
      .optional()
      .describe("The `dev` block — `pithy dev`'s per-worker settings. An object when it is there at all."),
    ui: z
      .record(z.string().describe("A key of the ui block."), z.unknown().describe("Its value, whatever it is."))
      .optional()
      .describe("The `ui` block — the framework-stub contract. An object when it is there at all."),
  })
  .catchall(z.unknown().describe("Another block of the manifest, read and written back untouched."))
  .describe("A `pithy.worker.jsonc` as this module reads it: two blocks it knows, and every other one kept.");

/**
 * The same document, **validated without being rebuilt** (#222).
 *
 * The check has to be a check and not a parse, because comment-json hangs the file's notes off the object
 * it returns as symbol-keyed properties, and every Zod object schema constructs a *new* object from the
 * keys it validated. Running {@link ManifestBlocks} as the merge base's schema directly would therefore
 * pass every test about shape and silently drop every comment in the adopter's manifest at the next
 * write — trading the cast this exists to remove for a quieter version of the same loss.
 *
 * So the schema validates by delegation and hands back the value it was given, issue paths and all, which
 * is what lets a refusal name `ui` rather than "the top level".
 */
const ManifestDocument = z
  .custom<ManifestDocument>()
  .check((ctx) => {
    const checked = ManifestBlocks.safeParse(ctx.value);
    if (checked.success) return;
    // The key path travels and the message travels; the value never does. `readMergeBase` reports where a
    // document broke by key path alone, and this is the schema that has to keep that true.
    for (const issue of checked.error.issues) {
      ctx.issues.push({ code: "custom", path: issue.path, message: issue.message, input: ctx.value });
    }
  })
  .describe("A `pithy.worker.jsonc` document, checked against its shape and handed back exactly as parsed.");

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
 * The tag check that decides the third was written here and is `requireRecord`'s now (#209): the two
 * credential files reached the same conclusion independently, which is the count at which a rule stops
 * belonging to the call site.
 *
 * **And there was a fourth, which a cast made invisible (#222).** The read refused on all three above and
 * then asserted the survivor was a {@link ManifestDocument} — a type claiming `dev` and `ui` are objects —
 * so a manifest whose `ui` is the string `"react"` reached the merge as if it were valid. `readMergeBase`
 * is the whole sentence and this was the one reader in the family not asking it, so it asks it now: the
 * cast is a schema, the four refusals are its four, and the JSONC parser comes in through the seam that
 * exists for it. The words below are still this file's — a `pithy.worker.jsonc` names a manifest object,
 * not a document — and only the decisions moved.
 */
export async function readManifestDocument(workerDir: string): Promise<ManifestDocument> {
  const path = join(workerDir, WORKER_MANIFEST_FILE);
  const base = await readMergeBase(path, ManifestDocument, {
    // Comment-preserving, because {@link writeManifestDocument} hands this straight back to `stringify`.
    parse: (source) => parse(source),
    unreadable: ({ code, cause }) =>
      new ConflictError(
        {
          message: `Cannot update ${path}: Pithy could not read what is already in it.`,
          action: "Fix the file's permissions, or move it aside, and run the command again.",
          detail: `${code ?? "unknown error"} while reading ${path}`,
        },
        { cause },
      ),
    unparseable: () =>
      new ConflictError({
        message: `Cannot update ${path}: it is there and is not valid JSONC.`,
        action: "Fix the syntax, or move it aside, and run the command again.",
        // Never the parser's own message: comment-json quotes the line it choked on, and this rewrite
        // renames a whole document over the adopter's file. The path and "it did not parse" is the whole
        // of what fixes it (#219).
        detail: `${WORKER_MANIFEST_FILE} in ${workerDir} did not parse, and Pithy will not rewrite a manifest it could not read back`,
      }),
    notARecord: ({ found }) =>
      new ConflictError({
        message: `Cannot update ${path}: it holds ${found}, not a manifest object.`,
        action: "Restore it to a JSONC object, or move it aside, and run the command again.",
        detail: `${WORKER_MANIFEST_FILE} in ${workerDir} parsed to ${found}`,
      }),
    invalid: ({ at }) =>
      new ConflictError({
        message: `Cannot update ${path}: it is not the manifest Pithy keeps there.`,
        action: "Fix it, or move it aside, and run the command again.",
        // The key path, so the block can be found. Never what was on it.
        detail: `${WORKER_MANIFEST_FILE} in ${workerDir} failed its schema at ${at}`,
      }),
  });
  return base.document;
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
