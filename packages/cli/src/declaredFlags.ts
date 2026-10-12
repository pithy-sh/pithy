// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ArgsDef, CommandDef } from "citty";
import { readBooleanToken } from "./booleanToken";
import { HIDDEN_ROOT_FLAGS } from "./commands/alias";
import { aliasNames, camelSpelling, flagAliases, isPositional } from "./contract/args";
import { findSubCommand, type SubCommand } from "./dispatch";
import { malformedNoInputFlag, malformedPrettyFlag, ROOT_FLAGS, wantsPretty } from "./rootFlags";

/**
 * **Every flag an invocation carries is a flag its command declares.** (#594)
 *
 * That is the rule, and it holds for every command in the tree because it is checked in one place — here,
 * called once by `bin.ts` before citty is handed the arguments — rather than by twenty-six commands that
 * would each have to remember it. A command added next year inherits it by being registered.
 *
 * citty will not state it. Its parser runs Node's `parseArgs` with `strict: false`, so a flag it was never
 * told about parses without a word and lands in `args` for nobody to read. `pithy doctor --env prod` looked
 * like it answered about prod and answered about dev (#586), and a typo in a safety flag — `--dry-rn`,
 * `--yse` — ran the unsafe version and exited 0. wrangler exits 1 on an unknown argument; so does this.
 *
 * **Before citty, not inside a command's `setup`.** citty parses a command's arguments before it calls
 * `setup`, and that parse throws its own `Missing required positional argument` for `pithy ui --bogus`
 * — so a guard there would lose to citty's message on exactly the commands a typo is likeliest on, and
 * citty's catch prints usage to stdout, which breaks `--json`'s one line. Before citty, the refusal is the
 * first and only thing said.
 *
 * **What "declares" means is {@link flagsOf}**, the same function the docs catalog publishes, so the flags
 * the site says a command takes and the flags the command accepts are one answer rather than two. Plus the
 * flags `bin.ts` answers before any command is dispatched ({@link GLOBAL_FLAGS}), which every command takes.
 *
 * **What this does not see**, stated so nobody assumes it does:
 *
 * - A name that is not a command. `pithy nonsense --bogus` is citty's `E_UNKNOWN_COMMAND`, and the walk
 *   hands it back at the first token it cannot resolve.
 * - Anything after `--`. That is payload for a child process.
 * - A token that is a declared string flag's value, even one starting with a dash — `--worker -x` gives
 *   `-x` to `--worker`, because that is what citty does with it.
 */

/**
 * Every flag the CLI parses outside a command's `args`, in every spelling.
 *
 * `bin.ts` answers all six before citty is handed the arguments, so no command declares one and a walk of
 * the tree cannot find one — yet each works on any command. The docs catalog publishes these as its
 * `globalFlags`, and this check accepts them everywhere, from the same list.
 *
 * **Composed from the modules that decide, never restated.** The two hidden flags were missed on the
 * docs catalog's first pass, and a literal list would go stale the same way the moment a seventh landed.
 */
export const GLOBAL_FLAGS: readonly string[] = [...ROOT_FLAGS, ...HIDDEN_ROOT_FLAGS];

/**
 * Every flag one command's parser answers to — what the docs catalog publishes, and what this check accepts.
 *
 * The declared name, then every other spelling citty answers, in the one order `contract/args.ts` gives
 * them: the camelCase form (`--withPrerequisites`), declared aliases (long and short), and `--no-<name>` on
 * a boolean. `pithy schema` publishes the same spellings grouped under their names, from the same function,
 * so the three lists cannot disagree.
 *
 * A **positional** is not a flag and is left out: it carries no `--`.
 */
export function flagsOf(args: ArgsDef | undefined): string[] {
  return Object.entries(args ?? {})
    .filter(([, def]) => !isPositional(def))
    .flatMap(([name, def]) => [`--${name}`, ...flagAliases(name, def).map((alias) => alias.flag)]);
}

/** What {@link undeclaredFlags} found: the command, what it was given that it does not take, and what it does. */
export interface UndeclaredFlags {
  /** The command as typed, from the root down — `["token", "mint"]`. Empty for the root itself. */
  path: string[];
  /** Each flag the command does not declare, as typed and without any `=value`, in order. */
  undeclared: string[];
  /** The flags the command declares, by their declared names, in declaration order. */
  declared: string[];
}

/** citty's `Resolvable<T>`, resolved. `args`, `subCommands` and `default` are all declared this way. */
async function resolve<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/** Which of one command's tokens are flags, and where its subcommand's begin. */
interface Scan {
  /** Every flag token the command owns, as typed and without any `=value`. */
  flags: string[];
  /** The index in the input of the first positional — a dispatching command's subcommand name — or -1. */
  firstPositional: number;
}

/**
 * Read one command's tokens the way citty reads them, and report the flags among them.
 *
 * **Tokenized by Node's own `parseArgs`, configured as citty configures it**, not by a second parser
 * written here. The places a hand-rolled one goes wrong are exactly the places citty's does not: a string
 * flag takes the next token as its value even when that token starts with a dash, `-nf x` is two short
 * flags and a value, `-fplan.json` is a short flag with an inline value. Asking the parser citty asks
 * cannot disagree with it about any of them.
 *
 * **`--no-` tokens are lifted out first, because citty lifts them out first** — before `parseArgs`
 * sees the arguments — so a `--no-` token is never a value and never shifts which token is one.
 *
 * **Which flags the command owns turns on whether it dispatches, and on nothing else.** A group's first
 * positional names the subcommand every later token belongs to, so a group owns the flags before it. A
 * leaf's positional is its own argument — `secrets rotate API_KEY`, `seed staging` — and citty parses a
 * leaf's flags on both sides of it, so a leaf owns every flag up to `--`. Cutting a leaf at its positional
 * too is how `pithy secrets rotate API_KEY --dry-rn` went unchecked and rotated for real: the thing, then
 * the flags, is the order people type.
 */
function scan(tokens: readonly string[], args: ArgsDef, dispatches: boolean): Scan {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = {};
  for (const [name, def] of Object.entries(args)) {
    const arg = def as { type?: string; alias?: unknown };
    if (arg.type === "positional") continue;
    const type = arg.type === "boolean" ? "boolean" : "string";
    const aliases = aliasNames(arg.alias);
    const short = aliases.find((alias) => alias.length === 1);
    const longs = [camelSpelling(name), ...aliases.filter((alias) => alias.length > 1)].filter((long) => long !== name);
    for (const long of longs) options[long] = { type };
    options[name] = short === undefined ? { type } : { type, short };
  }

  const kept: { token: string; at: number }[] = [];
  const negated: { flag: string; at: number }[] = [];
  for (const [at, token] of tokens.entries()) {
    if (token === "--") break;
    if (token.startsWith("--no-")) negated.push({ flag: token.split("=")[0] as string, at });
    else kept.push({ token, at });
  }

  const { tokens: parsed = [] } = parseArgs({
    args: kept.map(({ token }) => token),
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const flags: { flag: string; at: number }[] = [...negated];
  let firstPositional = -1;
  for (const token of parsed) {
    const at = (kept[token.index] as { at: number }).at;
    if (token.kind === "option") flags.push({ flag: token.rawName, at });
    else if (token.kind === "positional" && firstPositional === -1) firstPositional = at;
  }
  const own = dispatches ? flags.filter(({ at }) => firstPositional === -1 || at < firstPositional) : flags;
  return { flags: own.sort((left, right) => left.at - right.at).map(({ flag }) => flag), firstPositional };
}

/**
 * The first command on this invocation's path that was handed a flag it does not declare, or `null`.
 *
 * Walked the way citty dispatches: a command with subcommands owns the tokens before the first positional
 * and hands the rest to the subcommand that positional names; a command without them owns every token up
 * to `--`, on either side of its own positionals. So `pithy token --json mint` is `token` given `--json` — which it does not take, and citty would
 * have dropped on the floor — not `mint` given it.
 */
export async function undeclaredFlags(root: CommandDef, argv: readonly string[]): Promise<UndeclaredFlags | null> {
  let cmd = root;
  let tokens = argv;
  const path: string[] = [];

  for (;;) {
    const args = cmd.args === undefined ? {} : await resolve(cmd.args);
    const subCommands =
      cmd.subCommands === undefined ? undefined : ((await resolve(cmd.subCommands)) as Record<string, SubCommand>);
    const dispatches = subCommands !== undefined && Object.keys(subCommands).length > 0;
    const { flags, firstPositional } = scan(tokens, args, dispatches);

    // A dispatching command handed no name runs its `default` with every token, so the flags are the default's.
    if (dispatches && firstPositional === -1 && cmd.default !== undefined) {
      const name = await resolve(cmd.default);
      const next = await findSubCommand(subCommands, name);
      if (next === undefined) return null;
      cmd = next;
      continue;
    }

    const accepted = new Set([...flagsOf(args), ...GLOBAL_FLAGS]);
    const undeclared = flags.filter((flag) => !accepted.has(flag));
    if (undeclared.length > 0) {
      const declared = Object.entries(args)
        .filter(([, def]) => (def as { type?: string }).type !== "positional")
        .map(([name]) => `--${name}`);
      return { path, undeclared, declared };
    }

    if (!dispatches || firstPositional === -1) return null;
    const name = tokens[firstPositional] as string;
    const next = await findSubCommand(subCommands, name);
    // An unknown name is citty's to refuse. It names it.
    if (next === undefined) return null;
    path.push(name);
    cmd = next;
    tokens = tokens.slice(firstPositional + 1);
  }
}

/**
 * Refuse an invocation that hands a command a flag it does not declare, naming the flag on the problem
 * line and the command's real flags on the action line.
 *
 * A `ValidationError`, so it reaches the operator the way every other refusal does — through
 * `withErrorReporting`, as the problem/action lines or, under `--json`, as the one `{ error }` line — and
 * each flag is an issue with Zod's own code for an unexpected key, which is what it is.
 */
export async function refuseUndeclaredFlags(root: CommandDef, argv: readonly string[]): Promise<void> {
  const found = await undeclaredFlags(root, argv);
  if (found === null) return;
  const command = `\`${["pithy", ...found.path].join(" ")}\``;
  const plural = found.undeclared.length > 1;
  throw new ValidationError({
    message: `Unknown flag${plural ? "s" : ""}: ${found.undeclared.join(", ")}.`,
    // A command with none of its own still takes the global ones, so "no flags" would be wrong (#697).
    action:
      found.declared.length === 0
        ? `${command} takes only the global flags, which \`pithy schema --json\` lists.`
        : `${command} takes ${found.declared.join(", ")}.`,
    issues: found.undeclared.map((flag) => ({
      path: [flag],
      code: "unrecognized_keys",
      message: `${command} does not declare ${flag}.`,
    })),
  });
}

/**
 * Whether the invocation asked for `--json`, so a refusal answers in the shape the caller will parse.
 *
 * Read off the raw tokens rather than off a parse, because the refusal is exactly the case where the parse
 * is in question: `pithy doctor --json --bogus` asked for one machine-readable line, and gets it. Read as citty
 * reads it (`booleanToken.ts`), so a refusal and the command it refuses never disagree about the shape:
 * `--json --no-json` is a text run.
 */
export function asksForJson(argv: readonly string[]): boolean {
  return readBooleanToken(argv, "json").value === true;
}

/**
 * The first `--<name>` token citty would read other than as it is written, or `undefined`: a value that is neither
 * `true` nor `false`, which citty reads as on, or `--no-<name>=<value>`, which citty does not read at all.
 */
function misreadToken(argv: readonly string[], name: string): string | undefined {
  const read = readBooleanToken(argv, name);
  return read.negatedValue ?? read.malformed;
}

/** The refusal for a token {@link misreadToken} found, naming the four spellings that are read as written. */
function misreadRefusal(token: string, name: string): ValidationError {
  const [typed] = token.split("=") as [string];
  return new ValidationError({
    message: `${token} is not a spelling --${name} takes.`,
    action: `Write --${name}, --no-${name}, --${name}=true or --${name}=false.`,
    issues: [{ path: [typed], code: "invalid_value", message: `--${name} takes true or false.` }],
  });
}

/**
 * Refuse a `--json` spelling citty would read other than as written (#697 review). `--json=maybe` is on to citty and
 * `--no-json=false` is nothing to it, so a run that let either through would answer a question nobody asked.
 */
export function refuseJsonFlag(argv: readonly string[]): void {
  const token = misreadToken(argv, "json");
  if (token !== undefined) throw misreadRefusal(token, "json");
}

/**
 * Refuse a `--pretty` / `--no-pretty` that cannot mean anything: a malformed value, or no `--json`.
 *
 * **`--pretty` formats the `--json` line and changes nothing else**, so without `--json` it changes
 * nothing at all — and a flag that silently does nothing is the same ambient surprise the whole feature
 * exists to close. `pithy remove --pretty` lands here too: `remove` is the one command with no `--json`
 * at all (docs/CLI.md §1.2), so the rule that covers every other command covers it without knowing its
 * name.
 *
 * **`--no-pretty` is held to the same rule.** It is the same flag with the opposite answer, and nothing
 * about the reasoning changes. Anyone wanting one setting for a whole session sets `PITHY_JSON`, which
 * is what that variable is for; a flag in a shell alias would be asking every non-`--json` command in
 * the session to ignore it.
 *
 * **The value is checked first**, because it is the more specific mistake: `--pretty=maybe` is a typo,
 * and reporting the pairing rule at it would send the operator to fix the wrong thing.
 *
 * **Here rather than in `rootFlags.ts`**, which declares the flags: the rule needs {@link asksForJson},
 * and `rootFlags.ts` is what this module imports. One direction only, or the two files are a cycle.
 */
export function refusePrettyFlags(argv: readonly string[]): void {
  const malformed = malformedPrettyFlag(argv);
  if (malformed !== undefined) {
    const [name] = malformed.split("=") as [string];
    throw new ValidationError({
      message: `${malformed} is not a value ${name} takes.`,
      action: `Write ${name} on its own, or ${name}=true or ${name}=false.`,
      issues: [{ path: [name], code: "invalid_value", message: `${name} takes true or false.` }],
    });
  }
  const asked = wantsPretty(argv);
  if (asked === undefined || asksForJson(argv)) return;
  const flag = asked ? "--pretty" : "--no-pretty";
  throw new ValidationError({
    message: `${flag} needs --json. It formats that line and nothing else.`,
    action: `Add --json, or drop ${flag}.`,
    issues: [{ path: [flag], code: "unrecognized_keys", message: `${flag} is only read alongside --json.` }],
  });
}

/** Whether the invocation asked for `--events`, read as citty reads it (`booleanToken.ts`). */
function asksForEvents(argv: readonly string[]): boolean {
  return readBooleanToken(argv, "events").value === true;
}

/**
 * Refuse `--events` without `--json`, or with a value it cannot mean (#697).
 *
 * **`--events` turns the one `--json` document into a stream of progress records closed by it**, so without
 * `--json` there is no stream for it to shape — the same reasoning as {@link refusePrettyFlags}, and checked
 * in the same place, before anything runs. Only `deploy` and `provision` declare it; on every other command it
 * is refused as undeclared before this rule is asked. Their contracts publish the rule as a `requires` group.
 */
export function refuseEventsFlag(argv: readonly string[]): void {
  const read = readBooleanToken(argv, "events");
  // Not read at all by citty, whatever its value, so it is named as a spelling rather than as a value.
  if (read.negatedValue !== undefined) throw misreadRefusal(read.negatedValue, "events");
  if (read.malformed !== undefined) {
    const [name] = read.malformed.split("=") as [string];
    throw new ValidationError({
      message: `${read.malformed} is not a value ${name} takes.`,
      action: `Write ${name} on its own, or ${name}=true or ${name}=false.`,
      issues: [{ path: [name], code: "invalid_value", message: `${name} takes true or false.` }],
    });
  }
  if (!asksForEvents(argv) || asksForJson(argv)) return;
  throw new ValidationError({
    message: "--events needs --json.",
    action: "Add --json, or drop --events.",
    issues: [{ path: ["--events"], code: "unrecognized_keys", message: "--events is only read alongside --json." }],
  });
}

/**
 * Refuse a `--no-input` carrying a value it cannot mean (#697). `--no-input=1` quietly read as "not
 * typed" would leave a prompt open for the agent that typed it to stop one.
 *
 * Unlike `--pretty`, it needs no `--json`: forbidding prompts is a statement about the run, not about
 * a format. Here beside {@link refusePrettyFlags} for the same dependency direction.
 */
export function refuseNoInputFlag(argv: readonly string[]): void {
  const malformed = malformedNoInputFlag(argv);
  if (malformed === undefined) return;
  throw new ValidationError({
    message: `${malformed} is not a value --no-input takes.`,
    action: "Write --no-input on its own, or --no-input=true or --no-input=false.",
    issues: [{ path: ["--no-input"], code: "invalid_value", message: "--no-input takes true or false." }],
  });
}
