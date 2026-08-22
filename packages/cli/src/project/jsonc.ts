// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { stringify } from "comment-json";
import { type AtomicWriteOptions, writeFileAtomic } from "./atomic";
import { readFileOutcome } from "./readOptionalFile";

/**
 * The one place Pithy turns a parsed JSONC document back into bytes.
 *
 * **The invariant: a file Pithy writes is a file the formatter it scaffolds would print unchanged.**
 * The kit scaffolds Biome *and* the pre-commit hook that runs it, so it already knows the rules its own
 * output has to satisfy — and until #249 it did not follow them. `comment-json`'s `stringify` puts every
 * array element on its own line, Biome collapses a short array onto one, and so `pithy ui sync` wrote a
 * `wrangler.jsonc` that failed the commit hook the CLI itself installed. The workaround was to exempt
 * `wrangler.jsonc` and `pithy.worker.jsonc` from the scaffolded formatter, which is not a fix: it says
 * the two files Pithy touches most are the two nothing formats.
 *
 * Two rules, which together are Biome's `expand: "auto"` for JSON:
 *
 * - **An array is one line when it fits, and one element per line when it does not.** No source to
 *   consult and no choice to preserve; the width decides it.
 * - **An object keeps the shape it already had.** Biome preserves an object's expansion, so both forms
 *   pass — but only one of them leaves the diff alone. A `pithy ui sync` that changed two lines was
 *   producing 78 insertions, because re-printing expanded every object in the file, and a real edit
 *   invisible inside a reformat is an edit nobody reviewed. The previous bytes are the oracle;
 *   an object Pithy is adding has none, and collapses if it fits.
 *
 * A span holding a comment is never collapsed. Joining its lines would put everything after a `//`
 * inside it, and comments are the reason this repo writes JSONC at all.
 */

/** The width Biome prints JSON at, and the width the starter's `biome.jsonc` declares. */
export const JSONC_LINE_WIDTH = 120;

/** One bracketed span in a source text, and everything the printer has to know about it. */
interface Span {
  /** `[` or `{`. */
  readonly kind: "array" | "object";
  /** Index of the opening bracket. */
  readonly open: number;
  /** Index of the closing bracket. */
  readonly close: number;
  /** Where the span sits in the document — `/assets/run_worker_first`. The oracle's key. */
  readonly path: string;
  /** True when a comment sits anywhere inside, at any depth. Such a span is never collapsed. */
  readonly hasComment: boolean;
  /** True when a newline separated the opening bracket from the first thing inside it. */
  readonly expanded: boolean;
  /** The spans directly inside this one, in source order. */
  readonly children: Span[];
}

/** A span being scanned, before its closing bracket has been found. */
interface Frame {
  kind: "array" | "object";
  open: number;
  path: string;
  /** The key the object is currently inside the value of, or `null` before the first `:`. */
  key: string | null;
  /** How many elements of an array have been passed. */
  index: number;
  hasComment: boolean;
  expanded: boolean;
  sawFirstToken: boolean;
  sawNewline: boolean;
  /** True while the next string literal in an object would be a key rather than a value. */
  expectKey: boolean;
  children: Span[];
}

/** The path of the value a frame is currently reading — its key, or its index inside an array. */
function childPath(frame: Frame): string {
  return `${frame.path}/${frame.kind === "object" ? (frame.key ?? "") : frame.index}`;
}

/** Where a string literal starting at `start` ends, escapes honored. Returns the index of its closing quote. */
function endOfString(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index;
  }
  return text.length - 1;
}

/**
 * Every bracketed span in `text`, as a forest in source order.
 *
 * One pass, because the printer and the oracle both need the same three facts about a span — where it
 * is, what its path is, and whether anything inside it forbids a collapse — and two scanners would be
 * two chances to disagree about them.
 */
function scanSpans(text: string): Span[] {
  const roots: Span[] = [];
  const stack: Frame[] = [];
  let pendingKey: string | null = null;

  /** Everything up the stack refuses to collapse: a joined line would swallow what follows a `//`. */
  const markComment = (): void => {
    for (const frame of stack) frame.hasComment = true;
  };

  /** The first thing inside a span settles whether the source had it expanded. */
  const markToken = (): void => {
    const frame = stack.at(-1);
    if (!frame || frame.sawFirstToken) return;
    frame.sawFirstToken = true;
    frame.expanded = frame.sawNewline;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\n") {
      const frame = stack.at(-1);
      if (frame && !frame.sawFirstToken) frame.sawNewline = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") continue;

    if (char === "/" && text[index + 1] === "/") {
      markComment();
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end - 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      markComment();
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }

    if (char === '"') {
      markToken();
      const end = endOfString(text, index);
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectKey) pendingKey = text.slice(index + 1, end);
      index = end;
      continue;
    }

    if (char === ":") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") {
        frame.key = pendingKey;
        frame.expectKey = false;
      }
      continue;
    }

    if (char === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectKey = true;
      if (frame?.kind === "array") frame.index += 1;
      continue;
    }

    if (char === "{" || char === "[") {
      markToken();
      const parent = stack.at(-1);
      stack.push({
        kind: char === "{" ? "object" : "array",
        open: index,
        path: parent ? childPath(parent) : "",
        key: null,
        index: 0,
        hasComment: false,
        expanded: false,
        sawFirstToken: false,
        sawNewline: false,
        expectKey: char === "{",
        children: [],
      });
      continue;
    }

    if (char === "}" || char === "]") {
      const frame = stack.pop();
      if (!frame) continue;
      const span: Span = {
        kind: frame.kind,
        open: frame.open,
        close: index,
        path: frame.path,
        hasComment: frame.hasComment,
        expanded: frame.expanded,
        children: frame.children,
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(span);
      else roots.push(span);
      continue;
    }

    markToken();
  }
  return roots;
}

/**
 * Which objects the previous bytes had expanded, by path.
 *
 * Objects only. An array's shape is decided by the width every time, so remembering one would only let a
 * stale answer overrule the rule.
 */
function objectWrapping(previous: string): Map<string, boolean> {
  const wrapping = new Map<string, boolean>();
  const visit = (span: Span): void => {
    if (span.kind === "object") wrapping.set(span.path, span.expanded);
    for (const child of span.children) visit(child);
  };
  for (const root of scanSpans(previous)) visit(root);
  return wrapping;
}

/** The span's text with every child already decided, then this span's own decision applied. */
function printSpan(text: string, span: Span, wrapping: Map<string, boolean>): string {
  let printed = "";
  let cursor = span.open;
  for (const child of span.children) {
    printed += text.slice(cursor, child.open) + printSpan(text, child, wrapping);
    cursor = child.close + 1;
  }
  printed += text.slice(cursor, span.close + 1);

  if (span.hasComment) return printed;
  const inner = printed.slice(1, -1).trim();
  if (inner.length === 0) return span.kind === "array" ? "[]" : "{}";
  // The document's top level stays expanded whatever its width: no config file is one line, and an
  // absent oracle is the ordinary case for a file Pithy is creating.
  if (span.kind === "object" && (wrapping.get(span.path) ?? span.path.length === 0)) return printed;

  const joined = printed
    .slice(1, -1)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
  const collapsed = span.kind === "array" ? `[${joined}]` : `{ ${joined} }`;

  // What the line would measure once collapsed. Nothing but a comma and a comment ever follows a value
  // on its own line, and neither moves, so the prefix and the suffix are read from the expanded text.
  const lineStart = text.lastIndexOf("\n", span.open) + 1;
  const lineEnd = text.indexOf("\n", span.close);
  const prefix = text.slice(lineStart, span.open);
  const suffix = text.slice(span.close + 1, lineEnd === -1 ? text.length : lineEnd);
  if (prefix.length + collapsed.length + suffix.length > JSONC_LINE_WIDTH) return printed;
  return collapsed;
}

/**
 * `value` as the bytes of a JSONC file — comments preserved, formatted the way the project's Biome
 * would print them, and shaped like `previous` wherever `previous` had an opinion.
 *
 * Pass the file's current contents as `previous` whenever there are any. Without them every object
 * collapses that fits, which is right for a file being created and wrong for one being edited: it would
 * rewrap an adopter's whole file around a two-line change.
 */
export function formatJsonc(value: unknown, previous?: string | null): string {
  const expanded = stringify(value, null, 2) ?? "";
  const wrapping = previous ? objectWrapping(previous) : new Map<string, boolean>();
  const roots = scanSpans(expanded);
  let printed = "";
  let cursor = 0;
  for (const root of roots) {
    printed += expanded.slice(cursor, root.open) + printSpan(expanded, root, wrapping);
    cursor = root.close + 1;
  }
  printed += expanded.slice(cursor);
  return `${printed}\n`;
}

/**
 * Write `value` to `path` as JSONC, atomically, shaped like whatever is already there.
 *
 * The previous bytes are read here rather than passed in, so no caller can forget them. Most callers
 * have already read the file, so this is a second read of something small — the price of an argument
 * nobody has to remember, whose absence would show up only as a reformatted diff. A file that will not
 * open is not a refusal: this is about formatting, and the write itself is about to answer for the path.
 */
export async function writeJsonc(path: string, value: unknown, options?: AtomicWriteOptions): Promise<void> {
  const previous = await readFileOutcome(path);
  const bytes = formatJsonc(value, previous.state === "read" ? previous.text : null);
  await writeFileAtomic(path, bytes, options);
}
