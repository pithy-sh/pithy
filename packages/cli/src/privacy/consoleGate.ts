// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { parse } from "comment-json";
import { readFileOutcome } from "../project/readOptionalFile";
import { type ConsoleGateReading, combineGates, type FileReading, gateOf } from "./gateReading";
import { biomeCovers, UnreadablePattern } from "./lintGlobs";
import {
  ESLINT_IGNORE_FILE,
  OXLINT_CONFIG_FILE,
  OXLINT_NO_CONSOLE_RULE,
  oxlintGateOf,
  withEslintIgnore,
} from "./oxlintGate";

/**
 * **The console gate: is `console` closed in this project's Worker source?**
 *
 * A structured log goes through the logger, where the privacy brand can stop a marked value. A `console.log`
 * bypasses every gate the privacy classes add, so once a project declares a class, leaving `console` open would
 * make the rest decorative. Biome's `suspicious/noConsole` or Oxlint's `no-console` is what closes it — `pithy
 * privacy enable` writes it into each config the project holds — and this module is the one reader of whether it
 * is on.
 *
 * ## Three states, because Pithy does not own the toolchain
 *
 * - **`enforced`** — every linter config at the root closes the rule at `error`, allowing no method, for every
 *   Worker source file: each file under `apps/*\/src` in a language the linters lint ({@link WORKER_SOURCE_EXTENSIONS}),
 *   tests aside.
 * - **`off`** — a config was found and, for some Worker source file, the rule is not `error`: absent, `warn`,
 *   `info`, turned off by an override that covers the file, an allow-list letting a method through, the linter
 *   disabled for it, or the file left unlinted. A warning is off on purpose: it fails no lint run, so it closes
 *   nothing. `pithy deploy` refuses this state, and it is the only hard failure the privacy work adds.
 * - **`unverifiable`** — there is no `biome.json`, `biome.jsonc` or `.oxlintrc.json` to read, one does not parse,
 *   there are two Biome configs, `apps/` or a Worker holds a nested one, there is no Worker source to read the rule
 *   for, a config scopes a setting with a glob Pithy will not guess its linter's reading of, or it `extends`
 *   another config. An extended config's overrides still apply on top of the root's rule, so a rule stated at
 *   `error` beside an `extends` proves nothing; one stated below `error` is still `off`. Deploy proceeds, says so,
 *   and the manifest carries the state with its reason.
 *
 * **Both linters configured is one gate.** It is `enforced` only when both close the rule; one `off` decides it, and
 * one `unverifiable` keeps it from `enforced`.
 *
 * **It reads the rule per file, the way each linter does.** An override applies only to the files it covers, so an
 * override at `error` on `scripts/**` closes nothing in a Worker, and one at `off` on tests opens nothing. The gate
 * is the first file that is not closed, named in the reason.
 *
 * **`unverifiable` is not a hiding place.** Deleting a config to escape a failing gate moves a project from
 * `enforced` to a state the dashboard renders as unverified on every read. The one state Pithy never reports is a
 * false `enforced`.
 *
 * **Pithy cannot make a lint rule impossible to turn off** — the adopter owns the config — and nothing here
 * pretends otherwise. What it makes impossible to turn off is the visibility.
 */

/** The Biome configs a project root may hold. Biome reads one; Pithy reads it too. */
export const BIOME_CONFIG_FILES = ["biome.jsonc", "biome.json"] as const;

/** The rule, as Biome names it and as every sentence here names it. */
export const NO_CONSOLE_RULE = "suspicious/noConsole";

/**
 * The extensions of the Worker source the gate reads: every JavaScript and TypeScript file Biome and Oxlint lint. A
 * Worker written in `.tsx` or `.js` is a Worker, and once a class is declared a `console` in it bypasses the gates
 * the same way, so the gate is wider than the starter's `no-console` plugin rule, which is scoped to `.ts`.
 */
export const WORKER_SOURCE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;

/** A test file, which the gate leaves aside: a test printing to a terminal is output for a person, not a log line. */
const TEST_FILE = /\.test\.[^/]+$/;

/** The override `pithy privacy enable` writes: the rule at `error`, on each Worker's own source, tests aside. */
export const NO_CONSOLE_OVERRIDE = {
  includes: [...WORKER_SOURCE_EXTENSIONS.map((extension) => `**/apps/*/src/**/*.${extension}`), "!**/*.test.*"],
  linter: { rules: { suspicious: { noConsole: "error" } } },
} as const;

/** The same override, as `pithy privacy enable` writes it into an `.oxlintrc.json`. */
export const OXLINT_NO_CONSOLE_OVERRIDE = {
  files: WORKER_SOURCE_EXTENSIONS.map((extension) => `**/apps/*/src/**/*.${extension}`),
  excludeFiles: ["**/*.test.*"],
  rules: { [OXLINT_NO_CONSOLE_RULE]: "error" },
} as const;

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

/** The rule's effect on one project-relative file, root config first and each override after it in order. */
function readingFor(config: unknown, file: string, path: string): FileReading {
  const files = blockOf(config, "files");
  if (files.includes !== undefined && !biomeCovers(files.includes, path)) {
    return { state: "disabled", why: `${file}'s \`files.includes\` leaves ${path} unread, so nothing lints it.` };
  }
  const linter = blockOf(config, "linter");
  if (linter.includes !== undefined && !biomeCovers(linter.includes, path)) {
    return { state: "disabled", why: `${file}'s \`linter.includes\` leaves ${path} unlinted.` };
  }
  let enabled = linter.enabled !== false;
  let rule = ruleOf(linter.rules);
  const overrides = (config as { overrides?: unknown })?.overrides;
  for (const override of Array.isArray(overrides) ? overrides : []) {
    const includes = (override as { includes?: unknown })?.includes;
    if (includes !== undefined && !biomeCovers(includes, path)) continue;
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
    if (!(error instanceof UnreadablePattern)) throw error;
    return {
      state: "unverifiable",
      file,
      reason: `${file} scopes a setting with \`${error.message}\`, a pattern Pithy will not guess Biome's reading of.`,
    };
  }
  const extended = (config as { extends?: unknown })?.extends;
  return gateOf(readings, {
    file,
    rule: NO_CONSOLE_RULE,
    extended:
      extended !== undefined && !(Array.isArray(extended) && extended.length === 0)
        ? `${file} extends a config Pithy does not read, and its overrides can still turn ${NO_CONSOLE_RULE} down.`
        : null,
  });
}

/** What a read of `apps/` found: each Worker's source files and any linter config nested in `apps/` or a Worker. */
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
 * Each Worker's source — every linted file under `apps/*\/src`, tests aside — and every config named in `configs`
 * in `apps/` itself, at a Worker's root or inside its `src`: each of those directories sits between the root
 * config and a Worker's source, so a config in any of them would govern it. Only `src` is read below a Worker, so
 * its dependencies and build output are never entered.
 */
async function readApps(projectDir: string, configs: readonly string[]): Promise<AppsRead> {
  const found: AppsRead = { sources: [], nested: [] };
  const isConfig = (name: string) => configs.includes(name);
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

/** The linters the gate reads, each with the root config names it answers to and the reader for one. */
const LINTERS = [
  {
    name: "biome",
    files: BIOME_CONFIG_FILES,
    rule: NO_CONSOLE_RULE,
    read: consoleGateOf,
  },
  {
    name: "oxlint",
    files: [OXLINT_CONFIG_FILE],
    rule: OXLINT_NO_CONSOLE_RULE,
    read: oxlintGateOf,
  },
] as const;

/** A linter the gate reads. */
export type GateLinter = (typeof LINTERS)[number]["name"];

/** One linter config the project root holds, and the gate it reads as on its own. */
export interface LinterGate {
  /** Which linter it configures. */
  linter: GateLinter;
  /** Its project-relative name, or `null` when two Biome configs left the gate no single one to read. */
  file: string | null;
  /** The gate as this config alone reads. */
  gate: ConsoleGateReading;
}

/** One linter's gate at a project root, or `null` when the root holds none of its configs. */
async function readLinter(
  projectDir: string,
  linter: (typeof LINTERS)[number],
  apps: AppsRead,
): Promise<LinterGate | null> {
  const found: { file: string; text: string }[] = [];
  for (const file of linter.files) {
    const read = await readFileOutcome(join(projectDir, file));
    if (read.state === "read") found.push({ file, text: read.text });
    else if (read.state !== "absent") {
      return { linter: linter.name, file, gate: { state: "unverifiable", file, reason: `${file} could not be read.` } };
    }
  }
  const [only, second] = found;
  if (only === undefined) return null;
  if (second !== undefined) {
    const reason = `The project root holds both ${only.file} and ${second.file}, and Pithy will not guess which ${linter.name === "biome" ? "Biome" : "Oxlint"} reads.`;
    return { linter: linter.name, file: null, gate: { state: "unverifiable", file: null, reason } };
  }
  const gate = (reading: ConsoleGateReading): LinterGate => ({ linter: linter.name, file: only.file, gate: reading });
  let config: unknown;
  try {
    config = parse(only.text);
  } catch {
    return gate({ state: "unverifiable", file: only.file, reason: `${only.file} does not parse.` });
  }
  const nested = apps.nested.find((path) => (linter.files as readonly string[]).includes(basename(path)));
  if (nested !== undefined) {
    return gate({
      state: "unverifiable",
      file: nested,
      reason: `${nested} is a nested config, and Pithy reads only the root one, so it will not say what it turns off.`,
    });
  }
  if (apps.sources.length === 0) {
    return gate({
      state: "unverifiable",
      file: only.file,
      reason: `No Worker source under apps/*/src, so there is no file to read ${linter.rule} for.`,
    });
  }
  if (linter.name === "oxlint") {
    const ignored = await readFileOutcome(join(projectDir, ESLINT_IGNORE_FILE));
    if (ignored.state === "read") config = withEslintIgnore(config, ignored.text);
    else if (ignored.state !== "absent") {
      return gate({
        state: "unverifiable",
        file: ESLINT_IGNORE_FILE,
        reason: `${ESLINT_IGNORE_FILE} could not be read.`,
      });
    }
  }
  return gate(linter.read(config, only.file, apps.sources));
}

/**
 * Each linter config at a project root, read on its own: Biome's first, then Oxlint's, and none when the root
 * holds neither. `pithy privacy enable` writes into each one that is `off` for want of the rule.
 */
export async function readLinterGates(projectDir: string): Promise<LinterGate[]> {
  const apps = await readApps(
    projectDir,
    LINTERS.flatMap((linter) => [...linter.files]),
  );
  const gates: LinterGate[] = [];
  for (const linter of LINTERS) {
    const read = await readLinter(projectDir, linter, apps);
    if (read !== null) gates.push(read);
  }
  return gates;
}

/** The reason the gate gives when the root holds no linter config at all. */
export const NO_LINTER_CONFIG = `No ${[...BIOME_CONFIG_FILES].reverse().join(", ")} or ${OXLINT_CONFIG_FILE} at the project root, so the console gate cannot be read.`;

/**
 * Read the gate at a project root, across every linter config it holds. Never throws: a file it cannot read or
 * parse is `unverifiable` with the reason, because a gate that crashed the deploy would be a refusal Pithy has no
 * standing to make.
 */
export async function readConsoleGate(projectDir: string): Promise<ConsoleGateReading> {
  const [first, ...rest] = (await readLinterGates(projectDir)).map((read) => read.gate);
  if (first === undefined) return { state: "unverifiable", file: null, reason: NO_LINTER_CONFIG };
  return combineGates([first, ...rest]);
}
