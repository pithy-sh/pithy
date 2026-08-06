// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * One named import found in a `pithy.config.ts`. The three commands that write that file — `add`,
 * `remove`, and `eject` — all need the same answer about it, and each used to hand-build the exact
 * line it expected instead. That is why `pithy add secrets` could write an import `remove` would not
 * take out and `eject` would not find.
 */
export interface ConfigImport {
  /** The statement exactly as it appears — leading indentation and trailing `;` included. */
  statement: string;
  /** The module specifier it imports from, unquoted. */
  specifier: string;
  /** Where the statement starts in the source it was found in — the anchor every edit splices at. */
  start: number;
  /**
   * The span to cut to drop this one binding: the name, plus the comma joining it to its neighbour.
   * Meaningless on its own — {@link withoutBinding} is what reads it.
   */
  bindingStart: number;
  bindingEnd: number;
  /** True when the clause binds nothing else, so dropping the name drops the whole statement. */
  soleBinding: boolean;
}

/**
 * A named import statement — `import { a, type B, c as d } from "…";`.
 *
 * Leading whitespace is tolerated: indentation is cosmetic, and a config formatted with an indented
 * import is still one. `import type { … }` does not match — it binds no value, so it cannot be the
 * import a registration call needs. Neither do the default and namespace forms (`import auth from …`,
 * `import * as auth from …`): a capability factory is a named export, and an adopter who binds the
 * name that way collides at typecheck, loudly, rather than getting the wrong thing composed.
 *
 * The pattern is only ever run over {@link scanConfig}'s output, never over raw file text.
 */
const NAMED_IMPORT = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2;?/gm;

/** A config's text with everything that only *looks* like code taken out of the way. */
interface ScannedConfig {
  /**
   * The source with every comment blanked to spaces — same length, same offsets, same line breaks, so
   * a match here indexes straight back into the original.
   */
  code: string;
  /** True at each offset that sits inside a string or template literal. */
  inLiteral: boolean[];
}

/**
 * Blank the comments and mark the literals in a `pithy.config.ts`.
 *
 * The pattern above is a regex over file text, and text does not know what a comment is: a
 * commented-out `import { auth } from "@pithy-sh/auth/src/index";` above the real binding answered
 * the "is this already imported?" question on its behalf, so `pithy add` wrote the registration and
 * no import. A one-character scanner is the bounded fix. **It is not a parser**, and two things it
 * deliberately does not understand: a regex literal (telling `/…/` from division needs the grammar,
 * so an import inside one still reads as code), and `${…}` inside a template literal (treated as more
 * literal, which can only make it blind, never fooled). The real answer is a TypeScript parse, and
 * TS 7 ships no `createSourceFile` to do it with — `catalog.test.ts` records the same constraint.
 */
function scanConfig(source: string): ScannedConfig {
  type State = "code" | "line-comment" | "block-comment" | "string" | "template";
  let code = "";
  const inLiteral = new Array<boolean>(source.length).fill(false);
  let state: State = "code";
  let quote = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (state === "code") {
      if (char === "/" && (next === "/" || next === "*")) {
        state = next === "/" ? "line-comment" : "block-comment";
        code += "  ";
        index += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = char === "`" ? "template" : "string";
        quote = char;
      }
      code += char;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      // A newline ends it, and is kept: the pattern is line-anchored, so line breaks have to survive.
      if (char === "\n") state = "code";
      code += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        code += "  ";
        index += 2;
        continue;
      }
      code += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    // A string or template literal, kept verbatim: an import's own specifier is one, so blanking it
    // would take the answer with it. The flag is what rejects a match that *starts* inside one.
    inLiteral[index] = true;
    code += char;
    if (char === "\\" && index + 1 < source.length) {
      inLiteral[index + 1] = true;
      code += next;
      index += 2;
      continue;
    }
    if (char === quote) state = "code";
    index += 1;
  }

  return { code, inLiteral };
}

/** One comma-separated name in an import clause, and where it sits in the source. */
interface ClauseSegment {
  /** The segment verbatim, padding and all — `" auth "` in `{ a, auth }`. */
  text: string;
  /** Its absolute span in the source. The commas are the gaps between one segment and the next. */
  start: number;
  end: number;
}

/** Split a clause on its commas, carrying each piece's offset. `offset` is where the clause starts. */
function clauseSegments(clause: string, offset: number): ClauseSegment[] {
  const segments: ClauseSegment[] = [];
  let at = offset;
  for (const text of clause.split(",")) {
    segments.push({ text, start: at, end: at + text.length });
    at += text.length + 1; // the comma
  }
  return segments;
}

/**
 * The named import that binds `name`, or `undefined` when nothing does.
 *
 * **Keyed on the binding, not the specifier.** Where a capability is imported from is the adopter's
 * business — a deep path, an ejected copy — but the *name* is the thing a registration call resolves
 * through, so that is what identifies the import. What the specifier is then used for is a separate
 * question each caller answers with {@link isCapabilityImport}.
 */
export function findNamedImport(source: string, name: string): ConfigImport | undefined {
  const { code, inLiteral } = scanConfig(source);
  for (const match of code.matchAll(NAMED_IMPORT)) {
    if (inLiteral[match.index]) continue; // an import inside a string is a string
    const clause = match[1] ?? "";
    const segments = clauseSegments(clause, match.index + match[0].indexOf("{") + 1);
    for (const [index, segment] of segments.entries()) {
      const trimmed = segment.text.trim();
      if (trimmed === "" || trimmed.startsWith("type ")) continue;
      // `x as y` binds `y`; an alias means the adopter is using a different name, and this is not it.
      const parts = trimmed.split(/\s+as\s+/);
      if ((parts[1] ?? parts[0] ?? "").trim() !== name) continue;

      // What an edit would cut. The first name takes the comma after it (`{ auth, b }` → `{ b }`); a
      // later one takes the comma before it and stops at the name, so the clause keeps its padding
      // (`{ a, auth }` → `{ a }`). A sole binding is cut whole and the statement goes with it.
      const soleBinding = segments.every((other, at) => at === index || other.text.trim() === "");
      const trailing = segment.text.length - segment.text.trimEnd().length;
      const after = segments[index + 1]?.start ?? segment.end;
      const before = segments[index - 1]?.end ?? segment.start;
      // Sliced from the source, not taken from the match: a comment inside the statement is blank in
      // `code`, and the statement callers edit is the one the adopter wrote.
      return {
        statement: source.slice(match.index, match.index + match[0].length),
        specifier: match[3] ?? "",
        start: match.index,
        bindingStart: soleBinding || index === 0 ? segment.start : before,
        bindingEnd: soleBinding ? segment.end : index === 0 ? after : segment.end - trailing,
        soleBinding,
      };
    }
  }
  return undefined;
}

/**
 * The module specifier a capability's factory is imported from — the package's `src/index` barrel.
 *
 * Exported because it is a claim about another package's files, and `catalog.test.ts` checks it
 * against them. `@pithy-sh/secrets` shipped with no `src/index.ts`, so `pithy add secrets` wrote a
 * specifier nothing answered and every later `pithy` command failed loading the config. The test
 * reads this string rather than a copy of it, so the two cannot drift apart again.
 */
export function capabilityImportSpecifier(pkg: string): string {
  return `${pkg}/src/index`;
}

/**
 * Whether a specifier is one the capability itself can be behind: its package (the `src/index`
 * barrel or any deeper path into it), or the local copy an eject wrote.
 *
 * Deep paths count because an adopter reaching past the barrel is still importing *this capability*,
 * and the three commands have to agree on that. They did not: `add` blessed a hand-edited deep
 * import, `remove` left it behind while uninstalling the package, and `eject` refused to find it.
 * Anything else is the adopter's own module that happens to share the name — not ours to rewrite,
 * and not ours to delete.
 */
export function isCapabilityImport(specifier: string, pkg: string, ejectPath: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`) || specifier === ejectPath;
}

/**
 * The source with one **binding** taken out — the whole statement only when that binding was the last
 * name in the clause, including the newline it sat on so no blank line is left behind.
 *
 * The binding, not the statement, because `findNamedImport` deliberately matches one name inside a
 * multi-name clause: deleting the statement took `import { auth, hashPassword } from …` down to
 * nothing and left a config that no longer compiles, over bindings that were never the capability's.
 * What remains may still import a package that is about to be uninstalled — that is a typecheck
 * failure the adopter can read, which beats silently deleting code they wrote.
 *
 * A no-op if the statement is no longer where {@link ConfigImport} says it is.
 */
export function withoutBinding(source: string, found: ConfigImport): string {
  const end = found.start + found.statement.length;
  if (source.slice(found.start, end) !== found.statement) return source;
  if (!found.soleBinding) return source.slice(0, found.bindingStart) + source.slice(found.bindingEnd);
  return source.slice(0, found.start) + source.slice(source.startsWith("\n", end) ? end + 1 : end);
}
