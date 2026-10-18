// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Edit the service bindings an app declares, in its `pithy.config.ts` source, and nothing else (#617).**
 *
 * `pithy worker bind` adds `{ type: "service", name, service }` to the app capability's `requiredBindings`,
 * `unbind` takes one out, and `worker rename` points every one naming the renamed Worker at its new name. The
 * file is the adopter's TypeScript, so each edit is a splice into the bytes that are there: every other byte of
 * the file comes back identical, comments and formatting included.
 *
 * The array is found on a copy of the source with every comment and string body blanked to spaces, so a
 * `requiredBindings: [` in a comment or a string is never mistaken for the real one, and a `]` inside a string
 * never closes it. Where the app's array cannot be told apart — no `requiredBindings` array at all, or two with
 * no `const app = defineCapability(` to choose between them — the answer is `null` and the caller prints the line
 * to paste. Editing a guess would be worse than not editing.
 */

/** One service binding, as `pithy worker bind` writes it. */
export interface ServiceDeclaration {
  /** The binding name in the Worker's env. */
  binding: string;
  /** The Worker called, by its `apps/<name>` directory name or a kit Worker's capability name. */
  target: string;
}

/** The entry, as it is written into `requiredBindings`. */
export function renderServiceBinding(declaration: ServiceDeclaration): string {
  return `{ type: "service", name: ${JSON.stringify(declaration.binding)}, service: ${JSON.stringify(declaration.target)} }`;
}

/** The source with every comment and the body of every string blanked to spaces, newlines kept. Same length. */
function codeOnly(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (out[index] !== "\n") out[index] = " ";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === "\\" ? 2 : 1;
      // The quotes stay, so a string still reads as a value; only what is inside them is blanked.
      blank(index + 1, Math.min(end, source.length));
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return out.join("");
}

/** The index of the bracket closing the one at `open`, in code-only text, or -1. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
  const stack: string[] = [];
  for (let index = open; index < code.length; index += 1) {
    const char = code[index] as string;
    if (pairs[char]) stack.push(pairs[char] as string);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/** Where the app's `requiredBindings` array is: its `[` and its `]`. */
interface ArraySpan {
  open: number;
  close: number;
}

/** The app capability's `requiredBindings` array, or `null` when it cannot be told apart from every other. */
function appBindingsArray(source: string): ArraySpan | null {
  const code = codeOnly(source);
  const spans: ArraySpan[] = [];
  for (const match of code.matchAll(/\brequiredBindings\s*:\s*\[/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closing(code, open);
    if (close !== -1) spans.push({ open, close });
  }
  if (spans.length === 1) return spans[0] ?? null;
  // More than one: the one inside `const app = defineCapability({…})`, which is what the scaffold writes — or a
  // bare `const app = {…}`, which is the same object without the helper.
  const app = /\bconst\s+app\s*=\s*(?:defineCapability\s*\(\s*)?\{/.exec(code);
  if (!app) return null;
  const objectOpen = app.index + app[0].length - 1;
  const objectClose = closing(code, objectOpen);
  const inside = spans.filter((span) => span.open > objectOpen && span.close < objectClose);
  return inside.length === 1 ? (inside[0] ?? null) : null;
}

/** The leading whitespace of the line holding `index`. */
function indentAt(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
}

/** One element of the array: where it starts and ends in the source, the comma after it excluded. */
interface ElementSpan {
  start: number;
  end: number;
}

/** The array's elements, split at its top-level commas, each trimmed of surrounding whitespace. */
function elementsOf(source: string, span: ArraySpan): ElementSpan[] {
  const code = codeOnly(source);
  const elements: ElementSpan[] = [];
  let start = span.open + 1;
  let depth = 0;
  const push = (end: number) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(code[from] as string)) from += 1;
    while (to > from && /\s/.test(code[to - 1] as string)) to -= 1;
    if (to > from) elements.push({ start: from, end: to });
  };
  for (let index = span.open + 1; index < span.close; index += 1) {
    const char = code[index] as string;
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      push(index);
      start = index + 1;
    }
  }
  push(span.close);
  return elements;
}

/** A string-valued key of an object literal's source, `name: "APP_B"` → `APP_B`, or `undefined`. */
function keyValue(element: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(["'])([^"'\\\\]*)\\1`).exec(element);
  return match?.[2];
}

/**
 * Add one service binding to the app's `requiredBindings`, or `null` when the array cannot be found. The entry
 * goes last, at the indentation of the entries already there; an empty array opens onto its own lines, and a
 * one-line array stays on one.
 */
export function addServiceBinding(source: string, declaration: ServiceDeclaration): string | null {
  const span = appBindingsArray(source);
  if (!span) return null;
  const entry = renderServiceBinding(declaration);
  const elements = elementsOf(source, span);
  const last = elements[elements.length - 1];
  if (!last) {
    const indent = indentAt(source, span.open);
    return `${source.slice(0, span.open + 1)}\n${indent}  ${entry},\n${indent}${source.slice(span.close)}`;
  }
  const code = codeOnly(source);
  // The comma after the last entry, when the adopter wrote one.
  let after = last.end;
  while (after < span.close && /[ \t]/.test(code[after] as string)) after += 1;
  const hasComma = code[after] === ",";
  const multiline = source.slice(span.open, span.close).includes("\n");
  if (!multiline) {
    const insertAt = hasComma ? after + 1 : last.end;
    return `${source.slice(0, insertAt)}${hasComma ? " " : ", "}${entry}${source.slice(insertAt)}`;
  }
  // After the last entry's line — past its comma and any comment on that line — at the entries' indentation.
  const lineEnd = source.indexOf("\n", hasComma ? after : last.end);
  const indent = indentAt(source, last.start);
  if (hasComma) {
    return `${source.slice(0, lineEnd + 1)}${indent}${entry},\n${source.slice(lineEnd + 1)}`;
  }
  return `${source.slice(0, last.end)},${source.slice(last.end, lineEnd + 1)}${indent}${entry},\n${source.slice(lineEnd + 1)}`;
}

/** Which service entry to take out: by its binding name, or by the Worker it calls. */
export type ServiceSelector = { binding: string } | { target: string };

/**
 * Take the app's service binding the selector names out of `requiredBindings`, or `null` when there is none. An
 * entry on its own line goes with its line; one sharing a line goes with the comma that separates it.
 */
export function removeServiceBinding(source: string, selector: ServiceSelector): string | null {
  const span = appBindingsArray(source);
  if (!span) return null;
  const elements = elementsOf(source, span);
  const index = elements.findIndex((element) => {
    const text = source.slice(element.start, element.end);
    if (keyValue(text, "type") !== "service") return false;
    return "binding" in selector
      ? keyValue(text, "name") === selector.binding
      : keyValue(text, "service") === selector.target;
  });
  const element = elements[index];
  if (!element) return null;
  const code = codeOnly(source);
  let after = element.end;
  while (after < span.close && /[ \t]/.test(code[after] as string)) after += 1;
  const hasComma = code[after] === ",";
  const lineStart = source.lastIndexOf("\n", element.start - 1) + 1;
  const ownLine = source.slice(lineStart, element.start).trim() === "";
  const lineEnd = source.indexOf("\n", hasComma ? after : element.end);
  const restOfLine = source.slice(hasComma ? after + 1 : element.end, lineEnd === -1 ? undefined : lineEnd).trim();
  if (ownLine && restOfLine === "" && lineEnd !== -1 && lineEnd < span.close) {
    return `${source.slice(0, lineStart)}${source.slice(lineEnd + 1)}`;
  }
  // Sharing a line: the entry and the separator on one side of it.
  const previous = elements[index - 1];
  if (hasComma) return `${source.slice(0, element.start)}${source.slice(after + 1).replace(/^[ \t]+/, "")}`;
  if (previous) {
    const cut = code.lastIndexOf(",", element.start);
    return `${source.slice(0, cut)}${source.slice(element.end)}`;
  }
  return `${source.slice(0, element.start)}${source.slice(element.end)}`;
}

/**
 * Point every service binding naming `from` at `to`, for `pithy worker rename`, or `null` when none names it.
 * `from` is every name the Worker went by — its directory and its deploy name, since a declaration may carry
 * either. The binding names stay: the app's code reads them.
 */
export function retargetServiceBindings(source: string, from: string | readonly string[], to: string): string | null {
  const names = new Set(typeof from === "string" ? [from] : from);
  const span = appBindingsArray(source);
  if (!span) return null;
  let result = source;
  let changed = false;
  // Last to first, so a splice never moves an element still to be visited.
  for (const element of [...elementsOf(source, span)].reverse()) {
    const text = result.slice(element.start, element.end);
    const target = keyValue(text, "service");
    if (keyValue(text, "type") !== "service" || target === undefined || !names.has(target)) continue;
    const rewritten = text.replace(
      /(\bservice\s*:\s*)(["'])[^"'\\]*\2/,
      (_whole, key: string, quote: string) => `${key}${quote}${to}${quote}`,
    );
    result = `${result.slice(0, element.start)}${rewritten}${result.slice(element.end)}`;
    changed = true;
  }
  return changed ? result : null;
}

/**
 * Every service binding the app's `requiredBindings` declares as a literal, read off the source. For a Worker
 * whose config will not load, where `pithy worker remove` still has to know whether it binds the Worker going
 * away. The loaded config is the answer wherever it can be had.
 */
export function declaredServiceBindings(source: string): ServiceDeclaration[] {
  const span = appBindingsArray(source);
  if (!span) return [];
  const found: ServiceDeclaration[] = [];
  for (const element of elementsOf(source, span)) {
    const text = source.slice(element.start, element.end);
    if (keyValue(text, "type") !== "service") continue;
    const binding = keyValue(text, "name");
    const target = keyValue(text, "service");
    if (binding !== undefined && target !== undefined) found.push({ binding, target });
  }
  return found;
}
