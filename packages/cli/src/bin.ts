#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// **`node`, and the manifest's `bin` points at the built `dist/bin.js` rather than at this file (#474).**
// It was `bun`, and `bin` was `./src/bin.ts` — so `pithy` installed for everyone and started for
// nobody without Bun: `/usr/bin/env: 'bun': No such file or directory`. That contradicts the rule this
// repository states for itself, and it is the CLI, which is the one package an adopter runs.
//
// Bun was never a runtime this code needs — nothing under `src` uses a `Bun.*` API or imports from
// `bun:`; it was doing one job, loading TypeScript. #476 gave every package a build, so that job is
// gone and the shebang is the only thing that was still asking for it.
//
// `node` rather than a `bun`-else-`node` dispatcher: a dispatcher needs a Node-runnable build for its
// fallback anyway, a `#!/bin/sh` shim breaks on Windows where npm generates `.cmd` and `.ps1` wrappers
// from this file, and a branch that can be wrong is worse than an artifact that cannot be. Bun runs
// plain JavaScript, so one shebang serves everyone.
//
// The line stays here, in the source, because that is where tsdown reads it from and copies it to the
// emitted entry.

import { readFileSync } from "node:fs";
// Type-only, so it is erased and does not reach citty at runtime — the import discipline below the
// `NO_COLOR` line is about evaluation order, and an erased import has none.
import type { ArgsDef, CommandDef } from "citty";
import { wantsVersion } from "./rootFlags";
import { colorEnabled } from "./terminal/style";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const argv = process.argv.slice(2);

/**
 * Hand citty the one color lever it reads, before it is loaded.
 *
 * citty renders its own help and consults none of Pithy's color rule — not `isTTY`, not `NO_COLOR` set to
 * any value, not `FORCE_COLOR`. It latches a single private flag at import time from
 * `NO_COLOR === "1" || TERM === "dumb" || TEST || CI`. So `pithy --help | cat` used to write escape codes
 * into a pipe while every other Pithy surface went plain (docs/CLI.md §3.4).
 *
 * `terminal/style` stays the single authority: it has already latched its own decision by the time this
 * line runs, so mutating the environment now cannot change Pithy's own output — it only translates that
 * decision into the vocabulary citty understands.
 *
 * **One direction only.** When Pithy says color is off, citty is told so. The reverse — Pithy says on
 * (a TTY, or `FORCE_COLOR`) while citty suppresses because `CI` or `TERM=dumb` is set — is left alone.
 * Turning it back on would mean deleting `CI` from the environment of this process and every child
 * wrangler/bun it spawns, which is a far larger lie than plain help in a CI log. Leaking ANSI into a pipe
 * corrupts output someone is parsing; plain text never does.
 *
 * The variable is inherited by every child the CLI spawns (wrangler, bun), which is the right answer for
 * the same reason: if this run's output is being piped, so is theirs.
 *
 * Every import that reaches citty is therefore dynamic and below this line. Static imports are hoisted
 * and evaluated first, which would set this after citty had already decided.
 */
if (!colorEnabled()) process.env.NO_COLOR = "1";

if (wantsVersion(argv)) {
  // citty answers its version builtin only when it is the sole argument, so `pithy add --version` would
  // run `add`. docs/CLI.md §1.2 promises the flag works on any command; see `rootFlags.ts` for the rule.
  process.stdout.write(`${version}\n`);
} else {
  const { handleHiddenFlags } = await import("./commands/alias");
  /**
   * The hidden root flags (`--pithier`, `--pithiest`) are handled before citty parses, since they are not
   * subcommand flags. When one is handled, the command is done — skip both the dispatch and the notifier.
   */
  if (await handleHiddenFlags(argv)) {
    process.exit(0);
  }

  const { runMain, showUsage } = await import("citty");
  const { main } = await import("./main");
  const { ownNamesOnly, usageTarget } = await import("./dispatch");
  const { showRootUsage } = await import("./help/rootUsage");

  /**
   * One tree, for the walk and for citty, answering only to the names it declares.
   *
   * citty resolves a subcommand with `name in subCommands`, so an object literal answered `valueOf`,
   * `constructor` and every other `Object.prototype` member — with a raw `TypeError` for one and a
   * silent exit 0 for another. Hardened here rather than at each `defineCommand`, and hardened *before*
   * the walk so both readers see the same tree. See `dispatch.ts`.
   */
  const root = ownNamesOnly(main);

  /**
   * Ours at the root, citty's everywhere below it — and handed to *both* places a root screen comes from.
   *
   * `usageTarget` is one of them. The other is citty itself: `runMain` catches every `CLIError` into
   * `showUsage(...await resolveSubCommand(cmd, rawArgs))`, and `resolveSubCommand` answers `[root,
   * undefined]` for a name it cannot resolve — so `pithy nonsense` prints the *root* screen. Wire only
   * the first and the CLI ships two root screens that drift, one of them reachable only by making a
   * mistake. `parent === undefined` is exactly the root at both call sites (`dispatch.ts`).
   */
  const usageFor = async <T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>, parent?: CommandDef<T>): Promise<void> =>
    parent === undefined ? showRootUsage(cmd) : showUsage(cmd, parent);

  /**
   * A command that names no action is asking what it can do, so it is answered and the run succeeds.
   *
   * Before citty, because citty cannot be told otherwise: `runCommand` throws `E_NO_COMMAND` for the
   * root and for every group, and `runMain` catches it into usage + the message + `process.exit(1)`.
   * So bare `pithy` printed a complete command list and then said `No command specified.` under it,
   * exiting non-zero — which fails `pithy && next`, fails a CI step, and under `bun run` adds a line
   * naming a script rather than anything the user did (#319). `pithy nonsense` still reaches citty and
   * is still refused: an unrecognised name is a mistake, not a question. See `dispatch.ts`.
   */
  const usage = await usageTarget(root, argv);
  if (usage) await usageFor(usage.cmd, usage.parent);
  else await runMain(root, { showUsage: usageFor });
}

/**
 * The end-of-command update check (docs/CLI.md §5). Gated to an interactive terminal at the call site: a
 * piped/CI run (non-TTY) — every test that spawns this bin, and every scripted invocation — never touches
 * the network or the state file. `doctor` runs its own fresh check, so it does not also get the background
 * one. It is fire-and-forget and never delays exit. Imported dynamically like everything else below the
 * color line: the notifier does not reach citty today, and a later edit that made it should not silently
 * put citty's import back above the one line that has to run first.
 */
if (process.stderr.isTTY && !process.env.PITHY_NO_UPDATE_NOTIFIER && argv[0] !== "doctor") {
  const { runUpdateNotifier } = await import("./notifier/notify");
  runUpdateNotifier({ installedVersion: version });
}
