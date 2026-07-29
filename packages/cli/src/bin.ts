#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { runMain } from "citty";
import { handleHiddenFlags } from "./commands/alias";
import { main } from "./main";
import { runUpdateNotifier } from "./notifier/notify";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const argv = process.argv.slice(2);

/**
 * The hidden root flags (`--pithier`, `--pithiest`) are handled before citty parses, since they are not
 * subcommand flags. When one is handled, the command is done — skip both the dispatch and the notifier.
 */
if (await handleHiddenFlags(argv)) {
  process.exit(0);
}

await runMain(main);

/**
 * The end-of-command update check (docs/CLI.md §5). Gated to an interactive terminal at the call site: a
 * piped/CI run (non-TTY) — every test that spawns this bin, and every scripted invocation — never touches
 * the network or the state file. `doctor` runs its own fresh check, so it does not also get the background
 * one. It is fire-and-forget and never delays exit.
 */
if (process.stderr.isTTY && !process.env.PITHY_NO_UPDATE_NOTIFIER && argv[0] !== "doctor") {
  runUpdateNotifier({ installedVersion: version });
}
