// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { createScanner, tokenIsIdentifierOrKeyword } from "typescript/unstable/ast/scanner";

/**
 * The comment-history ratchet: how many history markers each file's comments hold, held against a
 * committed baseline that only ever falls.
 *
 * A history marker is an issue reference (a hash and a number, optionally after `owner/repo`, or a
 * github.com issue or pull URL) or an attribution (a capitalized name, a comma, an ISO date). A date alone
 * is not one. `CLAUDE.md` states the rule the markers stand in for.
 *
 * This module imports builtins and `typescript` and nothing else, so another repository can copy it whole.
 * {@link BASELINE_FILE} and {@link LOWER_COMMAND} are the two names a copy changes.
 */

/** The baseline, at the repository root. */
export const BASELINE_FILE = "comment-history.jsonc";

/** The command that lowers the baseline, as every failure names it. */
export const LOWER_COMMAND = "bun scripts/comment-history.ts";

/** What `--init` reads when there is no baseline yet. A baseline states its own globs after that. */
export const DEFAULT_INCLUDE: readonly string[] = [
  ...["packages", "scripts", "plugins"].flatMap((dir) =>
    [".ts", ".tsx", ".grit", ".jsonc"].map((ext) => `${dir}/**/*${ext}`),
  ),
  "biome.jsonc",
];

/** Generated files belong to their generators. */
export const DEFAULT_EXCLUDE: readonly string[] = ["**/*.generated.*"];

/** The committed baseline: which files are read, and how many markers each may still hold. */
export interface Baseline {
  /** Git glob pathspecs, relative to the repository root. */
  readonly include: readonly string[];
  /** Git glob pathspecs taken back out of {@link include}. */
  readonly exclude: readonly string[];
  /** Repository-relative path to marker count. A file with no markers has no entry. */
  readonly counts: Readonly<Record<string, number>>;
}

/** One file whose count disagrees with the baseline. */
export interface Drift {
  readonly path: string;
  /** `rose`: more than the baseline. `new`: markers in a file the baseline does not list. `fell`: fewer. */
  readonly kind: "rose" | "new" | "fell";
  readonly baseline: number;
  readonly actual: number;
}

/** A file's markers: issue references, issue and pull URLs, and name-plus-date attributions. */
const MARKER = new RegExp(
  [
    String.raw`https?://github\.com/[\w.-]+/[\w.-]+/(?:issues|pull)/\d+`,
    String.raw`[\w.-]+/[\w.-]+#\d+\b`,
    String.raw`(?<![\w&#])#(\d+)\b`,
    String.raw`\b[A-Z][a-z]+(?: [A-Z][a-z]+)?, \d{4}-\d{2}-\d{2}\b`,
  ].join("|"),
  "g",
);

/**
 * A CSS property that takes a color, its `:` or `=`, and any value words before the color, as in
 * `border: 1px solid` or `fill="`. A colon after any other word is prose, and an issue reference follows it.
 */
const COLOR_PROPERTY = /(?:color|fill|stroke|background|border|outline|shadow)[\w-]*\s*[:=]\s*["']?(?:[\w.%-]+\s+)*$/i;

/** How far back {@link COLOR_PROPERTY} looks from a `#`. */
const COLOR_CONTEXT = 48;

/**
 * Whether a bare `#<digits>` is a CSS hex color rather than an issue: six or eight digits, a leading zero,
 * or three or four digits written as the value of a color property.
 */
function isHexColor(digits: string, before: string): boolean {
  if (digits.length === 6 || digits.length === 8 || digits.startsWith("0")) return true;
  return (digits.length === 3 || digits.length === 4) && COLOR_PROPERTY.test(before);
}

/** The history markers in one comment's text, in order. */
export function historyMarkers(comment: string): string[] {
  const found: string[] = [];
  for (const match of comment.matchAll(MARKER)) {
    const digits = match[1];
    const before = comment.slice(Math.max(0, match.index - COLOR_CONTEXT), match.index);
    if (digits !== undefined && isHexColor(digits, before)) continue;
    found.push(match[0]);
  }
  return found;
}

/** Every comment in `text`, read by the language `path`'s extension names. */
export function commentsIn(path: string, text: string): string[] {
  const ext = extname(path);
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return scriptComments(text, false);
  if (ext === ".tsx") return scriptComments(text, true);
  if (ext === ".jsonc" || ext === ".json")
    return plainComments(text, `"`).map(([start, end]) => text.slice(start, end));
  if (ext === ".grit") return plainComments(text, `"\``).map(([start, end]) => text.slice(start, end));
  throw new Error(`${path}: no comment reader for "${ext}" files. Narrow the baseline's include globs.`);
}

/** How many history markers the comments in `text` hold. */
export function countHistory(path: string, text: string): number {
  return commentsIn(path, text).reduce((sum, comment) => sum + historyMarkers(comment).length, 0);
}

const TRIVIA = new Set<SyntaxKind>([
  SyntaxKind.WhitespaceTrivia,
  SyntaxKind.NewLineTrivia,
  SyntaxKind.SingleLineCommentTrivia,
  SyntaxKind.MultiLineCommentTrivia,
  SyntaxKind.ConflictMarkerTrivia,
]);

/** Keywords after which an expression begins, so a `/` starts a regex and a `<` starts JSX. */
const EXPRESSION_KEYWORDS = new Set<SyntaxKind>([
  SyntaxKind.ReturnKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.OfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.YieldKeyword,
  SyntaxKind.AwaitKeyword,
  SyntaxKind.DefaultKeyword,
]);

/** Tokens that end an operand: a `/` after one divides, and a `<` after one compares or opens type arguments. */
const OPERAND_ENDS = new Set<SyntaxKind>([
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

function endsOperand(token: SyntaxKind): boolean {
  if (OPERAND_ENDS.has(token)) return true;
  return tokenIsIdentifierOrKeyword(token) && !EXPRESSION_KEYWORDS.has(token);
}

/**
 * The comments in TypeScript source, read with the TypeScript scanner.
 *
 * The scanner tokenizes and the walk supplies the context a parser would: template literals resume after
 * each `${}`, a `/` where an operand may begin is rescanned as a regex, and in `.tsx` a `<` there opens a
 * JSX element whose text and attribute strings are stepped over. A `<` followed by a name and then `,` or
 * `extends` is a type parameter list, not JSX.
 */
function scriptComments(text: string, jsx: boolean): string[] {
  const scanner = createScanner(false, jsx ? LanguageVariant.JSX : LanguageVariant.Standard, text);
  const comments: string[] = [];
  let recording = true;
  let end = -1;

  /**
   * `scan`, moved one character on when it returns an empty token: the scanner returns one forever at a
   * `#` followed by a backslash.
   */
  const advance = (scan: () => SyntaxKind): SyntaxKind => {
    let token = scan();
    while (token !== SyntaxKind.EndOfFile && scanner.getTokenEnd() <= end) {
      scanner.resetTokenState(end + 1);
      token = scan();
    }
    end = scanner.getTokenEnd();
    return token;
  };

  const significant = (scan: () => SyntaxKind): SyntaxKind => {
    let token = advance(scan);
    while (TRIVIA.has(token)) {
      if (recording && (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia)) {
        comments.push(scanner.getTokenText());
      }
      token = advance(scan);
    }
    return token;
  };
  const scan = (): SyntaxKind => scanner.scan();

  const opensElement = (): boolean => {
    recording = false;
    const before = end;
    try {
      return scanner.lookAhead(() => {
        const first = significant(scan);
        if (first === SyntaxKind.GreaterThanToken) return true;
        if (!tokenIsIdentifierOrKeyword(first)) return false;
        const second = significant(scan);
        return second !== SyntaxKind.CommaToken && second !== SyntaxKind.ExtendsKeyword;
      });
    } finally {
      recording = true;
      end = before;
    }
  };

  /** Code up to the end of the file, or, when `nested`, up to the `}` that closes the brace it began after. */
  const code = (nested: boolean): void => {
    let depth = 0;
    const templates: number[] = [];
    let previous: SyntaxKind = SyntaxKind.Unknown;
    for (;;) {
      let token = significant(scan);
      if (token === SyntaxKind.EndOfFile) return;
      if (token === SyntaxKind.OpenBraceToken) depth++;
      else if (token === SyntaxKind.CloseBraceToken) {
        if (templates.at(-1) === depth) {
          token = scanner.reScanTemplateToken(false);
          if (token !== SyntaxKind.TemplateMiddle) templates.pop();
        } else if (depth === 0) {
          if (nested) return;
        } else depth--;
      } else if (token === SyntaxKind.TemplateHead) templates.push(depth);
      else if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) && !endsOperand(previous)) {
        token = scanner.reScanSlashToken();
      } else if (jsx && token === SyntaxKind.LessThanToken && !endsOperand(previous) && opensElement()) {
        element();
        token = SyntaxKind.Identifier;
      }
      previous = token;
    }
  };

  /** One JSX element, from just after its `<` to the end of its closing tag. */
  const element = (): void => {
    let token = significant(scan);
    if (token === SyntaxKind.GreaterThanToken) {
      children();
      return;
    }
    scanner.scanJsxIdentifier();
    token = significant(scan);
    while (token === SyntaxKind.DotToken || token === SyntaxKind.ColonToken) {
      significant(scan);
      scanner.scanJsxIdentifier();
      token = significant(scan);
    }
    for (;;) {
      if (token === SyntaxKind.EndOfFile) return;
      if (token === SyntaxKind.GreaterThanToken) {
        children();
        return;
      }
      if (token === SyntaxKind.SlashToken) {
        significant(scan);
        return;
      }
      if (token === SyntaxKind.OpenBraceToken) {
        code(true);
        token = significant(scan);
        continue;
      }
      if (tokenIsIdentifierOrKeyword(token)) {
        scanner.scanJsxIdentifier();
        token = significant(scan);
        if (token === SyntaxKind.EqualsToken) {
          const value = significant(() => scanner.scanJsxAttributeValue());
          if (value === SyntaxKind.OpenBraceToken) code(true);
          else if (value === SyntaxKind.LessThanToken) element();
          token = significant(scan);
        }
        continue;
      }
      token = significant(scan);
    }
  };

  /** An element's children, up to and including its closing tag. */
  const children = (): void => {
    for (;;) {
      const token = advance(() => scanner.scanJsxToken());
      if (token === SyntaxKind.EndOfFile) return;
      if (token === SyntaxKind.OpenBraceToken) code(true);
      else if (token === SyntaxKind.LessThanToken) element();
      else if (token === SyntaxKind.LessThanSlashToken) {
        let closing = significant(scan);
        while (closing !== SyntaxKind.GreaterThanToken && closing !== SyntaxKind.EndOfFile) closing = significant(scan);
        return;
      }
    }
  };

  code(false);
  return comments;
}

/**
 * The `[start, end)` of every `//` and `/* *\/` comment in `text`, stepping over strings opened by any of
 * `quotes`. A backtick string may span lines; any other stops at a newline.
 */
function plainComments(text: string, quotes: string): [number, number][] {
  const ranges: [number, number][] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (quotes.includes(char)) {
      at = stringEnd(text, at, char);
    } else if (char === "/" && text[at + 1] === "/") {
      const newline = text.indexOf("\n", at);
      const end = newline === -1 ? text.length : newline;
      ranges.push([at, end]);
      at = end;
    } else if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      const end = close === -1 ? text.length : close + 2;
      ranges.push([at, end]);
      at = end;
    } else {
      at++;
    }
  }
  return ranges;
}

/** Where the string opened by `quote` at `start` ends, just past its closing quote. */
function stringEnd(text: string, start: number, quote: string): number {
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") at += 2;
    else if (char === quote) return at + 1;
    else if (char === "\n" && quote !== "`") return at;
    else at++;
  }
  return at;
}

/** The environment for a git command about `root`, without a hook's pointers at some other repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const pointers = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !pointers.has(name)));
}

/** Every file git tracks under `root` that `include` matches and `exclude` does not, sorted. */
export function trackedFiles(root: string, include: readonly string[], exclude: readonly string[]): string[] {
  const pathspecs = [...include.map((glob) => `:(glob)${glob}`), ...exclude.map((glob) => `:(glob,exclude)${glob}`)];
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((path) => path !== "")
    .sort();
}

/** The marker count of every file the baseline's globs cover that holds at least one. */
export function measure(root: string, baseline: Pick<Baseline, "include" | "exclude">): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of trackedFiles(root, baseline.include, baseline.exclude)) {
    const file = join(root, path);
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const count = countHistory(path, readFileSync(file, "utf8"));
    if (count > 0) counts[path] = count;
  }
  return counts;
}

/** Every file whose measured count is not its baseline count, sorted by path. */
export function drift(baseline: Readonly<Record<string, number>>, actual: Readonly<Record<string, number>>): Drift[] {
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort();
  const found: Drift[] = [];
  for (const path of paths) {
    const was = baseline[path];
    const now = actual[path] ?? 0;
    if (was === undefined) {
      if (now > 0) found.push({ path, kind: "new", baseline: 0, actual: now });
    } else if (now > was) found.push({ path, kind: "rose", baseline: was, actual: now });
    else if (now < was) found.push({ path, kind: "fell", baseline: was, actual: now });
  }
  return found;
}

/** One line naming the file, both counts, and what to do. */
export function describeDrift(entry: Drift): string {
  const counts = `${entry.actual} history marker${entry.actual === 1 ? "" : "s"} in comments, ${entry.baseline} in ${BASELINE_FILE}`;
  if (entry.kind === "fell") return `${entry.path}: ${counts}. Run \`${LOWER_COMMAND}\` to lower the baseline.`;
  const where = entry.kind === "new" ? "The file is not in the baseline. " : "";
  return `${entry.path}: ${counts}. ${where}Take the history out of the comments: \`${LOWER_COMMAND}\` lowers a count and never raises one.`;
}

/** `text` with every comment blanked to spaces, so offsets measured on it hold on the original. */
function blankJsonc(text: string): string {
  let blanked = text;
  for (const [start, end] of plainComments(text, `"`)) {
    blanked = blanked.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + blanked.slice(end);
  }
  return blanked;
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${BASELINE_FILE}: "${key}" must be a list of glob strings.`);
  }
  return value;
}

/** Reads a baseline. Throws, naming the file, on anything that is not one. */
export function parseBaseline(text: string): Baseline {
  const parsed: unknown = JSON.parse(blankJsonc(text));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${BASELINE_FILE}: expected an object with "include", "exclude" and "counts".`);
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).at(-1) !== "counts") {
    throw new Error(`${BASELINE_FILE}: "counts" must be the last key, so the file can be lowered in place.`);
  }
  const counts = record.counts;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    throw new Error(`${BASELINE_FILE}: "counts" must map each path to its marker count.`);
  }
  for (const [path, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || (count as number) < 1) {
      throw new Error(`${BASELINE_FILE}: "${path}" must have a whole count of at least 1.`);
    }
  }
  return {
    include: stringList(record.include, "include"),
    exclude: stringList(record.exclude ?? [], "exclude"),
    counts: counts as Record<string, number>,
  };
}

function renderCounts(counts: Readonly<Record<string, number>>): string {
  const paths = Object.keys(counts).sort();
  if (paths.length === 0) return "{}";
  return `{\n${paths.map((path) => `    ${JSON.stringify(path)}: ${counts[path]}`).join(",\n")}\n  }`;
}

function renderList(key: string, items: readonly string[]): string {
  const inline = `  ${JSON.stringify(key)}: [${items.map((item) => JSON.stringify(item)).join(", ")}],`;
  if (inline.length <= 120) return inline;
  return `  ${JSON.stringify(key)}: [\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ],`;
}

/** A first baseline: the default globs and `counts`, under a header that says what the file is. */
export function initialBaseline(counts: Readonly<Record<string, number>>): string {
  return [
    "// History markers per file in this repository's comments: issue references and name-plus-date",
    "// attributions. A count only falls. CLAUDE.md states the rule; `bun scripts/comment-history.ts` lowers",
    "// the counts to match the tree, and the gate in packages/cli/src/ci/commentHistory.test.ts fails when one",
    "// disagrees.",
    "{",
    renderList("include", DEFAULT_INCLUDE),
    renderList("exclude", DEFAULT_EXCLUDE),
    `  "counts": ${renderCounts(counts)}`,
    "}",
    "",
  ].join("\n");
}

/** `text` with its `counts` replaced and everything above them kept as written. */
export function withCounts(text: string, counts: Readonly<Record<string, number>>): string {
  const blanked = blankJsonc(text);
  const key = blanked.lastIndexOf(`"counts"`);
  if (key === -1) throw new Error(`${BASELINE_FILE}: no "counts" key.`);
  return `${text.slice(0, key)}"counts": ${renderCounts(counts)}\n}\n`;
}

/** The outcome of one run: what to print, and the exit code. */
export interface RunResult {
  readonly code: number;
  readonly output: string;
}

/**
 * The baseline writer. With no arguments it lowers every count that fell and drops every file that reached
 * zero, and refuses, writing nothing, if any count would rise. `--init` writes the first baseline and
 * refuses when one exists.
 */
export function runCommentHistory(root: string, args: readonly string[]): RunResult {
  const path = join(root, BASELINE_FILE);
  if (args.length === 1 && args[0] === "--init") {
    const counts = measure(root, { include: DEFAULT_INCLUDE, exclude: DEFAULT_EXCLUDE });
    try {
      writeFileSync(path, initialBaseline(counts), { flag: "wx" });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      return { code: 1, output: `${BASELINE_FILE} already exists. Run \`${LOWER_COMMAND}\` to lower it.` };
    }
    return { code: 0, output: `Wrote ${BASELINE_FILE}: ${summary(counts)}.` };
  }
  if (args.length > 0) {
    return { code: 1, output: `Usage: ${LOWER_COMMAND} [--init]` };
  }
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
    return { code: 1, output: `No ${BASELINE_FILE}. Run \`${LOWER_COMMAND} --init\` to write the first one.` };
  }
  const text = readFileSync(path, "utf8");
  const baseline = parseBaseline(text);
  const actual = measure(root, baseline);
  const found = drift(baseline.counts, actual);
  const raised = found.filter((entry) => entry.kind !== "fell");
  if (raised.length > 0) {
    const lines = raised.map(
      (entry) => `${entry.path}: ${entry.actual} history markers, ${entry.baseline} in the baseline.`,
    );
    return {
      code: 1,
      output: [
        `Refused: a count never rises. ${BASELINE_FILE} is unchanged.`,
        ...lines,
        "Take the history out of those comments, then run this again.",
      ].join("\n"),
    };
  }
  if (found.length === 0) return { code: 0, output: `${BASELINE_FILE} matches the tree.` };
  writeFileSync(path, withCounts(text, actual));
  const dropped = found.filter((entry) => entry.actual === 0).length;
  return {
    code: 0,
    output: `Lowered ${found.length} file${found.length === 1 ? "" : "s"}, ${dropped} dropped. ${summary(actual)}.`,
  };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function summary(counts: Readonly<Record<string, number>>): string {
  const files = Object.keys(counts).length;
  const markers = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return `${markers} marker${markers === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
}
