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
import { unsupportedNodeMessage } from "./nodeFloor";
import { wantsNoInput, wantsPretty, wantsVersion } from "./rootFlags";
import { exitQuietlyOnBrokenPipe } from "./terminal/brokenPipe";
import { colorEnabled, colorForced } from "./terminal/style";

// Before anything is imported or read, so the refusal costs nothing and cannot itself fail on an old
// runtime. The rule lives in `nodeFloor.ts` because this file cannot be tested — see `rootFlags.ts`.
//
// Exit 3, a precondition (`terminal/exitClass.ts`): the call is fine and the runtime is not. A literal
// rather than `EXIT.precondition`, because importing that table is exactly what this line runs ahead of.
const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported !== null) {
  process.stderr.write(unsupported);
  process.exit(3);
}

// A reader that closes the pipe early — `pithy schema --json | head` — ends the run quietly, exit 141, rather
// than with an unhandled EPIPE stack trace (#697). Both streams: `2>&1 | head` closes stderr's pipe too.
exitQuietlyOnBrokenPipe(process.stdout);
exitQuietlyOnBrokenPipe(process.stderr);

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

const { main } = await import("./main");
const { ownNamesOnly, runTree, usageTarget } = await import("./dispatch");
const { asksForJson, refuseEventsFlag, refuseJsonFlag, refuseNoInputFlag, refusePrettyFlags, refuseUndeclaredFlags } =
  await import("./declaredFlags");
const { JSON_MODE_ENV, jsonStreams } = await import("./terminal/jsonMode");
const { latchInputMode, NONINTERACTIVE_ENV, resolveInputForbidden } = await import("./terminal/inputMode");
const { latchJsonFormat, withErrorReporting } = await import("./terminal/output");

/**
 * One tree, for every reader below and for citty, answering only to the names it declares.
 *
 * citty resolves a subcommand with `name in subCommands`, so an object literal answered `valueOf`,
 * `constructor` and every other `Object.prototype` member — with a raw `TypeError` for one and a
 * silent exit 0 for another. Hardened here rather than at each `defineCommand`, and hardened *before*
 * any walk so every reader sees the same tree. See `dispatch.ts`.
 */
const root = ownNamesOnly(main);

/**
 * **Every flag is one its command declares, and this is the one place that is checked (#594).**
 *
 * First, before anything answers the invocation: before `--version` and the hidden root flags, which would
 * otherwise print and exit 0 over `pithy doctor --dry-rn --version`, and before citty, which parses an
 * undeclared flag without a word — and whose own argument errors would otherwise win the race and print
 * usage into the stdout a `--json` caller is parsing. Those flags are themselves declared on every command,
 * so asking for them is never refused. See `declaredFlags.ts`.
 *
 * **The `--json` mode is latched first, inside the same reporting**, so both refusals below print in the
 * shape the operator asked for rather than in whatever shape the module happened to be left in.
 * `jsonModes` throws on an unrecognized `PITHY_JSON`, and that one refusal cannot honor the mode it is
 * refusing — nothing is latched, so it reports compact, which is the safe direction.
 *
 * **Both streams are read here, and nowhere else.** `process` belongs to the bin; the rule is a pure
 * function of what the bin hands it (`terminal/jsonMode.ts`), which is what lets the whole env × flag ×
 * isTTY matrix be asked in a test runner that has no terminal at all. The color seam is handed over
 * the same way, as its two latched bits, so a stream that is not a terminal is never painted.
 *
 * `refusePrettyFlags` is after the undeclared-flag check on purpose: a typo in a safety flag is
 * the more urgent of the two things `pithy secrets rotate API_KEY --dry-rn --pretty` got wrong.
 * `refuseEventsFlag` is beside it, for the same pairing with `--json` (#697). `refuseJsonFlag` is ahead of both:
 * every one of these flags is read by the one rule in `booleanToken.ts`, which is citty's, and a `--json` spelling
 * citty would read other than as written is refused before anything is decided on it.
 *
 * **Whether this run may prompt is latched here too, and nowhere else (#697).** `PITHY_NONINTERACTIVE=1`,
 * `--no-input` and `--json` each forbid it; `terminal/inputMode.ts` is the rule and the one seam every
 * command reads. Latched before the flag checks, so an unrecognized `PITHY_NONINTERACTIVE` is refused
 * before any command can reach a question — and refused in the `--json` shape, which is latched first.
 * Only the forbidden bit is latched; whether a terminal is attached is read when a command asks.
 */
await withErrorReporting(asksForJson(argv), async () => {
  latchJsonFormat(
    jsonStreams({
      env: process.env[JSON_MODE_ENV],
      pretty: wantsPretty(argv),
      color: colorEnabled(),
      forced: colorForced(),
      stdout: Boolean(process.stdout.isTTY),
      stderr: Boolean(process.stderr.isTTY),
    }),
  );
  latchInputMode(
    resolveInputForbidden({
      env: process.env[NONINTERACTIVE_ENV],
      noInput: wantsNoInput(argv),
      json: asksForJson(argv),
    }),
  );
  await refuseUndeclaredFlags(root, argv);
  refuseJsonFlag(argv);
  refusePrettyFlags(argv);
  refuseEventsFlag(argv);
  refuseNoInputFlag(argv);
});

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
  const { showRootUsage } = await import("./help/rootUsage");
  const { showCommandUsage } = await import("./help/commandUsage");

  /**
   * Ours at the root, citty's everywhere below it — and handed to *both* places a root screen comes from.
   * Below the root it is citty's layout with a variadic positional marked `[NAME…]` (`help/commandUsage.ts`).
   *
   * `usageTarget` is one of them. The other is a refusal: `runTree` answers a citty `CLIError` with the
   * usage of the deepest command the tokens name (`commandAt`), which is the root for a name it cannot
   * resolve — so `pithy nonsense` prints the *root* screen. `--help` goes through citty's `runMain`, which
   * resolves the same way. Wire only one and the CLI ships two root screens that drift, one of them
   * reachable only by making a mistake. `parent === undefined` is exactly the root at every call site.
   */
  const usageFor = async <T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>, parent?: CommandDef<T>): Promise<void> =>
    parent === undefined ? showRootUsage(cmd) : showCommandUsage(cmd as CommandDef, parent as CommandDef);

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
  // `--help` is citty's builtin below the root, answered by `runMain` and exiting 0. Every other call runs
  // through `runTree`, which is `runMain`'s catch with the classified code: a call citty refuses exits 2.
  else if (argv.some((token) => token === "--help" || token === "-h")) await runMain(root, { showUsage: usageFor });
  else await runTree(root, argv, { json: asksForJson(argv), showUsage: usageFor });
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
  // Dropped deliberately, and `void` says so. The promise it hands back exists for a caller that wants to
  // know when the state write landed (#658); this one does not — awaiting here would hold the process for
  // a notice, which is the one thing the notifier must never do. The pending write keeps the event loop
  // alive on its own until it finishes.
  void runUpdateNotifier({ installedVersion: version });
}
