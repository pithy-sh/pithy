// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArgsDef, CommandDef } from "citty";
import { contractOf } from "../contract/commandContract";

/**
 * **Every help screen below the root: citty's, with a positional that takes many words marked as one (#697).**
 *
 * citty prints a positional by its declared name in capitals — `pithy schema [COMMAND]` — and has no field
 * for "and every word after it". That reads as one word, while the page's synopsis says `[command…]` and
 * `pithy schema` publishes the positional `variadic`. So the renderer is handed a copy whose variadic
 * positional is named with the ellipsis the synopses use, and citty lays out the rest as it always has: the
 * column widths are computed on the marked name, so nothing is padded by hand. The parse never sees the
 * copy; the command keeps its declared name.
 *
 * Which positional is variadic is the contract's fact (`FlagFacts.variadic`), the one `pithy schema` reads,
 * so `--help` and the schema cannot answer the question two ways.
 */

/** The marker a variadic positional's name carries on a help screen: the synopses' own `…`. */
const VARIADIC = "…";

/** `cmd`, with each variadic positional renamed for the renderer, or `cmd` itself when it has none. */
async function markedForHelp(cmd: CommandDef): Promise<CommandDef> {
  const facts = contractOf(cmd)?.flags ?? {};
  const variadic = new Set(Object.keys(facts).filter((name) => facts[name]?.variadic === true));
  if (variadic.size === 0) return cmd;
  const declared = typeof cmd.args === "function" ? await cmd.args() : await cmd.args;
  const args: ArgsDef = {};
  for (const [name, def] of Object.entries(declared ?? {})) {
    args[variadic.has(name) && def.type === "positional" ? `${name}${VARIADIC}` : name] = def;
  }
  return { ...cmd, args };
}

/** The help screen for `cmd`, reached through `parent`. */
export async function renderCommandUsage(cmd: CommandDef, parent?: CommandDef): Promise<string> {
  const { renderUsage } = await import("citty");
  return renderUsage(await markedForHelp(cmd), parent);
}

/**
 * Print it, `showUsage`-shaped so `bin.ts` hands one function to both of citty's paths, and byte for byte
 * what citty's own `showUsage` prints: the screen and a blank line. `process.stdout.write`, never
 * `console.log` (`plugins/no-console.grit`). A screen that cannot be rendered is reported on stderr and the
 * run still ends, as citty's catch does.
 */
export async function showCommandUsage(cmd: CommandDef, parent?: CommandDef): Promise<void> {
  try {
    process.stdout.write(`${await renderCommandUsage(cmd, parent)}\n\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
