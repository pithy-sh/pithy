// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";

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
 * **One rule, one place.** Fourteen commands take that path — the root and thirteen groups — and giving
 * each of them a `run` would be fourteen producers of one rule, plus a subtlety that guarantees drift:
 * citty runs a parent's `run` *after* dispatching to a subcommand, so each would need to know whether it
 * had been dispatched through. This module answers the question before citty is asked, so a group added
 * next year inherits the rule with nothing to remember.
 *
 * What is **not** covered, deliberately: a name that is not a command. `pithy nonsense` is a mistake, not
 * a question, and citty's own `E_UNKNOWN_COMMAND` already names it, shows the help, and exits non-zero.
 * The walk stops at the first token it cannot resolve and hands the whole invocation back untouched.
 */

/** A command and the parent it was reached through — what citty's `showUsage` takes. */
export interface UsageTarget {
  /** The command whose usage to render. */
  cmd: CommandDef;
  /** Its parent, so the rendered line reads `pithy secrets` rather than `secrets`. Absent at the root. */
  parent?: CommandDef;
}

/** citty's lazy subcommand value: a definition, a promise of one, or a thunk returning either. */
type SubCommand = CommandDef | Promise<CommandDef> | (() => CommandDef | Promise<CommandDef>);

/** Resolve one of citty's three subcommand spellings to a definition. */
async function resolve(value: SubCommand): Promise<CommandDef> {
  return typeof value === "function" ? await value() : await value;
}

/**
 * Find a subcommand by the name the user typed, matching citty's own lookup: the key first, then any
 * command whose `meta.alias` claims the name.
 *
 * Resolving every sibling to read its alias costs the lazy imports this tree exists to avoid, so the key
 * is tried first and the alias scan only runs when it misses — which is the miss path already, and the
 * path that ends in "unknown command" either way.
 */
async function findSubCommand(subCommands: Record<string, SubCommand>, name: string): Promise<CommandDef | undefined> {
  const direct = subCommands[name];
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
 * command in this tree declares no `args` of its own, so a leading `-` is a builtin (`--help`,
 * `--version`) or a flag for a group that has none. The walk stops the moment a token resolves to
 * nothing, so an unknown command reaches citty exactly as before.
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
