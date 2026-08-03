#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
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

  const { runMain } = await import("citty");
  const { main } = await import("./main");
  await runMain(main);
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
