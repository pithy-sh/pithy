// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { format, stripVTControlCharacters } from "node:util";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ArgsDef, CommandDef } from "citty";
import { EXIT } from "./terminal/exitClass";
import { formatErrorJson } from "./terminal/output";

/**
 * **A command that names no action is asking what it can do. Answering it is a success.**
 *
 * That is the rule, stated once, for every level of the tree. `pithy` is somebody's first day; `pithy
 * secrets` is the same question one level down. Both are answered by a command list, and a command list
 * is the right answer, so neither is an error.
 *
 * citty disagrees, structurally. `runCommand` throws `E_NO_COMMAND` whenever a command declares
 * `subCommands`, receives no subcommand name, has no `default`, and has no `run` of its own — and
 * `runMain` catches every `CLIError` the same way: print the usage, echo the message, `process.exit(1)`.
 * So the bare invocation printed a complete command list and then said `No command specified.` under it,
 * arguing with a user it had just served, and exited non-zero — which fails `pithy && next`, fails a CI
 * step, and under `bun run` adds `error: script "pithy" exited with code 1` as the loudest and least
 * informative line on screen (#319).
 *
 * **One rule, one place.** Sixteen commands take that path — the root and fifteen groups — and giving
 * each of them a `run` would be fifteen producers of one rule, plus a subtlety that guarantees drift:
 * citty runs a parent's `run` *after* dispatching to a subcommand, so each would need to know whether it
 * had been dispatched through. This module answers the question before citty is asked, so a group added
 * next year inherits the rule with nothing to remember.
 *
 * What is **not** covered, deliberately: a name that is not a command. `pithy nonsense` is a mistake, not
 * a question, and citty's own `E_UNKNOWN_COMMAND` already names it, shows the help, and exits non-zero.
 * The walk stops at the first token it cannot resolve and hands the whole invocation back untouched.
 *
 * **Reaching that path requires the tree to answer only to the names it declares**, which an object
 * literal does not — see {@link ownNamesOnly}.
 */

/** A command and the parent it was reached through — what citty's `showUsage` takes. */
export interface UsageTarget {
  /** The command whose usage to render. */
  cmd: CommandDef;
  /** Its parent, so the rendered line reads `pithy secrets` rather than `secrets`. Absent at the root. */
  parent?: CommandDef;
}

/** citty's lazy subcommand value: a definition, a promise of one, or a thunk returning either. */
export type SubCommand = CommandDef | Promise<CommandDef> | (() => CommandDef | Promise<CommandDef>);

/** Resolve one of citty's three subcommand spellings to a definition. */
async function resolve(value: SubCommand): Promise<CommandDef> {
  return typeof value === "function" ? await value() : await value;
}

/**
 * The same command tree, answering only to the names it declares.
 *
 * A `subCommands` is an object literal, so `Object.prototype` is a member of every lookup at every level
 * — and citty resolves a subcommand with `name in subCommands`, then calls the value when it is a
 * function. `pithy valueOf` therefore called `Object.prototype.valueOf` with no receiver and died on a
 * raw `TypeError` under a crash banner, and `pithy constructor` called `Object`, took the `{}` it
 * returned for a command definition, ran nothing at all, and exited **0**. Neither name is a command.
 * Both belong on the path `pithy nonsense` takes.
 *
 * Copying each record onto a null prototype is the whole fix: an inherited name resolves to nothing, and
 * citty's `E_UNKNOWN_COMMAND` names it and exits non-zero exactly as it does for a typo. Done here, once,
 * rather than at the twenty-seven `defineCommand` calls — the same reason the usage rule is: a group
 * added next year inherits it with nothing to remember. **Laziness survives**: a thunk is wrapped, never
 * called, so the imports this tree defers stay deferred until a name is actually walked into.
 */
export function ownNamesOnly(cmd: CommandDef): CommandDef {
  const declared = cmd.subCommands;
  if (declared === undefined) return cmd;
  return {
    ...cmd,
    subCommands: async () => {
      const subCommands = (typeof declared === "function" ? await declared() : await declared) as Record<
        string,
        SubCommand
      >;
      const own: Record<string, SubCommand> = Object.create(null);
      for (const [name, value] of Object.entries(subCommands))
        own[name] = async () => ownNamesOnly(await resolve(value));
      return own;
    },
  } as CommandDef;
}

/**
 * Find a subcommand by the name the user typed, matching citty's own lookup: the key first, then any
 * command whose `meta.alias` claims the name.
 *
 * **The key is an own name or it is not a name.** `subCommands[name]` alone answers `valueOf` and
 * `constructor` with `Object.prototype`'s members, which is the hole {@link ownNamesOnly} closes for
 * citty; this walk states the same rule for itself, because it is exported and takes any `CommandDef` —
 * including one nobody hardened.
 *
 * Resolving every sibling to read its alias costs the lazy imports this tree exists to avoid, so the key
 * is tried first and the alias scan only runs when it misses — which is the miss path already, and the
 * path that ends in "unknown command" either way.
 */
export async function findSubCommand(
  subCommands: Record<string, SubCommand>,
  name: string,
): Promise<CommandDef | undefined> {
  const direct = Object.hasOwn(subCommands, name) ? subCommands[name] : undefined;
  if (direct !== undefined) return resolve(direct);
  for (const value of Object.values(subCommands)) {
    const candidate = await resolve(value);
    const meta = typeof candidate.meta === "function" ? await candidate.meta() : await candidate.meta;
    const alias = meta?.alias;
    if (alias === name || (Array.isArray(alias) && alias.includes(name))) return candidate;
  }
  return undefined;
}

/** Whether a command can act on its own — through its own `run`, or by defaulting to a subcommand. */
function actsOnItsOwn(cmd: CommandDef): boolean {
  return typeof cmd.run === "function" || cmd.default !== undefined;
}

/**
 * The command whose usage answers this invocation, or `null` when the invocation names an action and
 * belongs to citty.
 *
 * Flags are skipped rather than resolved: only commands that dispatch are walked into, and a dispatching
 * command in this tree declares no `args` of its own, so the only flag that reaches this walk is one every
 * command takes (`--help`). A flag a group does not declare never gets here — `bin.ts` refuses it first
 * (`declaredFlags.ts`), so `pithy token --json` is a mistake named, not a question answered. The walk
 * stops the moment a token resolves to nothing, so an unknown command reaches citty exactly as before.
 */
export async function usageTarget(root: CommandDef, argv: readonly string[]): Promise<UsageTarget | null> {
  let cmd = root;
  let parent: CommandDef | undefined;

  for (const token of argv) {
    if (token.startsWith("-")) continue;
    const subCommands = (typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands) as
      | Record<string, SubCommand>
      | undefined;
    if (!subCommands) return null;
    const next = await findSubCommand(subCommands, token);
    // An unknown name is a mistake, not a question. Hand it back — citty names it and exits non-zero.
    if (!next) return null;
    parent = cmd;
    cmd = next;
  }

  const subCommands = (typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands) as
    | Record<string, SubCommand>
    | undefined;
  if (!subCommands || Object.keys(subCommands).length === 0) return null;
  if (actsOnItsOwn(cmd)) return null;
  return parent === undefined ? { cmd } : { cmd, parent };
}

/**
 * **The subcommand this invocation dispatched to, or `undefined`** — the question a parent with its own
 * `run` has to ask before doing anything.
 *
 * citty runs a parent's `run` *after* dispatching: `runCommand` resolves `subCommands`, hands the
 * remaining tokens to the one the first positional names, and then falls through to
 * `if (typeof cmd.run === "function")`. For the fifteen groups in this tree that costs nothing, because
 * none of them has a `run` — this module's header is why. `pithy dev` is the first command where bare
 * `run` does real work *and* `subCommands` exists, so without this guard `pithy dev logs` would print
 * its table and then start a full dev session: every worker spawned, every pinned port bound, and every
 * log file truncated moments after it was read.
 *
 * **Indexed citty's way, not by a second parser.** `findSubCommandIndex` skips flags, and skips the token
 * after one that is a declared string or enum flag — so `pithy dev --app api logs` dispatches on `logs`
 * and not on `api`. Asking a different question than citty asks is how a guard comes to be true for
 * every invocation but one.
 */
export function dispatchedSubCommand(
  rawArgs: readonly string[],
  args: ArgsDef,
  names: readonly string[],
): string | undefined {
  const index = subCommandIndex(rawArgs, args);
  if (index === -1) return undefined;
  const token = rawArgs[index] as string;
  return names.includes(token) ? token : undefined;
}

/**
 * Where the first positional sits, citty's way: flags skipped, the token after a declared string or enum
 * flag skipped with it, and nothing past `--`. `-1` when there is none.
 */
function subCommandIndex(rawArgs: readonly string[], args: ArgsDef): number {
  const takesValue = new Set<string>();
  for (const [name, def] of Object.entries(args)) {
    const arg = def as { type?: string; alias?: unknown };
    if (arg.type !== "string" && arg.type !== "enum") continue;
    takesValue.add(name);
    const alias = arg.alias;
    for (const value of typeof alias === "string" ? [alias] : Array.isArray(alias) ? alias : []) {
      if (typeof value === "string") takesValue.add(value);
    }
  }
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i] as string;
    if (token === "--") return -1;
    if (token.startsWith("-")) {
      if (!token.includes("=") && takesValue.has(token.replace(/^-{1,2}/, ""))) i++;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * The deepest command these tokens name, and its parent — the usage a refusal is shown beside.
 *
 * citty's `resolveSubCommand`, which it does not export: walk while the first positional names a
 * subcommand, and stop at the last one known. So `pithy secrets nonsense` is answered with `pithy secrets`'
 * usage, and `pithy nonsense` with the root's.
 */
export async function commandAt(root: CommandDef, argv: readonly string[]): Promise<UsageTarget> {
  let cmd = root;
  let parent: CommandDef | undefined;
  let rest = [...argv];
  for (;;) {
    const subCommands = (typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands) as
      | Record<string, SubCommand>
      | undefined;
    if (!subCommands || Object.keys(subCommands).length === 0) break;
    const args = (typeof cmd.args === "function" ? await cmd.args() : await cmd.args) ?? {};
    const index = subCommandIndex(rest, args);
    if (index === -1) break;
    const next = await findSubCommand(subCommands, rest[index] as string);
    if (!next) break;
    parent = cmd;
    cmd = next;
    rest = rest.slice(index + 1);
  }
  return parent === undefined ? { cmd } : { cmd, parent };
}

/** What {@link runTree} needs from its caller. */
export interface RunTreeOptions {
  /** Whether the invocation asked for `--json`: a refusal is then the one error line, not a usage screen. */
  json: boolean;
  /** Render a command's usage — the root's screen or citty's, as `bin.ts` decides. */
  showUsage: (cmd: CommandDef, parent?: CommandDef) => Promise<void>;
  /** Run the tree. citty's `runCommand`; a test hands its own. */
  run?: (cmd: CommandDef, options: { rawArgs: string[] }) => Promise<unknown>;
}

/** Whether `error` is citty's own usage refusal. Its `CLIError` class is not exported, so it is known by name. */
function isCittyUsageError(error: unknown): error is Error {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "CLIError";
}

/**
 * **Run the tree, and exit 2 when citty refuses the call (#697).**
 *
 * citty's `runMain` is this plus one decision this kit makes differently: it catches every `CLIError` — an
 * unknown command, a missing positional — into usage, the message and `process.exit(1)`, the code that now
 * means *unclassified*. A call citty could not parse is a usage error, so it exits 2 like every other.
 * Under `--json` the refusal is the `validation/invalid_input` error line, so a caller parsing stdout is not
 * handed a usage screen. Anything else is a crash and is printed whole with exit 1, as citty printed it.
 */
export async function runTree(root: CommandDef, argv: readonly string[], options: RunTreeOptions): Promise<void> {
  const run = options.run ?? (await import("citty")).runCommand;
  try {
    await run(root, { rawArgs: [...argv] });
  } catch (error) {
    if (!isCittyUsageError(error)) {
      process.stderr.write(`${format(error, "\n")}\n`);
      process.exit(EXIT.failed);
      return;
    }
    if (options.json) {
      const plain = stripVTControlCharacters(error.message).trim();
      const refusal = new ValidationError({
        message: /[.!?]$/.test(plain) ? plain : `${plain}.`,
        action: "Run pithy --help for the commands, or the command with --help for what it takes.",
      });
      process.stderr.write(`${formatErrorJson(refusal.payload)}\n`);
    } else {
      const target = await commandAt(root, argv);
      await options.showUsage(target.cmd, target.parent);
      process.stderr.write(`${error.message}\n`);
    }
    process.exit(EXIT.usage);
  }
}
