// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ConsoleGateReading, type FileReading, gateOf } from "./gateReading";
import { oxlintIgnores, oxlintMatches, UnreadablePattern } from "./lintGlobs";

/**
 * **The console gate, read out of an `.oxlintrc.json`.**
 *
 * Oxlint's `no-console` closes `console` the way Biome's `suspicious/noConsole` does, so the same three states
 * apply. Each Worker source file is read the way Oxlint reads it: `ignorePatterns` first, then the root `rules`
 * over the `restriction` category's level, then every override whose `files` match and whose `excludeFiles` do
 * not, in order. A glob Oxlint reads in a way Pithy will not guess, and a rule stated twice under its two names in
 * one block, are `unverifiable`, never a guess.
 */

/** The Oxlint config a project root may hold. */
export const OXLINT_CONFIG_FILE = ".oxlintrc.json";

/**
 * The ignore file Oxlint also reads by default, beside `ignorePatterns`. Its lines are gitignore-style too, so the
 * gate reads them as more `ignorePatterns`. Oxlint reads `.gitignore` as well, and the gate does not, for the
 * reason it does not read Biome's VCS integration: a Worker's source is committed, so it is not ignored there.
 */
export const ESLINT_IGNORE_FILE = ".eslintignore";

/** A parsed `.oxlintrc.json` with an `.eslintignore`'s patterns added to its `ignorePatterns`. */
export function withEslintIgnore(config: unknown, text: string): Record<string, unknown> {
  const block = recordOf(config);
  const patterns = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (patterns.length === 0) return block;
  if (block.ignorePatterns === undefined) return { ...block, ignorePatterns: patterns };
  if (!Array.isArray(block.ignorePatterns)) return block;
  return { ...block, ignorePatterns: [...block.ignorePatterns, ...patterns] };
}

/** The rule, as Oxlint names it. */
export const OXLINT_NO_CONSOLE_RULE = "no-console";

/** The names Oxlint answers the rule to. */
const RULE_NAMES = [OXLINT_NO_CONSOLE_RULE, `eslint/${OXLINT_NO_CONSOLE_RULE}`] as const;

/** The category Oxlint files `no-console` under, which turns it on for every file when set. */
const RULE_CATEGORY = "restriction";

/** Raised for a block stating the rule under both of its names. The reading is `unverifiable`, never a guess. */
class AmbiguousRule extends Error {}

/** A record, or an empty one. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A rule as an Oxlint block states it, or `undefined` where it states none. Both of its names at once is refused. */
function ruleOf(rules: unknown, file: string): unknown {
  const block = recordOf(rules);
  const stated = RULE_NAMES.filter((name) => block[name] !== undefined);
  if (stated.length > 1) {
    throw new AmbiguousRule(
      `${file} states both ${RULE_NAMES.join(" and ")} in one block, and Pithy will not guess which wins.`,
    );
  }
  return stated[0] === undefined ? undefined : block[stated[0]];
}

/** A level as Oxlint spells it, in Biome's words: `off`, `warn` or `error`. Anything else is kept as written. */
function normalLevel(level: unknown): string | undefined {
  if (level === "deny" || level === 2 || level === "error") return "error";
  if (level === "warn" || level === 1) return "warn";
  if (level === "off" || level === "allow" || level === 0) return "off";
  return level === undefined ? undefined : String(level);
}

/** A rule's level: the value itself, or the first entry of `[level, options]`. */
function levelOf(rule: unknown): string | undefined {
  return normalLevel(Array.isArray(rule) ? rule[0] : rule);
}

/** The console methods a rule's options let through. Any one of them is `console` left open. */
function allowedOf(rule: unknown): string[] {
  if (!Array.isArray(rule)) return [];
  const allow = recordOf(rule[1]).allow;
  return Array.isArray(allow) ? allow.map(String) : [];
}

/** The rule's effect on one project-relative file. */
function readingFor(config: Record<string, unknown>, file: string, path: string): FileReading {
  if (config.ignorePatterns !== undefined && oxlintIgnores(config.ignorePatterns, path)) {
    return { state: "disabled", why: `${file}'s \`ignorePatterns\` leave ${path} unlinted.` };
  }
  const category = recordOf(config.categories)[RULE_CATEGORY];
  let rule = ruleOf(config.rules, file) ?? category;
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];
  for (const override of overrides) {
    const block = recordOf(override);
    if (!oxlintMatches(block.files, path)) continue;
    if (block.excludeFiles !== undefined && oxlintMatches(block.excludeFiles, path)) continue;
    const stated = ruleOf(block.rules, file);
    if (stated !== undefined) rule = stated;
  }
  const level = levelOf(rule);
  if (level === undefined) return { state: "unstated", path };
  if (level !== "error") {
    return {
      state: "lowered",
      why: `${OXLINT_NO_CONSOLE_RULE} is \`${level}\` for ${path} in ${file}, and only \`error\` fails a lint run.`,
    };
  }
  const allowed = allowedOf(rule);
  if (allowed.length > 0) {
    return {
      state: "lowered",
      why: `${OXLINT_NO_CONSOLE_RULE} allows \`console.${allowed.join("`, `console.")}\` for ${path} in ${file}.`,
    };
  }
  return { state: "enforced" };
}

/**
 * Decide the gate from a parsed `.oxlintrc.json`, for the Worker source files it must cover. `file` is the config's
 * project-relative name and `sources` are project-relative paths; the gate is `enforced` only when every one is.
 */
export function oxlintGateOf(config: unknown, file: string, sources: readonly string[]): ConsoleGateReading {
  const block = recordOf(config);
  const readings: FileReading[] = [];
  try {
    for (const path of sources) readings.push(readingFor(block, file, path));
  } catch (error) {
    if (error instanceof AmbiguousRule) return { state: "unverifiable", file, reason: error.message };
    if (!(error instanceof UnreadablePattern)) throw error;
    return {
      state: "unverifiable",
      file,
      reason: `${file} scopes a setting with \`${error.message}\`, a pattern Pithy will not guess Oxlint's reading of.`,
    };
  }
  const extended = block.extends;
  return gateOf(readings, {
    file,
    rule: OXLINT_NO_CONSOLE_RULE,
    extended:
      extended !== undefined && !(Array.isArray(extended) && extended.length === 0)
        ? `${file} extends a config Pithy does not read, and its overrides can still turn ${OXLINT_NO_CONSOLE_RULE} down.`
        : null,
  });
}
