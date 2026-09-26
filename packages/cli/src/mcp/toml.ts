// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { DOCS_MCP_NAME, type McpClient } from "./clients";
import {
  type DocumentWriter,
  type MergeResult,
  type ReadResult,
  type Refused,
  type RemoveResult,
  urlKeyOf,
} from "./document";

/**
 * The TOML syntax's answer to {@link DocumentWriter}, for the one row that speaks it: Codex CLI.
 *
 * **There is no TOML parser here and there must not be one.** Not because adding a dependency to a
 * published package is unwelcome — though it is — but because a parser is the wrong tool for this job.
 * Reading a document into a tree and writing it back out again reformats every line it did not change:
 * comments go, key order becomes the serializer's order, an array that was written across four lines
 * comes back on one. The acceptance criterion for this whole command is that the adopter's other
 * servers come out byte-identical, and a round trip cannot promise that. Splicing one table block in
 * and out of a line array can, by construction — every byte outside the span is copied, not rewritten.
 *
 * **What the splice costs is that structure has to be recognized rather than parsed, so anything
 * ambiguous is refused.** A table header is a line that matches the header shape *in full* and whose
 * contents parse as a dotted key; requiring the whole line is what keeps `[1, 2]` inside a multi-line
 * array from being read as a header, and requiring a legible key is what catches the rest. Where that
 * is not enough the document is refused outright: a multi-line string can contain anything at all,
 * including a line that looks exactly like a header, so a file holding one is a file this reader cannot
 * scan. The root key written as an inline assignment, an array-of-tables, a second copy of our own
 * table, a quoted spelling of a key we compare literally — each is a document where a block splice
 * would produce valid-looking TOML that means something else. The caller writes nothing and prints the
 * snippet instead, which is a worse afternoon for the operator and no damage to their file.
 *
 * **Values are rendered by type, and an unrendered type throws.** The Codex row carries a URL and
 * nothing else today, so booleans, integers and string arrays are dead code — deliberately. The
 * alternative to writing them now is a renderer that quietly stringifies whatever it is handed the day
 * a column is added, which writes a syntactically valid file that Codex reads as something other than
 * what the registry says. Throwing instead means the suite is where that is discovered.
 */

/** A single segment of a dotted key, and whether the document wrote it bare or quoted. */
interface KeySegment {
  /** The key it names, with any quotes removed. */
  readonly value: string;
  /** True when the document wrote it as a bare key — the only spelling this writer compares against. */
  readonly bare: boolean;
}

/** What one line of the document is, structurally. `unreadable` is a refusal waiting to be raised. */
type LineKind =
  | { readonly kind: "table"; readonly segments: readonly KeySegment[] }
  | { readonly kind: "arrayTable"; readonly segments: readonly KeySegment[] }
  | { readonly kind: "assignment"; readonly segments: readonly KeySegment[] }
  | { readonly kind: "other" }
  | { readonly kind: "unreadable" };

/** `[[a.b]]`, anchored at both ends so only a line that is nothing else can be one. */
const ARRAY_TABLE_LINE = /^\s*\[\[\s*(.+?)\s*\]\]\s*(?:#.*)?$/;

/** `[a.b]`, anchored the same way. Tried after the array form, which it would otherwise swallow. */
const TABLE_LINE = /^\s*\[\s*(.+?)\s*\]\s*(?:#.*)?$/;

/** A dotted key followed by `=`. The capture is the key; everything past the match is the value. */
const ASSIGNMENT_LINE = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/;

/** The characters a bare key may hold — TOML's own set, and the only keys this writer will write. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** The head of a bare key, for consuming one segment at a time. */
const BARE_KEY_HEAD = /^[A-Za-z0-9_-]+/;

/** A refusal, in the shape the seam returns it. */
function refuse(reason: string): Refused {
  return { state: "refused", reason };
}

/**
 * A dotted key split into its segments, or `null` when the text is not one.
 *
 * An escape inside a quoted segment makes the written text something other than the key it names, and
 * this reader does not decode escapes into keys — so it declines rather than guessing, and the caller
 * turns that into a refusal. Guessing here would mean comparing the wrong string against `mcp_servers`.
 */
function parseDottedKey(raw: string): KeySegment[] | null {
  const segments: KeySegment[] = [];
  let rest = raw.trim();
  while (rest.length > 0) {
    const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : null;
    if (quote !== null) {
      const end = rest.indexOf(quote, 1);
      if (end < 0) return null;
      const body = rest.slice(1, end);
      if (quote === '"' && body.includes("\\")) return null;
      segments.push({ value: body, bare: false });
      rest = rest.slice(end + 1).trimStart();
    } else {
      const head = BARE_KEY_HEAD.exec(rest);
      if (head === null) return null;
      segments.push({ value: head[0], bare: true });
      rest = rest.slice(head[0].length).trimStart();
    }
    if (rest.length === 0) return segments;
    if (!rest.startsWith(".")) return null;
    rest = rest.slice(1).trimStart();
  }
  return null;
}

/** The plain key names a segment list spells. */
function names(segments: readonly KeySegment[]): string[] {
  return segments.map((segment) => segment.value);
}

/** One line, classified. A stray carriage return is stripped so a CRLF file reads like any other. */
function classify(line: string): LineKind {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const arrayTable = ARRAY_TABLE_LINE.exec(text);
  if (arrayTable !== null) {
    const segments = parseDottedKey(arrayTable[1] as string);
    return segments === null ? { kind: "unreadable" } : { kind: "arrayTable", segments };
  }
  const table = TABLE_LINE.exec(text);
  if (table !== null) {
    const segments = parseDottedKey(table[1] as string);
    return segments === null ? { kind: "unreadable" } : { kind: "table", segments };
  }
  const assignment = ASSIGNMENT_LINE.exec(text);
  if (assignment !== null) {
    const segments = parseDottedKey(assignment[1] as string);
    if (segments !== null) return { kind: "assignment", segments };
  }
  return { kind: "other" };
}

/** What a scan learned about a document it is willing to edit. */
interface Scan {
  /** The document, split on newlines. Rejoining these reproduces it exactly. */
  readonly lines: readonly string[];
  /** Every table header's line index, in order — the boundaries a span may end at. */
  readonly headers: readonly number[];
  /** The line index of `[<rootKey>.pithy]`, or `null` when the document does not declare it. */
  readonly target: number | null;
}

/**
 * Read the document's structure, or say why it cannot be read.
 *
 * Every refusal this writer can raise is raised here, once, so `merge`, `remove` and `read` agree on
 * which documents are off limits — a reader that accepted a file the writer would refuse would report a
 * state the operator cannot act on.
 */
function scan(document: string, client: McpClient): Scan | Refused {
  if (document.includes('"""') || document.includes("'''")) {
    return refuse("This file holds a multi-line string, and its contents could hide anything Pithy scans for.");
  }
  const lines = document.split("\n");
  const headers: number[] = [];
  let target: number | null = null;
  let table: readonly KeySegment[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = classify(lines[index] as string);
    if (line.kind === "unreadable") {
      return refuse("This file has a bracketed line Pithy could not read as a table header.");
    }
    if (line.kind === "other") continue;
    if (line.kind === "assignment") {
      const key = names(line.segments);
      if (table === null && key[0] === client.rootKey) {
        return refuse(`This file assigns \`${client.rootKey}\` directly, so there is no table to merge into.`);
      }
      if (table !== null && table.length === 1 && names(table)[0] === client.rootKey && key[0] === DOCS_MCP_NAME) {
        return refuse(`This file declares \`${DOCS_MCP_NAME}\` as a key rather than as its own table.`);
      }
      continue;
    }
    const key = names(line.segments);
    if (line.kind === "arrayTable") {
      if (key[0] === client.rootKey) {
        return refuse(`This file declares \`${client.rootKey}\` as an array of tables, which cannot hold it.`);
      }
      headers.push(index);
      table = line.segments;
      continue;
    }
    if (key[0] === client.rootKey && !line.segments.every((segment) => segment.bare)) {
      return refuse(`This file spells the \`${client.rootKey}\` table with quoted keys Pithy does not match.`);
    }
    if (key.length === 2 && key[0] === client.rootKey && key[1] === DOCS_MCP_NAME) {
      if (target !== null) return refuse(`This file declares the \`${DOCS_MCP_NAME}\` table more than once.`);
      target = index;
    }
    headers.push(index);
    table = line.segments;
  }
  return { lines, headers, target };
}

/** A scan result that is a refusal, narrowed. */
function refused(result: Scan | Refused): result is Refused {
  return "state" in result;
}

/** Where the table starting at `start` ends: the next header, or the end of the document. */
function spanEnd(found: Scan, start: number): number {
  return found.headers.find((index) => index > start) ?? found.lines.length;
}

/** An unrenderable entry, named so the suite says which key and which shape. */
function unrenderable(key: string, shape: string): InternalError {
  return new InternalError({
    message: "Pithy cannot write this MCP entry as TOML.",
    action: "Render the value in `mcp/toml.ts`, or state it in the registry in a shape the writer covers.",
    detail: `mcp/toml.ts: the \`${key}\` entry field is ${shape}.`,
  });
}

/** A TOML basic string. Control characters are refused rather than written raw or dropped. */
function renderString(key: string, value: string): string {
  let out = '"';
  for (const character of value) {
    if (character === "\\") out += "\\\\";
    else if (character === '"') out += '\\"';
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (character < " " || character === "\u007f") throw unrenderable(key, "a string holding a control character");
    else out += character;
  }
  return `${out}"`;
}

/** One entry value, by type. Anything else throws — see the module docblock for why. */
function renderValue(key: string, value: unknown): string {
  if (typeof value === "string") return renderString(key, value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw unrenderable(key, "a number that is not a safe integer");
    return String(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = value.map((item: unknown) => {
      if (typeof item !== "string") throw unrenderable(key, "an array holding something other than strings");
      return renderString(key, item);
    });
    return `[${items.join(", ")}]`;
  }
  throw unrenderable(key, "neither a string, a boolean, an integer nor an array of strings");
}

/** The block a merge splices in: the header, then one line per entry field, in the registry's order. */
function renderBlock(client: McpClient): string[] {
  const body = Object.entries(client.entry).map(([key, value]) => {
    if (!BARE_KEY.test(key)) throw unrenderable(key, "a field name that is not a bare TOML key");
    return `${key} = ${renderValue(key, value)}`;
  });
  return [`[${client.rootKey}.${DOCS_MCP_NAME}]`, ...body];
}

/** Lines to a document: one trailing newline, always, and nothing at all for an empty one. */
function finish(lines: readonly string[]): string {
  const text = lines.join("\n");
  return text.trim().length === 0 ? "" : `${text.replace(/\n+$/, "")}\n`;
}

/** A copy with trailing blank lines dropped — the separator is re-added by whoever splices. */
function withoutTrailingBlanks(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] as string).trim().length === 0) out.pop();
  return out;
}

/** A copy with leading blank lines dropped. */
function withoutLeadingBlanks(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[0] as string).trim().length === 0) out.shift();
  return out;
}

/** The string an assignment line assigns, or `null` when it is not a string this reader decodes. */
function readStringValue(line: string): string | null {
  const assignment = ASSIGNMENT_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (assignment === null) return null;
  const raw = line.slice(assignment[0].length).trim();
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end < 0 ? null : raw.slice(1, end);
  }
  if (!raw.startsWith('"')) return null;
  let value = "";
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index] as string;
    if (character === '"') return value;
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === "n") value += "\n";
    else if (escaped === "r") value += "\r";
    else if (escaped === "t") value += "\t";
    else if (escaped === '"' || escaped === "\\") value += escaped;
    else return null;
    index += 1;
  }
  return null;
}

/** The lines of our table, blank ones dropped, ready to compare against a freshly rendered block. */
function spanBody(found: Scan, start: number): string[] {
  return found.lines
    .slice(start, spanEnd(found, start))
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line).trim())
    .filter((line) => line.length > 0);
}

export const tomlWriter: DocumentWriter = {
  merge(document: string | null, client: McpClient, preamble?: string | null): MergeResult {
    const block = renderBlock(client);
    if (document === null) {
      return { state: "merged", outcome: "added", document: `${preamble ?? ""}${finish(block)}` };
    }
    const found = scan(document, client);
    if (refused(found)) return found;
    let spliced: string[];
    if (found.target === null) {
      // Appended as a table header of its own, so the keys under it cannot be read as somebody else's.
      const body = withoutTrailingBlanks(found.lines);
      spliced = body.length === 0 ? block : [...body, "", ...block];
    } else {
      const tail = found.lines.slice(spanEnd(found, found.target));
      spliced = [...found.lines.slice(0, found.target), ...block, ...(tail.length === 0 ? [] : ["", ...tail])];
    }
    const merged = finish(spliced);
    if (merged === document) return { state: "merged", outcome: "unchanged", document };
    return { state: "merged", outcome: found.target === null ? "added" : "updated", document: merged };
  },

  remove(document: string, client: McpClient): RemoveResult {
    const found = scan(document, client);
    if (refused(found)) return found;
    if (found.target === null) return { state: "merged", outcome: "absent", document };
    const head = withoutTrailingBlanks(found.lines.slice(0, found.target));
    const tail = withoutLeadingBlanks(found.lines.slice(spanEnd(found, found.target)));
    const joined = head.length === 0 || tail.length === 0 ? [...head, ...tail] : [...head, "", ...tail];
    return { state: "merged", outcome: "removed", document: finish(joined) };
  },

  read(document: string, client: McpClient): ReadResult {
    const found = scan(document, client);
    if (refused(found)) return found;
    if (found.target === null) return { state: "read", entry: null };
    const body = spanBody(found, found.target);
    const urlKey = urlKeyOf(client);
    let url: string | null = null;
    for (const line of body) {
      const parsed = classify(line);
      if (parsed.kind !== "assignment") continue;
      const key = names(parsed.segments);
      if (urlKey === null || key.length !== 1 || key[0] !== urlKey) continue;
      url = readStringValue(line);
    }
    const block = renderBlock(client);
    const current = body.length === block.length && body.every((line, index) => line === block[index]);
    return { state: "read", entry: { url, current } };
  },

  snippet(client: McpClient): string {
    return finish(renderBlock(client));
  },
};
