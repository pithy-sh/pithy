// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { ConflictError, InternalError, type PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
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

/**
 * The second half of the same sentence, for the reader that parses what it read.
 *
 * {@link readOptionalFile} closes *"the file would not open"*. It cannot close *"the file opened and is
 * not a document"*, because that read genuinely succeeded — the loss happens one step later, when a
 * writer merges into a value it decided was empty and renames the result over everything the process
 * never saw. Three readers reached that decision independently: `pithy.worker.jsonc` (#204),
 * `tokens.json` and `dev.json` (#209, both credential files holding other tenants' keys). Three is this
 * repository's count for a rule living at call sites instead of at the thing being called, so it lives
 * here, beside the other decision no reader may make for itself.
 *
 * **Absent is `{}` and is the caller's answer to make. Present-but-not-a-record is this one's refusal.**
 * A reader that has nothing to destroy may still choose `{}` for a file that will not *parse*; what no
 * reader may choose is that a value which parsed to a string is a document to write from.
 *
 * All three producers ask this one, `ui/workerUi.ts` included — the tag check was written there for
 * #204, and moving it here rather than copying it is the difference between a rule and a convention.
 * Each keeps its own sentence through `options.notARecord`, exactly as each keeps its own refusal for a
 * file that would not open.
 */
export function requireRecord(
  path: string,
  value: unknown,
  options: RequireRecordOptions = {},
): Record<string, unknown> {
  const shape = shapeOf(value);
  if (shape === "object") return value as Record<string, unknown>;
  const failure = { path, found: asWords(shape) };
  throw options.notARecord?.(failure) ?? defaultShapeRefusal(failure);
}

/** What a call site is told about a value that parsed and is not a record. Never the value itself. */
export interface NotARecord {
  /** The file the value came out of, exactly as it was asked for. */
  readonly path: string;
  /** The shape as a sentence names it — `null`, `an array`, `a string`. Never a byte of the file. */
  readonly found: string;
}

/** How {@link requireRecord} refuses. */
export interface RequireRecordOptions {
  /**
   * The refusal this file deserves, in this command's words — a `tokens.json` and a `pithy.worker.jsonc`
   * name different things and want different error classes. Returning anything but a `PithyError` is not
   * possible, so a caller cannot quietly turn the refusal back into an empty document here.
   */
  readonly notARecord?: (failure: NotARecord) => PithyError;
}

/**
 * The value's shape, by its own tag rather than by `typeof`, which answers this wrong twice.
 *
 * `null` is a `"object"` — so a `null` check reads as the whole rule and is half of it. And
 * **comment-json boxes a top-level primitive** so it has somewhere to hang the file's comments:
 * `parse('"react"')` is a `String` object, not `null`, and `typeof` calls it an `"object"` too. Only a
 * `String` *object* would survive both checks, which is why this asks the tag.
 */
function shapeOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

/** The shape as the sentence names it: `null`, `an array`, `a string`. */
function asWords(shape: string): string {
  if (shape === "null" || shape === "undefined") return shape;
  return /^[aeiou]/.test(shape) ? `an ${shape}` : `a ${shape}`;
}

/** The refusal a caller that named no words of its own gets: the path and the shape, never the value. */
function defaultShapeRefusal({ path, found }: NotARecord): PithyError {
  return new ConflictError({
    message: `Cannot update ${path}: it holds ${found}, not a document.`,
    action: "Restore it to a JSON object, or move it aside, and run the command again.",
    detail: `${path} parsed to ${found}`,
  });
}

/**
 * The whole sentence, for the read whose answer is about to be written back over the file it came from.
 *
 * **Absent is the only state that licenses starting from empty.** Unopenable, unparseable,
 * parsed-but-not-a-record and parsed-but-not-this-document are each a refusal here, whatever any of them
 * may be for a reader that only reports. This family has five known instances — `readManifestDocument`
 * (#204), `readMintedTokens` and `readDevJson` (#209), and the two #209 could not close without this
 * split (#219) — and every one of them was a *writer* merging into a `{}` that a read had invented from
 * something it could not make sense of. `tokens.json` is keyed by environment and `dev.json` has other
 * tenants, so what the merge replaced was other people's live credentials and preferences, with the run
 * reporting a clean write.
 *
 * **The reason the split is a type and not a rule.** `readMintedTokens` was both the reporting read and
 * the writer's read, and the argument for its leniency — a reader has nothing to destroy, a half-typed
 * preferences file must not stop `pithy dev` — is *sound for the reader*. Tightening it would have cost
 * that, and leaving a lenient sibling beside a strict one is how all five happened: the call site picked
 * the wrong one and nothing said so. So the strict read hands back a {@link MergeBase} rather than a
 * document, every writer takes one, and the lenient `{}` is a compile error at the merge instead of a
 * lost file at the rename. A reader may still answer `{}`; it simply cannot answer a merge base.
 *
 * It lives here rather than at the sixth call site for the same reason {@link requireRecord} does: no
 * reader decides for itself what its own failure means. Each keeps its own sentence through the options.
 */
export interface MergeBase<Document> {
  /**
   * The file the document came from, and the file a writer may write back to.
   *
   * Carried rather than re-derived so the base and its destination cannot come apart — a document read
   * from one path and renamed over another is the same loss by a different route.
   */
  readonly path: string;
  /** What is in it: the empty document when there was no file, and otherwise exactly what passed. */
  readonly document: Document;
}

/** What a call site is told about a file that opened and is not JSON. Never a byte of it — see below. */
export interface UnparseableFile {
  /** The file that would not parse, exactly as it was asked for. */
  readonly path: string;
}

/** What a call site is told about a document that parsed and is not the one this file holds. */
export interface InvalidDocument {
  /** The file. */
  readonly path: string;
  /** Where it broke, as dotted key paths — `dev.CF_TOKEN`. The keys, never the values behind them. */
  readonly at: string;
}

/** How {@link readMergeBase} refuses, in four places rather than one. */
export interface MergeBaseOptions extends ReadOptionalFileOptions, RequireRecordOptions {
  /** The refusal for a file that opened and is not JSON. */
  readonly unparseable?: (failure: UnparseableFile) => PithyError;
  /** The refusal for a document that parsed, is a record, and is not what this file holds. */
  readonly invalid?: (failure: InvalidDocument) => PithyError;
}

/**
 * The document at `path` and the file it came from, known-good — or a refusal, in every state but one.
 *
 * `{}` comes back for an absent file and for nothing else. The schema is what "known-good" means, so a
 * `tokens.json` whose value is a number and a `dev.json` whose binding is a number are refusals rather
 * than empty bases, and the caller that merges into the result never has to ask what it was handed.
 */
export async function readMergeBase<Schema extends z.ZodType<Record<string, unknown>>>(
  path: string,
  schema: Schema,
  options: MergeBaseOptions = {},
): Promise<MergeBase<z.output<Schema>>> {
  const source = await readOptionalFile(path, options);
  if (source === null) return { path, document: emptyDocument(path, schema) };
  const document = requireRecord(path, parseJson(path, source, options), options);
  const parsed = schema.safeParse(document);
  if (parsed.success) return { path, document: parsed.data };
  const failure = { path, at: whereItBroke(parsed.error) };
  throw options.invalid?.(failure) ?? defaultInvalidRefusal(failure);
}

/**
 * `JSON.parse`, refusing rather than answering `undefined` — and **dropping node's own error**.
 *
 * The one place in this module a cause is deliberately not carried. `JSON.parse` puts the offending text
 * in its message — `Unexpected token 'n', "{ not json" is not valid JSON` — and every file this was
 * written for is credentials. The path and "it is not JSON" is the whole of what an operator needs; the
 * quoted line is the leak the refusal existed to avoid.
 */
function parseJson(path: string, source: string, options: MergeBaseOptions): unknown {
  try {
    return JSON.parse(source);
  } catch {
    const failure = { path };
    throw options.unparseable?.(failure) ?? defaultParseRefusal(failure);
  }
}

/** What an absent file starts from: the schema's own reading of `{}`, so the empty state is its too. */
function emptyDocument<Schema extends z.ZodType<Record<string, unknown>>>(
  path: string,
  schema: Schema,
): z.output<Schema> {
  const empty = schema.safeParse({});
  if (empty.success) return empty.data;
  throw new InternalError({
    message: `Cannot start ${path} from an empty document.`,
    action: "This is a defect in Pithy. Report it with the command you ran.",
    detail: `the schema for ${path} refuses {}, so an absent file has no base to merge into`,
  });
}

/** Where a document broke, by key path and never by value: `dev.CF_TOKEN, staging`. */
function whereItBroke(error: z.ZodError): string {
  const paths = new Set(error.issues.map((issue) => issue.path.join(".") || "the top level"));
  return [...paths].slice(0, 5).join(", ");
}

/** The refusal a caller that named no words of its own gets for a file that is not JSON. */
function defaultParseRefusal({ path }: UnparseableFile): PithyError {
  return new ConflictError({
    message: `Cannot update ${path}: it is there and is not JSON.`,
    action: "Fix the file, or move it aside, and run the command again.",
    detail: `${path} did not parse, and Pithy will not rewrite a file it could not read back`,
  });
}

/** The refusal a caller that named no words of its own gets for a document that failed its schema. */
function defaultInvalidRefusal({ path, at }: InvalidDocument): PithyError {
  return new ConflictError({
    message: `Cannot update ${path}: it is not the document Pithy keeps there.`,
    action: "Fix it, or move it aside, and run the command again.",
    detail: `${path} failed its schema at ${at}`,
  });
}
