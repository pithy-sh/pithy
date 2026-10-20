// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
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
 * - **`enforced`** — a Biome config was found and `suspicious/noConsole` is `error` somewhere in it, and nothing
 *   turns it back down.
 * - **`off`** — a Biome config was found and the rule is not `error`: absent, `warn`, `info`, turned off by an
 *   override, or the linter disabled. A warning is off on purpose: it fails no lint run, so it closes nothing.
 *   `pithy deploy` refuses this state, and it is the only hard failure the privacy work adds.
 * - **`unverifiable`** — there is no Biome config to read, it does not parse, there are two of them, or it
 *   `extends` a config the rule is not stated beside. An adopter may lint with something else, or in CI, or by
 *   review, and refusing to deploy over a file Pithy does not own would be too blunt. Deploy proceeds, says so,
 *   and the manifest carries the state with its reason.
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
 * The override `pithy privacy enable` writes: the rule at `error`, on each Worker's own source. Scoped the way the
 * starter's `no-console.grit` plugin is scoped, and for its reasons: a `.tsx` file is a browser's console, and a
 * test printing to a terminal is output for a person, not a log line.
 */
export const NO_CONSOLE_OVERRIDE = {
  includes: ["**/apps/*/src/**/*.ts", "!**/*.test.ts"],
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

/** A rule level as Biome states it: a string, or `{ level }`. */
function levelOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "level" in value) {
    const level = (value as { level: unknown }).level;
    return typeof level === "string" ? level : undefined;
  }
  return undefined;
}

/** `rules.suspicious.noConsole`'s level, where `rules` states one — a group set to `off` counts as `off`. */
function ruleLevel(rules: unknown): string | undefined {
  if (typeof rules !== "object" || rules === null) return undefined;
  const suspicious = (rules as Record<string, unknown>).suspicious;
  if (typeof suspicious === "string") return suspicious === "off" ? "off" : undefined;
  if (typeof suspicious !== "object" || suspicious === null) return undefined;
  return levelOf((suspicious as Record<string, unknown>).noConsole);
}

/** A config's `linter` block, or an empty one. */
function linterOf(block: unknown): { enabled?: unknown; rules?: unknown } {
  if (typeof block !== "object" || block === null) return {};
  const linter = (block as Record<string, unknown>).linter;
  return typeof linter === "object" && linter !== null ? (linter as { enabled?: unknown; rules?: unknown }) : {};
}

/** Decide the gate from a parsed Biome config. `file` is the config's project-relative name. */
export function consoleGateOf(config: unknown, file: string): ConsoleGateReading {
  const linter = linterOf(config);
  if (linter.enabled === false) {
    return {
      state: "off",
      file,
      cause: "disabled",
      reason: `The linter is disabled in ${file}, so ${NO_CONSOLE_RULE} never runs.`,
    };
  }
  const overrides = Array.isArray((config as { overrides?: unknown })?.overrides)
    ? ((config as { overrides: unknown[] }).overrides as unknown[])
    : [];
  const levels = [ruleLevel(linter.rules), ...overrides.map((override) => ruleLevel(linterOf(override).rules))].filter(
    (level): level is string => level !== undefined,
  );
  const lowered = levels.find((level) => level !== "error");
  if (levels.includes("error") && lowered === undefined) return { state: "enforced", file };
  if (lowered !== undefined) {
    return {
      state: "off",
      file,
      cause: "lowered",
      reason: `${NO_CONSOLE_RULE} is \`${lowered}\` in ${file}, and only \`error\` fails a lint run.`,
    };
  }
  const extended = (config as { extends?: unknown })?.extends;
  if (extended !== undefined && !(Array.isArray(extended) && extended.length === 0)) {
    return {
      state: "unverifiable",
      file,
      reason: `${file} extends a config Pithy does not read, and does not state ${NO_CONSOLE_RULE} itself.`,
    };
  }
  return { state: "off", file, cause: "unstated", reason: `${NO_CONSOLE_RULE} is not on in ${file}.` };
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
  return consoleGateOf(config, only.file);
}
