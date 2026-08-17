// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArgsDef, CommandDef } from "citty";
import { COMMAND_REGISTRY } from "../main";
import { bold, cyan, dim, heading } from "../terminal/style";
import { HELP_GROUP_ORDER } from "./groups";

/**
 * The root help screen — the one screen of help Pithy renders rather than hosts (#407).
 *
 * citty listed twenty-six commands in declaration order under one heading, behind a `USAGE` line that
 * alternated every name before a single description appeared. Nothing on it said `email`, `media` and
 * `turnstile` are the same kind of thing and `deploy` is not, and the list only grows: every capability
 * that lands adds a row. So the root screen groups them, and every screen below it stays citty's.
 *
 * **Only the root.** `pithy add --help`, `pithy secrets`, and the screen after an unknown name one level
 * down are citty's `renderUsage`, byte for byte — §4.2's transcript is pinned against it. The seam is
 * `parent === undefined`, which `dispatch.ts` establishes is true of the root and nothing else.
 *
 * **The grouping is read off the command registry, not off a table beside it.** `main.ts` declares every
 * command with a required `group`, so there is no ungrouped state to render and no second list to drift
 * from the first — see `groups.ts`. A group with no members prints no heading rather than an empty one.
 *
 * **The shapes are citty's on purpose.** Same right-aligned name column, same four-space gutter, same
 * closing pointer. The two screens sit one keystroke apart, and a root screen that repainted itself
 * would read as a different program. What changes is the grouping and the `USAGE` line.
 *
 * **Nothing here reads the terminal.** No `process.stdout.columns`, no `COLUMNS`: the layout is a pure
 * function of the command tree, which is what lets `binDocs.test.ts` pin the whole screen byte for byte
 * against `docs/CLI.md` §4.1 and get the same answer on every machine.
 *
 * **Color goes through `terminal/style.ts` and nowhere else** (docs/CLI.md §3.4). That is also the whole
 * mechanism behind §4.3's claim that piped root help is plain: `bin.test.ts` asserts no escape byte with
 * every color signal scrubbed, and an escape byte under `FORCE_COLOR`, and only the seam satisfies both.
 */

/** Two spaces of indent, then the name column, then the gutter — citty's `formatLineColumns` shape. */
const INDENT = "  ";
const GUTTER = "    ";

/** A resolved subcommand: the label its row prints, and every name the `USAGE` line must list. */
interface Entry {
  /** The row's left column — the name, plus any aliases, comma-joined. citty's rule. */
  label: string;
  /** The command's own name, for grouping. */
  name: string;
  /** `meta.description`, or empty when it declares none. */
  description: string;
}

/** citty allows `meta` to be a value, a promise, or a thunk. Resolve all three the way it does. */
async function resolve<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/** Everything citty would put in the `COMMANDS` block, resolved from the lazy tree, in declaration order. */
async function entries<T extends ArgsDef>(cmd: CommandDef<T>): Promise<Entry[]> {
  const subCommands = await resolve(cmd.subCommands);
  if (subCommands === undefined) return [];
  const resolved = await Promise.all(
    Object.entries(subCommands).map(async ([name, value]) => {
      const sub = await resolve(value as CommandDef | (() => Promise<CommandDef>));
      const meta = (await resolve(sub.meta)) ?? {};
      // `hidden` is skipped from the rows *and* from the USAGE line — citty's `continue` precedes its
      // own `commandNames.push`. Nothing declares it today; the rule is preserved rather than dropped.
      if (meta.hidden === true) return null;
      const alias = meta.alias === undefined ? [] : Array.isArray(meta.alias) ? meta.alias : [meta.alias];
      return { label: [name, ...alias].join(", "), name, description: meta.description ?? "" };
    }),
  );
  return resolved.filter((entry): entry is Entry => entry !== null);
}

/**
 * The whole screen, as one string with no trailing newline.
 *
 * A pure function of the tree so a test can call it without spawning anything, and so the byte-for-byte
 * pin has one thing to compare. Exported for `rootUsage.test.ts`; `bin.ts` goes through {@link showRootUsage}.
 */
export async function renderRootUsage<T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>): Promise<string> {
  const meta = (await resolve(cmd.meta)) ?? {};
  const name = meta.name ?? "pithy";
  const found = await entries(cmd);

  // Width is the widest label across every command, not per group: the columns line up down the whole
  // screen, which is what makes it read as one table with headings rather than five small ones.
  const width = found.reduce((max, entry) => Math.max(max, entry.label.length), 0);

  const lines: string[] = [
    dim(`${meta.description ?? ""} (${name}${meta.version === undefined ? "" : ` v${meta.version}`})`),
    "",
    // No alternation. Twenty-six names before the first description was never information, and the line
    // was already wider than a terminal.
    `${bold("USAGE")} ${cyan(`${name} <command> [OPTIONS]`)}`,
    "",
    bold("COMMANDS"),
  ];

  const row = (entry: Entry): string =>
    // Pad the plain label and colorize after. citty pads the already-colored string; the visible result
    // is identical and the plain bytes — the only ones pinned — are identical too.
    `${INDENT}${" ".repeat(width - entry.label.length)}${cyan(entry.label)}${GUTTER}${entry.description}`;

  for (const group of HELP_GROUP_ORDER) {
    // Registry order inside a group, which is `main.ts`'s declaration order — the file is written in the
    // order this prints, so the screen and the registry read the same way down the page.
    const members = found.filter((entry) => COMMAND_REGISTRY[entry.name]?.group === group);
    if (members.length === 0) continue;
    lines.push("", `${INDENT}${heading(group)}`);
    for (const entry of members) lines.push(row(entry));
  }

  lines.push("", `Use ${cyan(`${name} <command> --help`)} for more information about a command.`);
  return lines.join("\n");
}

/**
 * Print the root screen. `showUsage`-shaped so `bin.ts` can hand one function to both of citty's paths.
 *
 * `process.stdout.write` rather than `console.log`: `plugins/no-console.grit` covers `packages/*​/src/**`
 * and citty's own `showUsage` is a `console.log`, so copying it would fail the Lint job.
 */
export async function showRootUsage<T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>): Promise<void> {
  // Caught for the same reason citty catches in its own `showUsage`, and it matters more here: this is
  // installed as `runMain`'s `showUsage`, so it runs *inside* citty's `CLIError` handler. Rendering
  // resolves all twenty-six command modules, and a module that rejects at import would throw out of that
  // handler — turning `pithy` and `pithy nonsense` into an unhandled-rejection stack instead of a help
  // screen, which is the crash-banner failure #329 removed. stderr, and the run still ends.
  try {
    process.stdout.write(`${await renderRootUsage(cmd)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
