// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ArgsDef, CommandDef } from "citty";
import { HIDDEN_ROOT_FLAGS } from "./commands/alias";
import { findSubCommand, type SubCommand } from "./dispatch";
import { ROOT_FLAGS } from "./rootFlags";

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

/** One arg's declared aliases, in the spelling a caller types: a single letter takes one dash, a word takes two. */
function aliasFlags(alias: unknown): string[] {
  return aliasNames(alias).map((name) => (name.length === 1 ? `-${name}` : `--${name}`));
}

/** One arg's declared aliases, bare. citty accepts a string or an array. */
function aliasNames(alias: unknown): string[] {
  const names = typeof alias === "string" ? [alias] : Array.isArray(alias) ? alias : [];
  return names.filter((name): name is string => typeof name === "string");
}

/**
 * The camelCase spelling of a kebab-case arg name, or the name unchanged when it has no dash.
 *
 * citty registers `camelCase(name)` and `kebabCase(name)` as aliases of **every** arg it parses, so
 * `--withPrerequisites` reaches the same value as `--with-prerequisites`. This transform is narrow on
 * purpose — it handles lowercase kebab and nothing else — and `docs/catalog.test.ts` holds every arg name
 * in the CLI to that shape, so the narrow version is complete rather than merely convenient. The kebab
 * direction is a no-op over that domain, which is why only this one exists.
 */
function camelSpelling(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/**
 * Every flag one command's parser answers to — what the docs catalog publishes, and what this check accepts.
 *
 * Three spellings beyond the declared name, each of them citty's rather than ours:
 *
 * - **Declared aliases**, long and short.
 * - **The camelCase form.** citty aliases every arg to its camel and kebab spellings, so
 *   `--withPrerequisites` works.
 * - **`--no-<name>` on a boolean.** citty strips a `--no-` prefix from any argument before parsing, and
 *   this CLI documents the result: `ui.ts`'s own description offers `--no-auth for the bare SPA`, and
 *   `docs/commands/ui.md` puts `[--auth | --no-auth]` in its synopsis. Booleans only: citty would also
 *   answer `--no-env`, but that is a quirk of its parser, not a flag anybody declared, so it is refused.
 *
 * A **positional** is not a flag and is left out: it carries no `--`.
 */
export function flagsOf(args: ArgsDef | undefined): string[] {
  const flags: string[] = [];
  for (const [name, def] of Object.entries(args ?? {})) {
    const arg = def as { type?: string; alias?: unknown };
    if (arg.type === "positional") continue;
    flags.push(`--${name}`);
    const camel = camelSpelling(name);
    if (camel !== name) flags.push(`--${camel}`);
    flags.push(...aliasFlags(arg.alias));
    if (arg.type === "boolean") flags.push(`--no-${name}`);
  }
  return flags;
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

/** Where one command's own tokens end, and which of them are flags. */
interface Scan {
  /** Every flag token, as typed and without any `=value`. */
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
 */
function scan(tokens: readonly string[], args: ArgsDef): Scan {
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
  const own = flags.filter(({ at }) => firstPositional === -1 || at < firstPositional);
  return { flags: own.sort((left, right) => left.at - right.at).map(({ flag }) => flag), firstPositional };
}

/**
 * The first command on this invocation's path that was handed a flag it does not declare, or `null`.
 *
 * Walked the way citty dispatches: a command with subcommands owns the tokens before the first positional
 * and hands the rest to the subcommand that positional names; a command without them owns every token up
 * to `--`. So `pithy token --json mint` is `token` given `--json` — which it does not take, and citty would
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
    const { flags, firstPositional } = scan(tokens, args);

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
    action:
      found.declared.length === 0 ? `${command} takes no flags.` : `${command} takes ${found.declared.join(", ")}.`,
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
 * is in question: `pithy doctor --json --bogus` asked for one machine-readable line, and gets it.
 */
export function asksForJson(argv: readonly string[]): boolean {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  return flags.some((token) => token === "--json" || (token.startsWith("--json=") && token !== "--json=false"));
}
