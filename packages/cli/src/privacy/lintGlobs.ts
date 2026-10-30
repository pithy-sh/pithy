// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The globs the console gate reads out of a linter config, matched the way that linter matches them, or refused.
 *
 * Every matcher here takes a project-relative path with `/` separators. A pattern the gate will not guess a linter's
 * reading of raises {@link UnreadablePattern}, and the gate reads `unverifiable` rather than a guess.
 */

/** Raised for a pattern the gate cannot read the way the linter would. The reading is `unverifiable`, never a guess. */
export class UnreadablePattern extends Error {}

/**
 * One glob as a matcher. `*` stays inside a segment and `**` spans any number of them; the glob is matched against
 * the whole path. Anything richer — `?`, `[…]`, `{…}`, an escape — is not guessed at.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  if (/[?[\]{}\\]/.test(glob)) throw new UnreadablePattern(glob);
  const parts = (glob.startsWith("./") ? glob.slice(2) : glob).split("/");
  const literal = (text: string) => text.replace(/[.+^$()|]/g, "\\$&");
  let source = "^";
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (part === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += part.split("*").map(literal).join("[^/]*") + (last ? "" : "/");
  }
  const pattern = new RegExp(`${source}$`);
  return (path) => pattern.test(path);
}

/** The directories a path sits in, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  return path
    .split("/")
    .slice(0, -1)
    .map((_, index, segments) => segments.slice(0, index + 1).join("/"));
}

/**
 * Whether a Biome `includes` list covers a path: the last pattern that matches decides, and a `!` pattern excludes.
 * A negation also excludes a directory the path sits in, the way `!**\/dist` does. A list with no positive pattern
 * is not guessed at, and neither is a positive pattern that names only a directory the path is in.
 */
export function biomeCovers(includes: unknown, path: string): boolean {
  if (!Array.isArray(includes)) throw new UnreadablePattern(String(includes));
  const prefixes = ancestorsOf(path);
  let covered = false;
  let positive = false;
  for (const raw of includes) {
    if (typeof raw !== "string") throw new UnreadablePattern(String(raw));
    const negated = raw.startsWith("!");
    const matches = globMatcher(raw.replace(/^!+/, ""));
    if (negated) {
      if (matches(path) || prefixes.some(matches)) covered = false;
      continue;
    }
    positive = true;
    if (matches(path)) covered = true;
    else if (prefixes.some(matches)) throw new UnreadablePattern(raw);
  }
  if (!positive) throw new UnreadablePattern(includes.join(", "));
  return covered;
}

/**
 * One Oxlint override glob as a matcher. A pattern with no `/` matches the file's name at any depth (`*.test.ts`);
 * one with a `/` is anchored at the config's directory. A negation is refused: Oxlint reads `!x` in `files` as
 * everything that is not `x`, which no one writes on purpose, so the gate will not say what it closes.
 */
function oxlintGlob(raw: unknown): (path: string) => boolean {
  if (typeof raw !== "string" || raw.startsWith("!") || raw.endsWith("/")) throw new UnreadablePattern(String(raw));
  const glob = raw.startsWith("/") ? raw.slice(1) : raw;
  return globMatcher(glob.includes("/") ? glob : `**/${glob}`);
}

/** Whether an Oxlint `files` or `excludeFiles` list matches a path: any one pattern matching is a match. */
export function oxlintMatches(globs: unknown, path: string): boolean {
  if (!Array.isArray(globs)) throw new UnreadablePattern(String(globs));
  return globs.map(oxlintGlob).some((matches) => matches(path));
}

/**
 * Whether Oxlint's `ignorePatterns` ignore a path. They are gitignore-style: a pattern with no `/` (a trailing one
 * aside) names a file or directory at any depth, one with a `/` is anchored at the config's directory, a trailing
 * `/` names only a directory, and a path inside an ignored directory is ignored. A negation is refused.
 */
export function oxlintIgnores(patterns: unknown, path: string): boolean {
  if (!Array.isArray(patterns)) throw new UnreadablePattern(String(patterns));
  const directories = ancestorsOf(path);
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.startsWith("!")) throw new UnreadablePattern(String(raw));
    const directoryOnly = raw.endsWith("/");
    const trimmed = (directoryOnly ? raw.slice(0, -1) : raw).replace(/^\//, "");
    const matches = globMatcher(trimmed.includes("/") || raw.startsWith("/") ? trimmed : `**/${trimmed}`);
    if (directories.some(matches) || (!directoryOnly && matches(path))) return true;
  }
  return false;
}
