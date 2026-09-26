// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { McpClient } from "./clients";

/**
 * The one seam the four config syntaxes meet at.
 *
 * **Every writer performs the same operation: set exactly one named entry under one known key, and leave
 * the rest of the file alone.** That is the whole job, in JSON, JSONC, TOML and YAML, and stating it once
 * as a seam is what keeps `connect.ts` from growing a branch per format. A writer is chosen from the
 * registry row's `format` and then nothing downstream knows which syntax it is talking to.
 *
 * **Refusal is a first-class answer, not an exception.** These are files Pithy does not own, written by
 * hand, holding an adopter's other servers and sometimes an editor's entire state. A document a writer
 * cannot read with confidence is one it must not rewrite — a "best effort" write here means a corrupted
 * `~/.claude.json` or a Goose config that no longer parses, and the adopter finds out when their tool
 * stops working rather than when Pithy ran. So `refused` carries the reason, the command names the file
 * and prints the snippet to paste, and the bytes on disk are untouched. The issue calls this refusing on
 * doubt; the type makes it unavoidable, because a caller cannot get at a document without answering the
 * refusal case.
 *
 * **`unchanged` is distinct from `updated`, and both are distinct from `added`.** Idempotency is the
 * property the issue asks for and it is only observable if the writer says which happened: a second run
 * must produce identical bytes and report `unchanged`, an entry pointing somewhere else must be corrected
 * and report `updated`, and a fresh one reports `added`. A writer that collapsed the three into "wrote
 * it" would satisfy the tests and tell the operator nothing.
 */

/**
 * The keys an MCP entry can carry its address in, across the whole registry.
 *
 * Three spellings for one thing, because three vendors chose differently: `url` is the common case,
 * Gemini's `httpUrl` selects streamable HTTP where a bare `url` would select SSE, and Goose simply calls
 * it `uri`. A reader asks the registry row which one this client uses rather than guessing, which is why
 * the list is here and not inside a writer — all four writers answer the same question with it.
 */
export const URL_KEYS: readonly string[] = ["url", "httpUrl", "uri"];

/**
 * The key this client's entry states its address in, or `null` when there is none to read.
 *
 * `null` is Claude Desktop: a bridged entry's address is an argument to `npx`, not a field, so there is
 * no key to compare and `status` reports the entry without a URL rather than inventing one.
 */
export function urlKeyOf(client: McpClient): string | null {
  return URL_KEYS.find((key) => key in client.entry) ?? null;
}

/** What a merge did. Three answers, because a re-run and a correction are different events. */
export type MergeOutcome =
  /** There was no `pithy` entry, and now there is. */
  | "added"
  /** There was one, pointing somewhere other than here, and it now points here. */
  | "updated"
  /** There was one, already correct. No bytes changed. */
  | "unchanged";

/** What a removal did. */
export type RemoveOutcome =
  /** There was a `pithy` entry and it is gone. Everything else in the file is intact. */
  | "removed"
  /** There was nothing to remove. Not an error — the end state is the one that was asked for. */
  | "absent";

/** A document Pithy will not rewrite, and the sentence that says why. */
export interface Refused {
  readonly state: "refused";
  /**
   * One line, in the operator's terms — what about the file could not be read. It reaches the terminal,
   * so it never quotes the file's contents: these documents sit next to credentials in more than one
   * tool, and a parser's own message tends to echo the offending line.
   */
  readonly reason: string;
}

/** A merge that produced bytes. */
export interface Merged {
  readonly state: "merged";
  /** Which of the three things happened. */
  readonly outcome: MergeOutcome;
  /** The whole file, as it should now be written. Byte-identical to the input when `unchanged`. */
  readonly document: string;
}

/** A removal that produced bytes. */
export interface Removed {
  readonly state: "merged";
  /** Whether anything was there to remove. */
  readonly outcome: RemoveOutcome;
  /** The whole file, as it should now be written. Byte-identical to the input when `absent`. */
  readonly document: string;
}

/** The result of merging the entry in. */
export type MergeResult = Merged | Refused;

/** The result of taking the entry out. */
export type RemoveResult = Removed | Refused;

/** What a document says about `pithy` today. `null` when it says nothing. */
export interface EntryReading {
  /** The URL the entry points at, or `null` for a bridged entry, whose address is an argument. */
  readonly url: string | null;
  /** True when the entry matches what this version of Pithy would write. */
  readonly current: boolean;
}

/** The result of reading the entry out — for `pithy docs status`, which writes nothing. */
export type ReadResult = { readonly state: "read"; readonly entry: EntryReading | null } | Refused;

/**
 * One syntax's answer to the three operations, plus the snippet that needs no file at all.
 *
 * `merge` takes `null` for a document that is not there yet, and every writer's answer to that case must
 * equal its own `snippet` (with the preamble, where a row declares one) — the corpus tests assert it, so
 * `--print` cannot drift from what a write would actually produce.
 */
export interface DocumentWriter {
  /** Set the entry. `document` is `null` when the file does not exist. */
  merge(document: string | null, client: McpClient, preamble?: string | null): MergeResult;
  /** Take the entry out, touching nothing else. */
  remove(document: string, client: McpClient): RemoveResult;
  /** Read what the document says about `pithy`, changing nothing. */
  read(document: string, client: McpClient): ReadResult;
  /** The smallest document that declares the entry — what `--print` emits. */
  snippet(client: McpClient): string;
}
