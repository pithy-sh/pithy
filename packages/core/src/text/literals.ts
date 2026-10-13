// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Every string a source file writes, as it reads at run time near enough to scan (#711)** — each quoted or
 * template literal's text, quotes off, escapes resolved to the character they stand for, and every `${…}` blanked
 * to `<x>`.
 *
 * Gates that read what the code *says* — `packages/cli/src/ci/runnableCommands.test.ts` reads every `pithy …` a
 * line names — used one regular expression for "a string or template literal", and it has a measured false
 * reading: a template whose interpolation holds a template of its own, `` `${path}${detail ? ` — ${detail}` :
 * ""}` ``, closed at the inner backtick, and everything after it was read as a literal that opened there. The
 * scan then reported text the file does not contain, and missed the text it does. So this walks the source and
 * keeps a stack: a `${` opens an expression, whose own literals are read as literals in their turn, and its
 * matching `}` resumes the template it interrupted.
 *
 * Comments must be blanked first (`./comments`), as every caller here already does. A regex literal is stepped
 * over by the same rule `./comments` uses — a `/` where a value may begin opens one — so a quote inside a pattern
 * does not open a string.
 */
export function literalTexts(source: string, options: LiteralOptions = {}): string[] {
  return literalSpans(source, options).map((span) => span.text);
}

/** How a source is read. */
export interface LiteralOptions {
  /**
   * The source is a `.tsx` file: an element's text and its attribute strings are read as literals too, and a
   * `<` where a value may begin opens an element rather than comparing. A JSX text run is read with its
   * whitespace collapsed, as React renders it; a `{…}` child is `<x>`.
   */
  readonly jsx?: boolean;
}

/** One literal: its text as {@link literalTexts} reads it, and the source range it spans, delimiters included. */
export interface LiteralSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** A template's interpolations, each the range of the code between `${` and `}`. Absent for any other literal. */
  readonly holes?: readonly (readonly [number, number])[];
}

/**
 * {@link literalTexts}, with where each one sits — so a gate can read what is around a literal: a `+` beside it, or
 * the array it is an element of being joined.
 */
export function literalSpans(source: string, options: LiteralOptions = {}): LiteralSpan[] {
  const found: LiteralSpan[] = [];
  walk(source, 0, found, false, options.jsx === true);
  return found;
}

/** After one of these, a `/` opens a regex literal; after anything else it divides. */
const VALUE_POSITION = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);

/**
 * Walk code from `start`, pushing every literal it meets. Inside an interpolation (`nested`), an unmatched `}`
 * closes it: the walk returns the index just past that brace.
 */
function walk(source: string, start: number, found: LiteralSpan[], nested: boolean, jsx: boolean): number {
  let depth = 0;
  let previous = "";
  let index = start;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '"' || char === "'") {
      index = quoted(source, index, char, found);
      previous = char;
      continue;
    }
    if (char === "`") {
      index = template(source, index, found, jsx);
      previous = char;
      continue;
    }
    if (jsx && char === "<" && opensElement(source, index, previous)) {
      // An element is read whole, or — when it does not parse as one, as a generic arrow `<T,>` does not — the
      // `<` is code after all, and what it read is put back.
      const mark = found.length;
      const end = element(source, index, found);
      if (end !== null) {
        index = end;
        previous = ")";
        continue;
      }
      found.length = mark;
    }
    if (char === "/" && VALUE_POSITION.has(previous)) {
      index = endOfRegex(source, index);
      previous = "/";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      if (depth === 0 && nested) return index + 1;
      depth -= 1;
    }
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return index;
}

/** One quoted string: its text pushed, the index past its closing quote returned. A newline ends it unclosed. */
function quoted(source: string, start: number, quote: string, found: LiteralSpan[]): number {
  let text = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\\") {
      text += source[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (char === quote || char === "\n") {
      const end = char === quote ? index + 1 : index;
      found.push({ text, start, end });
      return end;
    }
    text += char;
  }
  found.push({ text, start, end: source.length });
  return source.length;
}

/**
 * One template: its text pushed with each `${…}` as `<x>`, and every literal inside an interpolation pushed in
 * its own right. Returns the index past the closing backtick.
 */
function template(source: string, start: number, found: LiteralSpan[], jsx: boolean): number {
  let text = "";
  const holes: [number, number][] = [];
  const slot = found.length;
  found.push({ text: "", start, end: start });
  const close = (end: number): LiteralSpan => ({ text, start, end, ...(holes.length > 0 ? { holes } : {}) });
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") {
      text += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "`") {
      found[slot] = close(index + 1);
      return index + 1;
    }
    if (char === "$" && source[index + 1] === "{") {
      text += "<x>";
      const from = index + 2;
      index = walk(source, from, found, true, jsx);
      // `walk` returns past the `}` that closed it; an unclosed one ran to the end.
      holes.push([from, source[index - 1] === "}" ? index - 1 : index]);
      continue;
    }
    text += char;
    index += 1;
  }
  found[slot] = close(source.length);
  return source.length;
}

/** After one of these words, as after a {@link VALUE_POSITION} character, a value begins. */
const VALUE_WORDS = new Set(["return", "yield", "await", "default", "case", "else", "do"]);

/**
 * Whether the `<` at `index` opens a JSX element: where a value may begin — after an operator, a bracket, or a
 * word such as `return` — and followed by a tag name or, for a fragment, `>`. After an identifier or a closing
 * bracket it compares, or opens a type's arguments.
 */
function opensElement(source: string, index: number, previous: string): boolean {
  if (!/[A-Za-z_$>]/.test(source[index + 1] ?? "")) return false;
  if (VALUE_POSITION.has(previous)) return true;
  const before = /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(Math.max(0, index - 32), index));
  return before !== null && VALUE_WORDS.has(before[1] as string);
}

/** A JSX text run as React renders it: whitespace collapsed, and nothing pushed for a run that is only space. */
function pushText(text: string, start: number, end: number, found: LiteralSpan[]): void {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length > 0) found.push({ text: collapsed, start, end });
}

/**
 * One JSX element from its `<`: each attribute string and each text run pushed, every `{…}` walked as code. Returns
 * the index past the element, or `null` when what follows the `<` is not an element — a generic arrow `<T,>(…)`,
 * or a `<` that never closes — for the caller to read as code.
 */
function element(source: string, start: number, found: LiteralSpan[]): number | null {
  let index = start + 1;
  const name = /^[A-Za-z_$][\w$.:-]*/.exec(source.slice(index))?.[0] ?? "";
  index += name.length;
  // The attributes, up to `>` or `/>`.
  for (;;) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    const char = source[index];
    if (char === undefined) return null;
    if (char === "/" && source[index + 1] === ">") return index + 2;
    if (char === ">") {
      index += 1;
      break;
    }
    if (char === "{") {
      index = walk(source, index + 1, found, true, true);
      continue;
    }
    const attribute = /^[A-Za-z_$][\w$:-]*/.exec(source.slice(index))?.[0];
    if (attribute === undefined || name === "") return null;
    index += attribute.length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") continue;
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    const value = source[index];
    if (value === "{") {
      index = walk(source, index + 1, found, true, true);
      continue;
    }
    if (value !== '"' && value !== "'") return null;
    // A JSX attribute string has no escapes, and may run across lines.
    const close = source.indexOf(value, index + 1);
    if (close === -1) return null;
    found.push({ text: source.slice(index + 1, close), start: index, end: close + 1 });
    index = close + 1;
  }
  // The children, up to the closing tag.
  let text = "";
  let from = index;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "{") {
      text += "<x>";
      index = walk(source, index + 1, found, true, true);
      continue;
    }
    if (char === "<") {
      const closing = /^<\s*\//.exec(source.slice(index));
      if (closing !== null) {
        pushText(text, from, index, found);
        const end = source.indexOf(">", index);
        return end === -1 ? null : end + 1;
      }
      pushText(text, from, index, found);
      const end = element(source, index, found);
      if (end === null) return null;
      index = end;
      text = "";
      from = index;
      continue;
    }
    text += char;
    index += 1;
  }
  return null;
}

/** Where a regex literal ends. A `/` inside a character class does not close it; a newline does. */
function endOfRegex(source: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\n") return index;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
  }
  return source.length;
}
