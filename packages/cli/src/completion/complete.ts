// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { type DeclaredFlag, type DeclaredPositional, describeArgs } from "../contract/args";
import { contractOf } from "../contract/commandContract";
import { ROOT_FLAG_DESCRIPTIONS } from "../rootFlags";
import { type Candidate, defaultSources, type ValueSources, valuesFor } from "./values";

/**
 * **`pithy __complete <line>` — what a Tab offers, read off the tree the binary dispatches on (#765).**
 *
 * The shell scripts `pithy completion <shell>` prints hold no list of commands. On Tab they hand this the
 * line up to the cursor and offer what comes back, one candidate a line, a tab before its description.
 * So a command added to the tree completes the day it lands, with no change here and no script to
 * regenerate.
 *
 * **The line is one argument, split here.** Every shell can pass one non-empty string; not every shell can
 * pass an empty one (Windows PowerShell 5.1 drops it), and the empty word is exactly what a Tab after a
 * space means. So the shells send the text and this decides the words: whitespace separates them, a
 * trailing space starts a new empty one, and the first is the command word, whatever it was called —
 * `pithy`, `p.`, or a path. Quoting is not interpreted, which costs nothing: no name or value this
 * completes contains a space.
 *
 * **The walk goes as far as the typed words reach and no further.** A subcommand is resolved by its own key
 * alone, so a sibling's lazily imported module is never loaded — `pithy secrets <Tab>` imports `secrets` and
 * nothing else, and `pithy <Tab>` imports nothing, offering the root's names without their descriptions.
 * citty's `meta.alias` is not consulted: finding an alias means resolving every sibling, and nothing in the
 * tree declares one. A word the tree does not have ends the walk with nothing to offer.
 *
 * **It is answered before anything else in `bin.ts` runs.** No flag check, no `--json` latch, no session
 * renewal, no update notifier: nothing that could reach a network, resolve a credential or write a file.
 * A failure of any kind completes nothing and prints nothing (`runComplete`), because a Tab that prints a
 * stack into the middle of a command line is worse than one that does nothing.
 */

/** The name `bin.ts` answers before the tree is consulted. Hidden: in no `--help`, no schema, no catalog. */
export const COMPLETE_COMMAND = "__complete";

/** The words already typed, and the one under the cursor. */
export interface SplitLine {
  /** Every word after the command word and before the one being completed. */
  words: string[];
  /** The word being completed. Empty after a trailing space. */
  current: string;
}

/** Split the line up to the cursor into words, dropping the command word. */
export function splitLine(line: string): SplitLine {
  const tokens = line.split(/\s+/);
  if (tokens[0] === "") tokens.shift();
  // The command word: `pithy`, `p.`, `/usr/local/bin/pithy`. What it was called does not change the answer.
  tokens.shift();
  const current = tokens.pop() ?? "";
  return { words: tokens, current };
}

/** citty's `Resolvable<T>`: a value, a promise of one, or a thunk returning either. */
type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);

/** One `Resolvable`, resolved. */
async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/** A command's subcommands as declared — the container resolved, its members not. */
async function subCommandsOf(cmd: CommandDef): Promise<Record<string, Resolvable<CommandDef>> | undefined> {
  if (cmd.subCommands === undefined) return undefined;
  return (await resolve(cmd.subCommands)) as Record<string, Resolvable<CommandDef>>;
}

/** The one subcommand named `name`, by its own key — an inherited name is not a command. */
async function childNamed(cmd: CommandDef, name: string): Promise<CommandDef | undefined> {
  const declared = await subCommandsOf(cmd);
  if (declared === undefined || !Object.hasOwn(declared, name)) return undefined;
  return resolve(declared[name] as Resolvable<CommandDef>);
}

/** The flags every command takes, as `bin.ts` answers them. None takes a value. */
const GLOBAL_FLAGS: readonly DeclaredFlag[] = ROOT_FLAG_DESCRIPTIONS.map((flag) => ({
  name: flag.name,
  type: "boolean",
  required: false,
  repeatable: false,
  description: flag.description,
  aliases: flag.aliases.map((alias) => ({ flag: alias, kind: "declared" as const })),
}));

/** One command's arguments, read with citty's rules and its contract's facts, as `pithy schema` reads them. */
interface Shape {
  flags: DeclaredFlag[];
  positionals: DeclaredPositional[];
}

async function shapeOf(cmd: CommandDef): Promise<Shape> {
  const args = cmd.args === undefined ? undefined : await resolve(cmd.args);
  const { flags, positionals } = describeArgs(args, contractOf(cmd)?.flags);
  return {
    flags: [...flags, ...GLOBAL_FLAGS.filter((global) => !flags.some((own) => own.name === global.name))],
    positionals,
  };
}

/** The flag a typed spelling reaches — its name, its camel case, a declared alias, or its negation. */
function flagNamed(flags: readonly DeclaredFlag[], spelling: string): DeclaredFlag | undefined {
  return flags.find((flag) => flag.name === spelling || flag.aliases.some((alias) => alias.flag === spelling));
}

/** Where the typed words left the walk. */
interface Position {
  cmd: CommandDef;
  path: string[];
  shape: Shape;
  /** The positionals already given to `cmd`. */
  given: string[];
  /** The canonical names of the flags already typed for `cmd`. */
  used: Set<string>;
  /** The flag whose value is the word being completed, when the last word was one that takes a value. */
  pending: DeclaredFlag | undefined;
  /** Whether a `--` has been typed: nothing after it is a flag. */
  afterSeparator: boolean;
}

/**
 * Walk the typed words the way citty dispatches them: a flag is skipped and so is the value of one that
 * takes a value, the first positional of a command with subcommands names one, and every other word is a
 * positional. `undefined` when a word names a command the tree does not have.
 */
async function walk(root: CommandDef, words: readonly string[]): Promise<Position | undefined> {
  const position: Position = {
    cmd: root,
    path: [],
    shape: await shapeOf(root),
    given: [],
    used: new Set(),
    pending: undefined,
    afterSeparator: false,
  };
  for (const word of words) {
    if (position.pending !== undefined) {
      position.pending = undefined;
      continue;
    }
    if (position.afterSeparator) {
      position.given.push(word);
      continue;
    }
    if (word === "--") {
      position.afterSeparator = true;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      const equals = word.indexOf("=");
      const flag = flagNamed(position.shape.flags, equals === -1 ? word : word.slice(0, equals));
      if (flag !== undefined) {
        position.used.add(flag.name);
        if (flag.type === "string" && equals === -1) position.pending = flag;
      }
      continue;
    }
    if (position.given.length === 0) {
      const child = await childNamed(position.cmd, word);
      if (child !== undefined) {
        position.cmd = child;
        position.path.push(word);
        position.shape = await shapeOf(child);
        position.used = new Set();
        continue;
      }
      // A word where a command must go, naming none. Nothing further can be known about this line.
      if (position.cmd.subCommands !== undefined && position.shape.positionals.length === 0) return undefined;
    }
    position.given.push(word);
  }
  return position;
}

/**
 * The subcommands of `cmd`, hidden ones left out. A member already loaded — declared in its parent's own
 * module — carries its description; a member still behind its thunk is offered by name alone, because
 * reading its description would import it.
 */
async function subcommandCandidates(cmd: CommandDef): Promise<Candidate[]> {
  const declared = await subCommandsOf(cmd);
  if (declared === undefined) return [];
  const candidates: Candidate[] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (typeof value === "function") {
      candidates.push({ value: name, description: "" });
      continue;
    }
    const sub = await value;
    const meta = sub.meta === undefined ? undefined : await resolve(sub.meta);
    if (meta?.hidden === true) continue;
    candidates.push({ value: name, description: meta?.description ?? "" });
  }
  return candidates;
}

/** The flags `position` can still take: its command's, then every command's, less those already typed. */
function flagCandidates(position: Position): Candidate[] {
  return position.shape.flags
    .filter((flag) => flag.repeatable || !position.used.has(flag.name))
    .map((flag) => ({ value: flag.name, description: flag.description }));
}

/** The candidates starting with what was typed, each value once. */
function matching(candidates: readonly Candidate[], typed: string): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.value.startsWith(typed) || seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}

/** What {@link complete} reads besides the tree. */
export interface CompleteOptions {
  /** The directory the shell is in — the project, when it is one. */
  cwd: string;
  /** Where the values come from. The binary's own by default. */
  sources?: ValueSources;
}

/** What a Tab at the end of `line` offers. */
export async function complete(root: CommandDef, line: string, options: CompleteOptions): Promise<Candidate[]> {
  const sources = options.sources ?? defaultSources;
  const { words, current } = splitLine(line);
  const position = await walk(root, words);
  if (position === undefined) return [];
  const { path, shape } = position;

  if (position.pending !== undefined) {
    const flag = position.pending;
    return matching(
      await valuesFor({ path, flag: flag.name.slice(2), enum: flag.enum }, options.cwd, sources),
      current,
    );
  }

  if (!position.afterSeparator && current.startsWith("-")) {
    const equals = current.indexOf("=");
    if (equals === -1) return matching(flagCandidates(position), current);
    // `--env=st`: the value, completed in the spelling it was typed in.
    const spelling = current.slice(0, equals);
    const flag = flagNamed(shape.flags, spelling);
    if (flag === undefined || flag.type !== "string") return [];
    const values = await valuesFor({ path, flag: flag.name.slice(2), enum: flag.enum }, options.cwd, sources);
    return matching(
      values.map((value) => ({ ...value, value: `${spelling}=${value.value}` })),
      current,
    );
  }

  const candidates: Candidate[] = [];
  if (position.given.length === 0 && !position.afterSeparator) {
    candidates.push(...(await subcommandCandidates(position.cmd)));
  }
  const last = shape.positionals.at(-1);
  const positional = shape.positionals[position.given.length] ?? (last?.variadic === true ? last : undefined);
  if (positional !== undefined) {
    candidates.push(
      ...(await valuesFor({ path, positional: positional.name, enum: positional.enum }, options.cwd, sources)),
    );
  }
  return matching(candidates, current);
}

/** One candidate a line, a tab before its description. A description is one line, whatever it held. */
export function renderCandidates(candidates: readonly Candidate[]): string {
  return candidates
    .map((candidate) => {
      const description = candidate.description.replace(/\s+/g, " ").trim();
      return `${candidate.value}${description === "" ? "" : `\t${description}`}\n`;
    })
    .join("");
}

/**
 * Answer `pithy __complete`: the arguments are the line, as one or as words joined by a space. Writes the
 * candidates to stdout. **Never throws and never writes to stderr**: whatever fails — a module that will
 * not load, a source that cannot be read — the Tab completes nothing, and the command line is left as it was.
 */
export async function runComplete(
  root: CommandDef,
  args: readonly string[],
  options: Partial<CompleteOptions> = {},
): Promise<void> {
  try {
    const candidates = await complete(root, args.join(" "), {
      cwd: options.cwd ?? process.cwd(),
      sources: options.sources,
    });
    process.stdout.write(renderCandidates(candidates));
  } catch {
    // Nothing. A Tab that cannot be answered is answered with nothing.
  }
}
