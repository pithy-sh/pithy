// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { parse } from "comment-json";
import { readFileOutcome } from "../project/readOptionalFile";

/**
 * **The console gate: is `console` closed in this project's Worker source?** (#132)
 *
 * A structured log goes through the logger, where the privacy brand can stop a marked value. A `console.log`
 * bypasses every gate the privacy classes add, so once a project declares a class, leaving `console` open would
 * make the rest decorative. Biome's `suspicious/noConsole` is what closes it — `pithy privacy enable` writes it —
 * and this module is the one reader of whether it is on.
 *
 * ## Three states, because Pithy does not own the toolchain
 *
 * - **`enforced`** — a Biome config was found and `suspicious/noConsole` is `error`, allowing no method, for every
 *   Worker source file: each file under `apps/*\/src` in a language Biome lints ({@link WORKER_SOURCE_EXTENSIONS}),
 *   tests aside.
 * - **`off`** — a Biome config was found and, for some Worker source file, the rule is not `error`: absent,
 *   `warn`, `info`, turned off by an override that covers the file, `options.allow` letting a method through, the
 *   linter disabled for it, or `files.includes` or `linter.includes` leaving it unlinted. A warning is off on
 *   purpose: it fails no lint run, so it closes nothing. `pithy deploy` refuses this state, and it is the only
 *   hard failure the privacy work adds.
 * - **`unverifiable`** — there is no Biome config to read, it does not parse, there are two of them, `apps/` or a
 *   Worker holds a nested one, there is no Worker source to read the rule for, it scopes a setting with a glob
 *   Pithy will not guess Biome's reading of, or it `extends` another config. An extended config's overrides
 *   still apply on top of the root's rule, so a rule stated at `error` beside an `extends` proves nothing; one
 *   stated below `error` is still `off`. An adopter may lint with something else, or in CI, or by review, and
 *   refusing to deploy over a file Pithy does not own would be too blunt. Deploy proceeds, says so, and the
 *   manifest carries the state with its reason.
 *
 * **It reads the rule per file, the way Biome does.** An override applies only to the files its `includes`
 * covers, so an override at `error` on `scripts/**` closes nothing in a Worker, and one at `off` on tests opens
 * nothing. Each Worker source file in the project is read through the root's includes and every override that
 * covers it, in order, and the gate is the first file that is not closed — named in the reason.
 *
 * **`unverifiable` is not a hiding place.** Deleting `biome.jsonc` to escape a failing gate moves a project from
 * `enforced` to a state the dashboard renders as unverified on every read. The one state Pithy never reports is
 * a false `enforced`.
 *
 * **Pithy cannot make a lint rule impossible to turn off** — the adopter owns `biome.jsonc` — and nothing here
 * pretends otherwise. What it makes impossible to turn off is the visibility.
 */

/** The Biome configs a project root may hold. Biome reads one; Pithy reads it too. */
export const BIOME_CONFIG_FILES = ["biome.jsonc", "biome.json"] as const;

/** The rule, as Biome names it and as every sentence here names it. */
export const NO_CONSOLE_RULE = "suspicious/noConsole";

/**
 * The extensions of the Worker source the gate reads: every JavaScript and TypeScript file Biome lints. A Worker
 * written in `.tsx` or `.js` is a Worker, and once a class is declared a `console` in it bypasses the gates the
 * same way, so the gate is wider than the starter's `no-console.grit` plugin, which is scoped to `.ts`.
 */
export const WORKER_SOURCE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;

/** A test file, which the gate leaves aside: a test printing to a terminal is output for a person, not a log line. */
const TEST_FILE = /\.test\.[^/]+$/;

/** The override `pithy privacy enable` writes: the rule at `error`, on each Worker's own source, tests aside. */
export const NO_CONSOLE_OVERRIDE = {
  includes: [...WORKER_SOURCE_EXTENSIONS.map((extension) => `**/apps/*/src/**/*.${extension}`), "!**/*.test.*"],
  linter: { rules: { suspicious: { noConsole: "error" } } },
} as const;

/** What the gate reads as. */
export type ConsoleGateReading =
  | { state: "enforced"; file: string }
  | {
      state: "off";
      file: string;
      reason: string;
      /**
       * Why it is off: never stated, stated below `error`, or the linter disabled. Only `unstated` is a config
       * `pithy privacy enable` writes into — the other two are a person's decision.
       */
      cause: "unstated" | "lowered" | "disabled";
    }
  | { state: "unverifiable"; file: string | null; reason: string };

/**
 * The Worker source file the gate reads for when it is handed none: the path every Worker's entry sits at. A
 * project's real files are read by {@link readConsoleGate}; this is what {@link consoleGateOf} assumes alone.
 */
export const DEFAULT_WORKER_SOURCE = "apps/app/src/index.ts";

/**
 * A rule as Biome states it — a string or `{ level, options }` — or `undefined` where `rules` states none. A group
 * set as a string (`"suspicious": "warn"`) sets every rule in it to that level, so it is the rule's level here.
 */
function ruleOf(rules: unknown): unknown {
  if (typeof rules !== "object" || rules === null) return undefined;
  const suspicious = (rules as Record<string, unknown>).suspicious;
  if (typeof suspicious === "string") return suspicious;
  if (typeof suspicious !== "object" || suspicious === null) return undefined;
  return (suspicious as Record<string, unknown>).noConsole;
}

/** A rule's level: the string itself, or `{ level }`'s. */
function levelOf(rule: unknown): string | undefined {
  if (typeof rule === "string") return rule;
  if (typeof rule === "object" && rule !== null && "level" in rule) {
    const level = (rule as { level: unknown }).level;
    return typeof level === "string" ? level : undefined;
  }
  return undefined;
}

/** The console methods a rule's `options.allow` lets through. Any one of them is `console` left open. */
function allowedOf(rule: unknown): string[] {
  if (typeof rule !== "object" || rule === null) return [];
  const options = (rule as { options?: unknown }).options;
  if (typeof options !== "object" || options === null) return [];
  const allow = (options as { allow?: unknown }).allow;
  return Array.isArray(allow) ? allow.map(String) : [];
}

/** A block's `key` object, or an empty one. */
function blockOf(block: unknown, key: string): Record<string, unknown> {
  if (typeof block !== "object" || block === null) return {};
  const inner = (block as Record<string, unknown>)[key];
  return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : {};
}

/** Raised for a glob this module cannot read the way Biome would. The reading is `unverifiable`, never a guess. */
class UnreadableGlob extends Error {}

/**
 * One Biome glob as a matcher. `*` stays inside a segment and `**` spans any number of them; a glob is matched
 * against the project-relative path. Anything richer — `?`, `[…]`, `{…}`, an escape — is not guessed at.
 */
function globMatcher(glob: string): (path: string) => boolean {
  if (/[?[\]{}\\]/.test(glob)) throw new UnreadableGlob(glob);
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

/**
 * Whether an `includes` list covers a path: the last pattern that matches decides, and a `!` pattern excludes.
 * A negation also excludes a directory the path sits in, the way `!**\/dist` does. A list with no positive
 * pattern is not guessed at, and neither is a positive pattern that names only a directory the path is in.
 */
function covers(includes: unknown, path: string): boolean {
  if (!Array.isArray(includes)) throw new UnreadableGlob(String(includes));
  const prefixes = path
    .split("/")
    .slice(0, -1)
    .map((_, index, segments) => segments.slice(0, index + 1).join("/"));
  let covered = false;
  let positive = false;
  for (const raw of includes) {
    if (typeof raw !== "string") throw new UnreadableGlob(String(raw));
    const negated = raw.startsWith("!");
    const matches = globMatcher(raw.replace(/^!+/, ""));
    if (negated) {
      if (matches(path) || prefixes.some(matches)) covered = false;
      continue;
    }
    positive = true;
    if (matches(path)) covered = true;
    else if (prefixes.some(matches)) throw new UnreadableGlob(raw);
  }
  if (!positive) throw new UnreadableGlob(includes.join(", "));
  return covered;
}

/** What the rule is for one file: on, or the first reason it is not. */
type FileReading =
  | { state: "enforced" }
  | { state: "disabled"; why: string }
  | { state: "lowered"; why: string }
  | { state: "unstated"; path: string };

/** The rule's effect on one project-relative file, root config first and each override after it in order. */
function readingFor(config: unknown, file: string, path: string): FileReading {
  const files = blockOf(config, "files");
  if (files.includes !== undefined && !covers(files.includes, path)) {
    return { state: "disabled", why: `${file}'s \`files.includes\` leaves ${path} unread, so nothing lints it.` };
  }
  const linter = blockOf(config, "linter");
  if (linter.includes !== undefined && !covers(linter.includes, path)) {
    return { state: "disabled", why: `${file}'s \`linter.includes\` leaves ${path} unlinted.` };
  }
  let enabled = linter.enabled !== false;
  let rule = ruleOf(linter.rules);
  const overrides = (config as { overrides?: unknown })?.overrides;
  for (const override of Array.isArray(overrides) ? overrides : []) {
    const includes = (override as { includes?: unknown })?.includes;
    if (includes !== undefined && !covers(includes, path)) continue;
    const overridden = blockOf(override, "linter");
    if (typeof overridden.enabled === "boolean") enabled = overridden.enabled;
    const stated = ruleOf(overridden.rules);
    if (stated !== undefined) rule = stated;
  }
  if (!enabled) return { state: "disabled", why: `The linter is disabled for ${path} in ${file}.` };
  const level = levelOf(rule);
  if (level === undefined) return { state: "unstated", path };
  if (level !== "error") {
    return {
      state: "lowered",
      why: `${NO_CONSOLE_RULE} is \`${level}\` for ${path} in ${file}, and only \`error\` fails a lint run.`,
    };
  }
  const allowed = allowedOf(rule);
  if (allowed.length > 0) {
    return {
      state: "lowered",
      why: `${NO_CONSOLE_RULE} allows \`console.${allowed.join("`, `console.")}\` for ${path} in ${file}.`,
    };
  }
  return { state: "enforced" };
}

/**
 * Decide the gate from a parsed Biome config, for the Worker source files it must cover. `file` is the config's
 * project-relative name; `sources` are project-relative paths, {@link DEFAULT_WORKER_SOURCE} when none are known.
 * Every file is read the way Biome would read it — `files.includes`, `linter.includes`, then each override whose
 * `includes` covers it, in order — and the gate is `enforced` only when every one of them is.
 */
export function consoleGateOf(
  config: unknown,
  file: string,
  sources: readonly string[] = [DEFAULT_WORKER_SOURCE],
): ConsoleGateReading {
  const readings: FileReading[] = [];
  try {
    for (const path of sources.length > 0 ? sources : [DEFAULT_WORKER_SOURCE])
      readings.push(readingFor(config, file, path));
  } catch (error) {
    if (!(error instanceof UnreadableGlob)) throw error;
    return {
      state: "unverifiable",
      file,
      reason: `${file} scopes a setting with \`${error.message}\`, a pattern Pithy will not guess Biome's reading of.`,
    };
  }
  const disabled = readings.find((reading) => reading.state === "disabled");
  if (disabled?.state === "disabled") return { state: "off", file, cause: "disabled", reason: disabled.why };
  const lowered = readings.find((reading) => reading.state === "lowered");
  if (lowered?.state === "lowered") return { state: "off", file, cause: "lowered", reason: lowered.why };
  // An extended config's overrides apply on top of this file's rule, so neither `error` nor silence is a reading.
  const extended = (config as { extends?: unknown })?.extends;
  if (extended !== undefined && !(Array.isArray(extended) && extended.length === 0)) {
    return {
      state: "unverifiable",
      file,
      reason: `${file} extends a config Pithy does not read, and its overrides can still turn ${NO_CONSOLE_RULE} down.`,
    };
  }
  const unstated = readings.find((reading) => reading.state === "unstated");
  if (unstated?.state !== "unstated") return { state: "enforced", file };
  return {
    state: "off",
    file,
    cause: "unstated",
    reason: `${NO_CONSOLE_RULE} is not on for ${unstated.path} in ${file}.`,
  };
}

/** What a read of `apps/` found: each Worker's source files and any Biome config nested in `apps/` or a Worker. */
interface AppsRead {
  sources: string[];
  nested: string[];
}

/** A directory's entries, or none when it is not there. */
async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Whether a project-relative path is Worker source the gate reads: a linted extension, and not a test. */
function isWorkerSource(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  return (WORKER_SOURCE_EXTENSIONS as readonly string[]).includes(extension) && !TEST_FILE.test(path);
}

/**
 * Each Worker's source — every linted file under `apps/*\/src`, tests aside — and every Biome config in `apps/`
 * itself, at a Worker's root or inside its `src`: each of those directories sits between the root config and a
 * Worker's source, so a config in any of them would govern it. Only `src` is read below a Worker, so its
 * dependencies and build output are never entered.
 */
async function readApps(projectDir: string): Promise<AppsRead> {
  const found: AppsRead = { sources: [], nested: [] };
  const isConfig = (name: string) => (BIOME_CONFIG_FILES as readonly string[]).includes(name);
  for (const app of await entriesOf(join(projectDir, "apps"))) {
    if (!app.isDirectory()) {
      if (app.isFile() && isConfig(app.name)) found.nested.push(`apps/${app.name}`);
      continue;
    }
    const root = `apps/${app.name}`;
    for (const entry of await entriesOf(join(projectDir, root))) {
      if (entry.isFile() && isConfig(entry.name)) found.nested.push(`${root}/${entry.name}`);
    }
    let below: string[] = [];
    try {
      below = await readdir(join(projectDir, root, "src"), { recursive: true });
    } catch {
      continue;
    }
    for (const relative of below.map((path) => path.split(sep).join("/")).sort()) {
      const path = `${root}/src/${relative}`;
      const name = relative.slice(relative.lastIndexOf("/") + 1);
      if (isConfig(name)) found.nested.push(path);
      else if (isWorkerSource(path)) found.sources.push(path);
    }
  }
  found.nested.sort();
  return found;
}

/**
 * Read the gate at a project root. Never throws: a file it cannot read or parse is `unverifiable` with the reason,
 * because a gate that crashed the deploy would be a refusal Pithy has no standing to make.
 */
export async function readConsoleGate(projectDir: string): Promise<ConsoleGateReading> {
  const found: { file: string; text: string }[] = [];
  for (const file of BIOME_CONFIG_FILES) {
    const read = await readFileOutcome(join(projectDir, file));
    if (read.state === "read") found.push({ file, text: read.text });
    else if (read.state !== "absent") {
      return { state: "unverifiable", file, reason: `${file} could not be read.` };
    }
  }
  const [only, second] = found;
  if (only === undefined) {
    return {
      state: "unverifiable",
      file: null,
      reason: "No biome.json or biome.jsonc at the project root, so the console gate cannot be read.",
    };
  }
  if (second !== undefined) {
    return {
      state: "unverifiable",
      file: null,
      reason: "The project root holds both biome.json and biome.jsonc, and Pithy will not guess which Biome reads.",
    };
  }
  let config: unknown;
  try {
    config = parse(only.text);
  } catch {
    return { state: "unverifiable", file: only.file, reason: `${only.file} does not parse.` };
  }
  const apps = await readApps(projectDir);
  const [nested] = apps.nested;
  if (nested !== undefined) {
    return {
      state: "unverifiable",
      file: nested,
      reason: `${nested} is a nested Biome config, and Pithy reads only the root one, so it will not say what it turns off.`,
    };
  }
  if (apps.sources.length === 0) {
    return {
      state: "unverifiable",
      file: only.file,
      reason: `No Worker source under apps/*/src, so there is no file to read ${NO_CONSOLE_RULE} for.`,
    };
  }
  return consoleGateOf(config, only.file, apps.sources);
}
