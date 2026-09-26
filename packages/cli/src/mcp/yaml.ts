// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DOCS_MCP_NAME, type McpClient } from "./clients";
import type { DocumentWriter, MergeResult, ReadResult, RemoveResult } from "./document";
import { urlKeyOf } from "./document";

/**
 * The YAML writer: Goose's `extensions` map and Continue's `mcpServers` sequence.
 *
 * **It edits lines, and it does not parse.** There is no YAML parser in this monorepo and this module
 * does not add one — not to keep the dependency list short, though it does, but because a parser is the
 * wrong tool for the job. Every YAML round trip is a reflow: quoting style is normalized, comments are
 * dropped or moved, block scalars are re-folded, and key order survives only by luck. The one thing
 * `pithy docs connect` owes an adopter is that their other servers come out byte-identical, and splicing
 * a span of lines gives that by construction while a load-and-dump gives the opposite. The Goose fixture
 * makes the point on its own: `GOOSE_PROVIDER` sits above the block and the `developer` extension inside
 * it, and neither is ours to re-render.
 *
 * **The price is paid in refusals, and it is the right price.** A line editor can only act on a shape it
 * can name, so anything else — flow style, tabs, anchors, a second document, a line the container cannot
 * hold — is refused with a sentence, and the command prints the snippet for the operator to paste. That
 * is the trade the issue asks for: a file Pithy cannot read with confidence is a file Pithy does not
 * write. A "best effort" splice into a document with a merge key in it does not fail loudly; it changes
 * what a key resolves to somewhere else in the file, and the adopter finds out when Goose stops starting.
 *
 * **Anchors and aliases get their own refusal because their meaning is not local.** Every other rule here
 * is about a line the editor cannot classify. `&base`, `*base` and `<<:` are lines it can classify
 * perfectly well and still must not touch, because the block it would splice into is also the definition
 * site for something read elsewhere. Reading the block tells you nothing about what removing part of it
 * does.
 *
 * **The two containers are one code path with two shapes.** Goose keys its extensions by name; Continue
 * carries the name inside each sequence item. That is the only difference between them, so the block is
 * located, validated and spliced identically and the container decides just two things: what a child line
 * looks like, and how the entry is recognized.
 */

/** The indentation a block gets when the file does not already demonstrate one. Two spaces, as YAML is written. */
const DEFAULT_INDENT = "  ";

/** The width a sequence item's dash and space take, and therefore where its own keys start. */
const ITEM_MARKER = "- ";

/**
 * The field a sequence item states its own name in.
 *
 * `clients.test.ts` holds every `list` row to carrying `name` in its entry, so this is the registry's
 * rule rather than a guess about Continue — which is why it is a constant here and not a literal inline.
 */
const NAME_FIELD = "name";

/** A line with nothing on it but whitespace. Blank lines belong to whatever span surrounds them. */
function blank(line: string): boolean {
  return line.trim().length === 0;
}

/** The leading whitespace of a line, verbatim — tabs included, so the tab check can see them. */
/**
 * A line that is nothing but a comment.
 *
 * Transparent to every scan below it: a comment belongs to whatever follows it, carries no indentation
 * of its own that means anything, and must not close a block, break a span, or fail the indentation
 * check. A `#` inside a scalar is a different thing and is not this.
 */
function commentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** The document as lines, with the newline it already uses, so a CRLF file stays a CRLF file. */
function splitLines(document: string): { lines: string[]; newline: string } {
  const newline = document.includes("\r\n") ? "\r\n" : "\n";
  const body = document.endsWith(newline) ? document.slice(0, -newline.length) : document;
  return { lines: body.length === 0 ? [] : body.split(/\r?\n/), newline };
}

/** Lines back to a document, ending in exactly one newline. An empty result stays empty. */
function joinLines(lines: readonly string[], newline: string): string {
  let end = lines.length;
  while (end > 0 && blank(lines[end - 1] as string)) end -= 1;
  return end === 0 ? "" : lines.slice(0, end).join(newline) + newline;
}

/** A key and what follows it on the line, or `null` when the line is not a `key:` at all. */
function parseEntry(text: string): { key: string; value: string } | null {
  // A sequence item is not a key, and `- name` would otherwise parse as one called `- name`.
  if (/^-([ \t]|$)/.test(text)) return null;
  const double = /^"((?:[^"\\]|\\.)*)"[ \t]*:([ \t]|$)/.exec(text);
  if (double !== null) return { key: unquote(`"${double[1]}"`), value: after(text, double[0]) };
  const single = /^'((?:[^']|'')*)'[ \t]*:([ \t]|$)/.exec(text);
  if (single !== null) return { key: unquote(`'${single[1]}'`), value: after(text, single[0]) };
  const plain = /^([^\s#"'][^:]*?)[ \t]*:([ \t]|$)/.exec(text);
  return plain === null ? null : { key: plain[1] as string, value: after(text, plain[0]) };
}

/** What a line says after its key, with a trailing comment dropped and the quotes taken off. */
function after(text: string, matched: string): string {
  return unquote(stripComment(text.slice(matched.length).trim()));
}

/** A value without the comment that may follow it. Quote-aware, so a `#` inside a string stays. */
function stripComment(value: string): string {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(value);
  if (quoted !== null) return quoted[1] as string;
  const hash = value.search(/(^|[ \t])#/);
  return hash === -1 ? value : value.slice(0, hash).trim();
}

/** A scalar with its quotes removed, if it had any. */
function unquote(value: string): string {
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Whether a plain scalar would read back as something other than this string.
 *
 * Deliberately wider than YAML's own rule. A URL carries a colon, which is only special before a space,
 * so an unquoted address is legal — and it is still quoted here, because that is how every one of these
 * vendors writes it in their own documentation, and a file an adopter opens should look like the
 * examples they learned from. Erring toward a quote costs two characters; erring away from one turns
 * `no` into `false` and an address into a mapping.
 */
function needsQuotes(value: string): boolean {
  if (value.length === 0) return true;
  if (value.trim() !== value) return true;
  if (/^(~|null|true|false|yes|no|on|off)$/i.test(value)) return true;
  if (/^[-+]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][-+]?\d+)?$/.test(value)) return true;
  if (/^0[xob]/i.test(value)) return true;
  if (/[:#,[\]{}&*!|>'"%@`]/.test(value)) return true;
  return /^[-?]/.test(value);
}

/** A double-quoted scalar, escaped the way YAML reads escapes. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** One value on one line. Anything that is not a scalar falls back to flow style, which YAML also reads. */
function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return needsQuotes(value) ? quote(value) : value;
  return JSON.stringify(value) ?? "null";
}

/** True for a plain object — a nested mapping rather than a scalar or a sequence. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One field of an entry, as the lines it occupies. Sequences and nested mappings render as blocks. */
function renderField(key: string, value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${key}: []`];
    return [`${indent}${key}:`, ...value.map((item) => `${indent}${DEFAULT_INDENT}- ${renderScalar(item)}`)];
  }
  if (isRecord(value)) {
    const fields = Object.entries(value);
    if (fields.length === 0) return [`${indent}${key}: {}`];
    return [
      `${indent}${key}:`,
      ...fields.flatMap(([name, nested]) => renderField(name, nested, indent + DEFAULT_INDENT)),
    ];
  }
  return [`${indent}${key}: ${renderScalar(value)}`];
}

/** The entry, as the lines it occupies under a block indented by `indent`. */
function renderEntry(client: McpClient, indent: string): string[] {
  const fields = Object.entries(client.entry);
  if (client.container === "map") {
    const step = indent.length > 0 ? indent : DEFAULT_INDENT;
    return [`${indent}${DOCS_MCP_NAME}:`, ...fields.flatMap(([key, value]) => renderField(key, value, indent + step))];
  }
  const content = indent + " ".repeat(ITEM_MARKER.length);
  const lines = fields.flatMap(([key, value]) => renderField(key, value, content));
  const first = lines[0] as string;
  return [`${indent}${ITEM_MARKER}${first.slice(content.length)}`, ...lines.slice(1)];
}

/** The block under the root key, once it has been read and found readable. */
interface Block {
  /** The line the root key is declared on. */
  readonly key: number;
  /** The first line under it. */
  readonly start: number;
  /** One past the last line under it, with trailing blank lines left outside. */
  readonly end: number;
  /** The indentation its children sit at, taken from the file rather than assumed. */
  readonly indent: string;
}

/** What reading the root key found: a block, no key at all, or a reason not to touch the file. */
type Analysis =
  | { readonly kind: "block"; readonly block: Block }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string };

function refused(reason: string): { kind: "refused"; reason: string } {
  return { kind: "refused", reason };
}

/**
 * Read the root key's block, or say why it cannot be read.
 *
 * The order of the checks is the order of the doubts, widest first: a second document makes every line
 * number below it meaningless, a duplicated key makes "the block" ambiguous, and only then is there a
 * single block whose contents are worth looking at.
 */
function analyze(lines: readonly string[], client: McpClient): Analysis {
  const key = client.rootKey;
  // A marker before any content opens the one document this file holds; `---` is how a great many
  // hand-written YAML files begin, and refusing those would turn a legal shape away with a reason that
  // is not true of it. A marker *after* content is the one that splits, and that is still refused: there
  // would be two documents and no answer to which one the entry belongs in.
  const opened = lines.findIndex((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
  for (const [index, line] of lines.entries()) {
    if (!/^(---|\.\.\.)([ \t]|$)/.test(line)) continue;
    if (index === opened) continue;
    return refused("The file is split by a document separator, so there is no one document to write into.");
  }

  const head = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*:(.*)$`);
  const declared = lines.flatMap((line, index) => (head.test(line) ? [index] : []));
  if (declared.length > 1) return refused(`The \`${key}\` key is declared more than once at the top level.`);
  if (declared.length === 0) return { kind: "absent" };

  const at = declared[0] as number;
  const trailing = (head.exec(lines[at] as string)?.[1] ?? "").trim();
  if (trailing.startsWith("{") || trailing.startsWith("[")) {
    return refused(`The \`${key}\` key is written in flow style rather than as an indented block.`);
  }
  if (trailing.length > 0 && !trailing.startsWith("#")) {
    return refused(`The \`${key}\` key carries a value on its own line rather than an indented block.`);
  }

  const start = at + 1;
  // **A comment at column zero does not end the block, and reading it as the end corrupts the file.**
  // A full-line comment is attached to whatever follows it, so an operator who writes one between two
  // extensions has not closed the mapping — but scanning only for *indented* lines stops there, the
  // entry below it is never found, and a second `pithy:` is inserted above it. That is a duplicate
  // mapping key: a document the tool refuses to load, written by a command that reported `added`.
  //
  // So comments and blanks are scanned through, and the block ends at the last line that genuinely
  // belongs to it — the last indented one. A comment trailing *after* the block stays outside it, which
  // is what keeps an appended entry from landing beneath somebody's closing note.
  let end = start;
  let lastIndented = start;
  while (end < lines.length) {
    const line = lines[end] as string;
    const isComment = line.trimStart().startsWith("#");
    if (!blank(line) && !isComment && !/^[ \t]/.test(line)) break;
    end += 1;
    if (!blank(line) && !(isComment && !/^[ \t]/.test(line))) lastIndented = end;
  }
  end = lastIndented;

  for (let index = start; index < end; index += 1) {
    const line = lines[index] as string;
    if (blank(line) || commentLine(line)) continue;
    if (indentOf(line).includes("\t")) {
      return refused(`The block under \`${key}\` is indented with tabs, which YAML does not allow.`);
    }
    if (/(^|[ \t])&\S/.test(line) || /(^|[ \t])\*\S/.test(line) || /(^|[ \t])<<[ \t]*:/.test(line)) {
      return refused(`The block under \`${key}\` uses an anchor, an alias or a merge key.`);
    }
  }

  const first = lines.slice(start, end).find((line) => !blank(line) && !commentLine(line));
  if (first === undefined) {
    if (start < lines.length && /^-([ \t]|$)/.test(lines[start] as string)) {
      return refused(`The sequence under \`${key}\` is written at the key's own indentation.`);
    }
    return { kind: "block", block: { key: at, start, end, indent: DEFAULT_INDENT } };
  }

  const indent = indentOf(first);
  for (let index = start; index < end; index += 1) {
    const line = lines[index] as string;
    if (blank(line) || commentLine(line)) continue;
    const here = indentOf(line);
    if (here.length < indent.length) return refused(`The block under \`${key}\` is indented inconsistently.`);
    if (here.length > indent.length) continue;
    const text = line.slice(indent.length);
    if (client.container === "list" && !/^-([ \t]|$)/.test(text)) {
      return refused(`The block under \`${key}\` holds a line that is not a sequence item.`);
    }
    if (client.container === "map" && parseEntry(text) === null) {
      return refused(`The block under \`${key}\` holds a line that does not declare a key.`);
    }
  }

  return { kind: "block", block: { key: at, start, end, indent } };
}

/** Where the entry sits, or that it does not, or a reason the question cannot be answered. */
type Located =
  | { readonly kind: "found"; readonly start: number; readonly end: number }
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly reason: string };

/** A span's end: the next line at or above the given indent, with trailing blank lines left outside. */
function spanEnd(lines: readonly string[], from: number, block: Block, indent: number): number {
  let end = from;
  while (end < block.end) {
    const line = lines[end] as string;
    if (!blank(line) && !commentLine(line) && indentOf(line).length <= indent && end > from) break;
    end += 1;
  }
  // Trailing blanks and comments belong to whatever comes next, not to the span being replaced.
  while (end > from + 1 && (blank(lines[end - 1] as string) || commentLine(lines[end - 1] as string))) end -= 1;
  return end;
}

/** Every sequence item in the block, as spans. */
function items(lines: readonly string[], block: Block): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  for (let index = block.start; index < block.end; index += 1) {
    const line = lines[index] as string;
    if (blank(line) || indentOf(line).length !== block.indent.length) continue;
    found.push({ start: index, end: spanEnd(lines, index, block, block.indent.length) });
  }
  return found;
}

/**
 * The top-level fields of one entry, keyed by name.
 *
 * A sequence item's first key shares its line with the dash, which is the whole reason this is one
 * function taking a container rather than two loops: everything after that first line is identical.
 */
function fieldsOf(
  lines: readonly string[],
  span: { start: number; end: number },
  block: Block,
  client: McpClient,
): Map<string, string> {
  const fields = new Map<string, string>();
  let content: string | null = null;
  for (let index = span.start; index < span.end; index += 1) {
    const line = lines[index] as string;
    if (blank(line)) continue;
    let text: string;
    if (index === span.start) {
      if (client.container === "map") continue;
      const rest = line.slice(block.indent.length);
      const marker = /^-[ \t]*/.exec(rest)?.[0] ?? "-";
      text = rest.slice(marker.length);
      if (text.trim().length === 0) continue;
      content ??= block.indent + marker;
    } else {
      const here = indentOf(line);
      content ??= here;
      if (here.length !== content.length) continue;
      text = line.slice(here.length);
    }
    const parsed = parseEntry(text);
    if (parsed !== null && !fields.has(parsed.key)) fields.set(parsed.key, parsed.value);
  }
  return fields;
}

/** Find the `pithy` entry in the block, refusing a block that declares it twice. */
function locate(lines: readonly string[], block: Block, client: McpClient): Located {
  const spans: Array<{ start: number; end: number }> = [];
  if (client.container === "map") {
    for (let index = block.start; index < block.end; index += 1) {
      const line = lines[index] as string;
      if (blank(line) || indentOf(line).length !== block.indent.length) continue;
      if (parseEntry(line.slice(block.indent.length))?.key !== DOCS_MCP_NAME) continue;
      spans.push({ start: index, end: spanEnd(lines, index, block, block.indent.length) });
    }
  } else {
    for (const item of items(lines, block)) {
      if (fieldsOf(lines, item, block, client).get(NAME_FIELD) === DOCS_MCP_NAME) spans.push(item);
    }
  }
  if (spans.length > 1) {
    return { kind: "refused", reason: `The block under \`${client.rootKey}\` declares \`pithy\` more than once.` };
  }
  const only = spans[0];
  return only === undefined ? { kind: "none" } : { kind: "found", start: only.start, end: only.end };
}

/** Two spans of lines, compared as bytes. What tells `unchanged` from `updated`. */
function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * The writer.
 *
 * Every operation reads the block first and answers `refused` from one place, so a shape the editor
 * cannot handle is refused identically whether the caller was connecting, disconnecting or only asking.
 */
export const yamlWriter: DocumentWriter = {
  merge(document: string | null, client: McpClient, preamble?: string | null): MergeResult {
    // A file that exists and holds nothing says nothing, so it is written as a file that was not there:
    // `touch`, a crashed editor or a tool that created its config and never filled it all leave one, and
    // taking it for a document would drop Continue's `name`/`version`/`schema` and produce a block file
    // its own schema rejects — reported as `added`, which is the worst way to be wrong.
    if (document === null || document.trim().length === 0) {
      return { state: "merged", outcome: "added", document: (preamble ?? "") + yamlWriter.snippet(client) };
    }
    const { lines, newline } = splitLines(document);
    const analysis = analyze(lines, client);
    if (analysis.kind === "refused") return { state: "refused", reason: analysis.reason };
    if (analysis.kind === "absent") {
      const appended = [...lines, `${client.rootKey}:`, ...renderEntry(client, DEFAULT_INDENT)];
      return { state: "merged", outcome: "added", document: joinLines(appended, newline) };
    }
    const block = analysis.block;
    const located = locate(lines, block, client);
    if (located.kind === "refused") return { state: "refused", reason: located.reason };
    const rendered = renderEntry(client, block.indent);
    if (located.kind === "none") {
      const written = [...lines.slice(0, block.end), ...rendered, ...lines.slice(block.end)];
      return { state: "merged", outcome: "added", document: joinLines(written, newline) };
    }
    if (sameLines(lines.slice(located.start, located.end), rendered)) {
      return { state: "merged", outcome: "unchanged", document };
    }
    const written = [...lines.slice(0, located.start), ...rendered, ...lines.slice(located.end)];
    return { state: "merged", outcome: "updated", document: joinLines(written, newline) };
  },

  /**
   * Take the entry out, and the root key with it when that leaves the key empty.
   *
   * A bare `mcpServers:` reads back as null rather than as no servers, and more than one of these tools
   * rejects that outright. Dropping the emptied key is also what makes a connect followed by a
   * disconnect return the file it started as, which is the property the corpus asserts.
   */
  remove(document: string, client: McpClient): RemoveResult {
    const { lines, newline } = splitLines(document);
    const analysis = analyze(lines, client);
    if (analysis.kind === "refused") return { state: "refused", reason: analysis.reason };
    if (analysis.kind === "absent") return { state: "merged", outcome: "absent", document };
    const block = analysis.block;
    const located = locate(lines, block, client);
    if (located.kind === "refused") return { state: "refused", reason: located.reason };
    if (located.kind === "none") return { state: "merged", outcome: "absent", document };
    const without = [...lines.slice(0, located.start), ...lines.slice(located.end)];
    const remaining = without.slice(block.start, block.end - (located.end - located.start));
    if (remaining.every(blank)) {
      const dropped = [...lines.slice(0, block.key), ...lines.slice(block.end)];
      return { state: "merged", outcome: "removed", document: joinLines(dropped, newline) };
    }
    return { state: "merged", outcome: "removed", document: joinLines(without, newline) };
  },

  read(document: string, client: McpClient): ReadResult {
    const { lines } = splitLines(document);
    const analysis = analyze(lines, client);
    if (analysis.kind === "refused") return { state: "refused", reason: analysis.reason };
    if (analysis.kind === "absent") return { state: "read", entry: null };
    const block = analysis.block;
    const located = locate(lines, block, client);
    if (located.kind === "refused") return { state: "refused", reason: located.reason };
    if (located.kind === "none") return { state: "read", entry: null };
    const urlKey = urlKeyOf(client);
    const url = urlKey === null ? null : (fieldsOf(lines, located, block, client).get(urlKey) ?? null);
    const current = sameLines(lines.slice(located.start, located.end), renderEntry(client, block.indent));
    return { state: "read", entry: { url, current } };
  },

  snippet(client: McpClient): string {
    return `${[`${client.rootKey}:`, ...renderEntry(client, DEFAULT_INDENT)].join("\n")}\n`;
  },
};
