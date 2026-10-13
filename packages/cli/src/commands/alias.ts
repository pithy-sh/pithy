// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { appendToRcFile, readRcFile, removeFromRcFile } from "../platform/rc";
import { detectShell } from "../platform/shell";
import { formatJsonLine, withErrorReporting } from "../terminal/output";

/** Marker comments that delimit the block `--remove` finds and deletes. Universal `#` comment syntax. */
const MARKER_OPEN = `# >>> ${commandName("alias")} >>>`;
const MARKER_CLOSE = `# <<< ${commandName("alias")} <<<`;

/** What we print for an unknown shell, and the `alias` key in that JSON — the plain POSIX form. */
const DEFAULT_ALIAS = "alias p.='pithy'";

/** Options every alias entry point accepts: suppress human chatter, or emit machine-readable JSON. */
export interface AliasOptions {
  /** Suppress the "Already pithy." line (used by the silent `pithy init` install). */
  silent?: boolean;
  /** Emit one JSON line instead of human text. */
  json?: boolean;
}

/** What an alias payload says was being attempted — the discriminant every one of them leads with. */
type AliasAction = "install" | "remove" | "status";

/**
 * Print one JSON line to stdout, led by the two keys every payload in this CLI carries.
 *
 * `command` is here rather than at each call site because this command's payloads are the only ones that
 * were written without it, and a helper is the one place that cannot be forgotten on the next path added.
 * `action` is the discriminant: alias has no subcommands, so it is what tells `install` from `remove` from
 * `status`, and a payload without it is a line a consumer cannot classify (#231).
 */
function emitJson(action: AliasAction, payload: Record<string, unknown>): void {
  process.stdout.write(`${formatJsonLine({ command: "alias", action, ...payload })}\n`);
}

/** Print one human line (with trailing newline) to stdout. */
function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The unknown-shell path: we never write to an rc file we don't recognize. Print the alias line and how
 * to add it by hand, then return cleanly (exit 0).
 *
 * **The action is a parameter because the payload has to name it.** Both `installAlias` and `removeAlias`
 * end here, and the payload used to say only that a shell was not detected — so the one path where
 * nothing was written to any file was the one path a consumer keying on `action` could not classify. It
 * is the case that most needs detecting: the command exited 0 and changed nothing.
 */
function logManualInstructions(action: Extract<AliasAction, "install" | "remove">, opts: AliasOptions): void {
  if (opts.json) {
    emitJson(action, { shell: null, manual: true, alias: DEFAULT_ALIAS });
    return;
  }
  emit("Couldn't detect your shell.");
  emit(`Add \`${DEFAULT_ALIAS}\` to your shell config to use \`p.\`.`);
}

/** True when the rc contents already carry our block or a hand-added `alias p.=`. */
function alreadyInstalled(contents: string): boolean {
  return contents.includes(MARKER_OPEN) || /\balias\s+p\.\s*=/.test(contents);
}

/**
 * Install the `p.` alias into the detected shell's rc file. Idempotent: a second run detects the existing
 * block (or a hand-added `alias p.=`) and writes nothing. Silent mode suppresses only the "Already pithy."
 * line — a fresh install still prints its confirmation.
 */
export async function installAlias(opts: AliasOptions = {}): Promise<void> {
  const shell = await detectShell();
  if (!shell) {
    logManualInstructions("install", opts);
    return;
  }

  const contents = await readRcFile(shell.rcPath);
  if (alreadyInstalled(contents)) {
    if (opts.json) {
      emitJson("install", {
        installed: true,
        alreadyInstalled: true,
        shell: shell.kind,
        rcPath: shell.rcPath,
        alias: shell.aliasSyntax,
      });
      return;
    }
    if (!opts.silent) emit("Already pithy.");
    return;
  }

  const block = [MARKER_OPEN, shell.aliasSyntax, MARKER_CLOSE].join("\n");
  await appendToRcFile(shell.rcPath, `\n${block}\n`);

  if (opts.json) {
    emitJson("install", {
      installed: true,
      alreadyInstalled: false,
      shell: shell.kind,
      rcPath: shell.rcPath,
      alias: shell.aliasSyntax,
    });
    return;
  }
  emit(`Added \`${shell.aliasSyntax}\` to ${shell.rcPath}`);
  emit(`Open a new terminal, or run: source ${shell.rcPath}`);
}

/** Remove the alias block. Prints `No Pithy alias installed.` and exits 0 when there is nothing to remove. */
export async function removeAlias(opts: AliasOptions = {}): Promise<void> {
  const shell = await detectShell();
  if (!shell) {
    logManualInstructions("remove", opts);
    return;
  }

  const removed = await removeFromRcFile(shell.rcPath, MARKER_OPEN, MARKER_CLOSE);
  if (opts.json) {
    emitJson("remove", { removed, rcPath: shell.rcPath });
    return;
  }
  if (!removed) {
    emit("No Pithy alias installed.");
    return;
  }
  emit(`Removed \`${shell.aliasSyntax}\` from ${shell.rcPath}`);
  emit(`Open a new terminal, or run: source ${shell.rcPath}`);
}

/** Report whether the alias is installed. Prints `Unable to detect shell.` for an unknown shell. */
export async function aliasStatus(opts: AliasOptions = {}): Promise<void> {
  const shell = await detectShell();
  if (!shell) {
    if (opts.json) {
      emitJson("status", { installed: false, shell: null, rcPath: null });
      return;
    }
    emit("Unable to detect shell.");
    return;
  }

  const contents = await readRcFile(shell.rcPath);
  const installed = contents.includes(MARKER_OPEN);
  if (opts.json) {
    emitJson("status", { installed, shell: shell.kind, rcPath: shell.rcPath });
    return;
  }
  if (installed) emit(`Installed in ${shell.rcPath}`);
  else emit(`Not installed. Run \`${pithyCommand("alias")}\` to install.`);
}

/**
 * The hidden root flags, in the order {@link handleHiddenFlags} tests them.
 *
 * Hidden from `--help`, not from anything that enumerates what the CLI parses: `bin.ts` answers them
 * before citty sees the arguments, so they are in no command's `args` and a walk of the command tree
 * cannot find them. `docs/catalog.ts` reads this rather than restating it — the docs catalog exists so
 * the site can ask whether a flag it cites is real, and a flag missing from that answer reads as a typo
 * on a page that is correct.
 */
const PITHIEST = "--pithiest";
const PITHIER = "--pithier";
export const HIDDEN_ROOT_FLAGS: readonly string[] = [PITHIEST, PITHIER];

/** {@link HIDDEN_ROOT_FLAGS}, described, for `pithy schema`. Hidden from `--help`, not from a caller who asks. */
export const HIDDEN_ROOT_FLAG_DESCRIPTIONS: readonly { name: string; description: string }[] = [
  { name: PITHIEST, description: "Print Pithy enough. and change nothing" },
  { name: PITHIER, description: "Install the p. shortcut, as pithy alias does" },
];

/**
 * Handle the hidden root flags. `--pithier` is a synonym for `pithy alias` (install). `--pithiest` is the
 * anti-feature: it prints `Pithy enough.` and writes nothing. Returns whether a flag was handled, so the
 * root dispatch can skip normal command parsing. Neither flag appears in `--help`.
 */
export async function handleHiddenFlags(argv: string[]): Promise<boolean> {
  if (argv.includes(PITHIEST)) {
    emit("Pithy enough.");
    return true;
  }
  if (argv.includes(PITHIER)) {
    await installAlias();
    return true;
  }
  return false;
}

const Command = z.literal("alias").describe('`"alias"`.');
const Shell = z.enum(["bash", "zsh", "fish", "powershell", "nushell"]).describe("The detected shell family.");
const RcPath = z.string().describe("Absolute path to the rc file the alias line belongs in.");
const AliasLine = z.string().describe("The alias line itself, in the detected shell's syntax.");

/** `pithy alias --json`: one object per path taken, `action` naming which. `docs/commands/alias.md`. */
const AliasPayload = z
  .union([
    z
      .object({
        command: Command,
        action: z.literal("install").describe("An install ran."),
        installed: z.literal(true).describe("The alias is in place, whether this run put it there or found it."),
        alreadyInstalled: z.boolean().describe("`true` when it was already there and nothing was written."),
        shell: Shell,
        rcPath: RcPath,
        alias: AliasLine,
      })
      .describe("Install, in a detected shell."),
    z
      .object({
        command: Command,
        action: z.literal("remove").describe("A removal ran."),
        removed: z.boolean().describe("`false` when there was no block to remove. Not an error."),
        rcPath: RcPath,
      })
      .describe("Remove, in a detected shell."),
    z
      .object({
        command: Command,
        action: z.literal("status").describe("A status check ran."),
        installed: z.boolean().describe("Whether the marker block is in the rc file."),
        shell: Shell.nullable().describe("The detected shell family, or `null` when detection failed."),
        rcPath: RcPath.nullable().describe("The rc file, or `null` when detection failed."),
      })
      .describe("Status."),
    z
      .object({
        command: Command,
        action: z.enum(["install", "remove"]).describe("Which of the two was asked for."),
        shell: z.null().describe("`null`: the shell was not detected."),
        manual: z.literal(true).describe("Nothing was written; add `alias` by hand."),
        alias: z.string().describe("The plain POSIX alias line, to add by hand."),
      })
      .describe("Install or remove, in a shell nobody detected."),
  ])
  .describe("What `pithy alias --json` writes: which path ran, and what it found or changed.");

export default withContract(
  defineCommand({
    meta: { name: "alias", description: "Install the `p.` shortcut for `pithy`" },
    args: {
      remove: { type: "boolean", default: false, description: "Uninstall the alias" },
      status: { type: "boolean", default: false, description: "Report whether the alias is installed" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        if (args.remove && args.status) {
          throw new ValidationError({
            message: "Pass either --remove or --status, not both.",
            action: "Choose one.",
          });
        }
        if (args.remove) return removeAlias({ json: args.json });
        if (args.status) return aliasStatus({ json: args.json });
        return installAlias({ json: args.json });
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: AliasPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
    flagGroups: [
      { kind: "atMostOne", flags: ["--remove", "--status"], rule: "Pass either --remove or --status, not both." },
    ],
  },
);
