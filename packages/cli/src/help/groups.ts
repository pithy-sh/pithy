// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SubCommandsDef } from "citty";

/**
 * The groups the root help screen prints, in the order it prints them (#407).
 *
 * **A presentation grouping, and only that.** Nothing dispatches through it, no invocation carries a
 * group segment, and `pithy email provision` is still `pithy email provision`. Putting the group in the
 * command path would rename nine commands, add a segment to every doc page and every agent's call, and
 * buy a screen what a blank line already buys it. It is also not the same concept as `dispatch.test.ts`'s
 * groups — commands that declare subcommands and cannot act — and neither is derived from the other.
 *
 * **The group is declared on the command, not in a list beside it.** A second list of the command set is
 * a list that drifts, and the drift has a direction that matters: a command added to the tree and
 * forgotten here would not break, it would *disappear* — from the one screen whose whole job is to say
 * what the CLI can do. So `main.ts` carries `group` as a **required** field on every entry, this type is
 * what that field must be, and a command with no group or a misspelled one is a compile error rather
 * than something a test has to notice. There is no catch-all group, because there is nothing to catch.
 */
export const HELP_GROUP_ORDER = ["Project", "Develop", "Operate", "Capabilities", "Toolchain"] as const;

/** One of {@link HELP_GROUP_ORDER}. The type `main.ts`'s `group` field takes. */
export type HelpGroup = (typeof HELP_GROUP_ORDER)[number];

/**
 * How a command module is loaded — a thunk, so the tree stays as lazy as it was.
 *
 * Typed through citty's own `SubCommandsDef` rather than `CommandDef`. A command declares its own `args`,
 * so its type is `CommandDef<ThoseArgs>`, and `run` puts that parameter in contravariant position — which
 * makes `CommandDef<SpecificArgs>` unassignable to `CommandDef<ArgsDef>`. citty resolves this in the one
 * place it has to, on the element type of `subCommands`; this borrows that resolution instead of writing
 * a second one — `CittyCommand` lifts that element type out without this file naming `any` itself.
 * Keeping the `() => Promise<…>` wrapper is what still requires a thunk.
 */
type CittyCommand = Awaited<Extract<SubCommandsDef[string], Promise<unknown>>>;

export type CommandLoader = () => Promise<CittyCommand>;

/** One command in the root's registry: which group it prints under, and how to load it. */
export interface CommandEntry {
  /** The heading this command prints under. Required: that is the whole mechanism. */
  group: HelpGroup;
  /** The command module, imported on demand. */
  load: CommandLoader;
}
