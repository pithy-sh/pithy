// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { z } from "zod";
import {
  COMPLETION_SHELLS,
  type CompletionShell,
  completionScript,
  isCompletionShell,
  loadingLine,
} from "../completion/scripts";
import { withContract } from "../contract/commandContract";
import { appendToRcFile, readRcFile, removeFromRcFile } from "../platform/rc";
import { type AskProfile, aliasRcPaths, detectShell, type ShellInfo } from "../platform/shell";
import { formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy completion [shell] [--remove | --status] [--json]` — tab completion for `pithy` (#765).
 *
 * **With a shell, it prints that shell's script** for anyone wiring it up by hand. The script asks the
 * binary on the PATH for every answer (`completion/complete.ts`), so it holds nothing that goes stale.
 *
 * **Without one, it installs the way `pithy alias` does**: the same shell detection, the same rc file — the
 * same set, for PowerShell — and a marked block holding one line that loads the script, so `--remove` takes
 * out exactly what it put in. A second run writes nothing. nushell, which `pithy alias` covers, completes
 * differently and is not covered here; it is handled like a shell nobody detected, with nothing written.
 */

/** The block `--remove` finds and deletes. The same `#` comment syntax as the alias block, beside it. */
const MARKER_OPEN = `# >>> ${commandName("completion")} >>>`;
const MARKER_CLOSE = `# <<< ${commandName("completion")} <<<`;

/** What a refusal to write an rc file tells the operator to add by hand. */
const WHAT = { what: "the Pithy completion" };

/** The four shells, as a refusal and the docs say them. */
const SHELL_LIST = "bash, zsh, fish or powershell";

/** What every entry point here accepts: the alias command's seams, by the same names. */
export interface CompletionOptions {
  /** Suppress the `Already pithy.` line (the silent `pithy init` install). */
  silent?: boolean;
  /** Emit one JSON line instead of human text. */
  json?: boolean;
  /** Seam: the platform detection resolves against. */
  platform?: NodeJS.Platform;
  /** Seam: asks a PowerShell edition for `$PROFILE`. */
  askProfile?: AskProfile;
}

/** Which path ran — the discriminant every payload leads with. */
type CompletionAction = "script" | "install" | "remove" | "status";

function emitJson(action: CompletionAction, payload: Record<string, unknown>): void {
  process.stdout.write(`${formatJsonLine({ command: "completion", action, ...payload })}\n`);
}

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The shell `pithy alias` would write to, when it is one completion covers; else what was found instead. */
async function detect(
  opts: CompletionOptions,
): Promise<{ shell: ShellInfo & { kind: CompletionShell } } | { found: ShellInfo | null }> {
  const shell = await detectShell({ platform: opts.platform, askProfile: opts.askProfile });
  if (shell !== null && isCompletionShell(shell.kind)) return { shell: shell as ShellInfo & { kind: CompletionShell } };
  return { found: shell };
}

/**
 * Nothing is written for a shell completion does not cover, or one nobody detected. Say which, and how to
 * load it by hand — and exit 0, as `pithy alias` does for a shell it does not know.
 */
function logManual(action: "install" | "remove", found: ShellInfo | null, opts: CompletionOptions): void {
  if (opts.json) {
    emitJson(action, { shell: found?.kind ?? null, manual: true });
    return;
  }
  if (found === null) emit("Couldn't detect your shell.");
  else emit(`Completion covers bash, zsh, fish and PowerShell. Not ${found.kind}.`);
  emit(`Run \`${pithyCommand("completion")} <shell>\` and load what it prints from your shell's startup file.`);
}

/**
 * Whether completion is already loaded from these contents: our block, or a hand-written line that runs
 * `pithy completion <shell>` — in which case a second loader would only run the script twice.
 */
function alreadyInstalled(contents: string): boolean {
  return contents.includes(MARKER_OPEN) || /\bpithy completion (bash|zsh|fish|powershell)\b/.test(contents);
}

/** Print the script for `name`, or refuse a shell completion does not cover, naming the four it does. */
export function printScript(name: string, opts: CompletionOptions = {}): void {
  if (!isCompletionShell(name)) {
    throw new ValidationError({
      message: `No completion for ${name}.`,
      action: `Pass ${SHELL_LIST}.`,
      issues: [{ path: ["shell"], code: "invalid_value", message: `Pass ${SHELL_LIST}.` }],
    });
  }
  const script = completionScript(name);
  if (opts.json) {
    emitJson("script", { shell: name, source: script });
    return;
  }
  process.stdout.write(script);
}

/** Install the loading line into the rc file `pithy alias` resolves, once. Tops up a PowerShell set. */
export async function installCompletion(opts: CompletionOptions = {}): Promise<void> {
  const detected = await detect(opts);
  if (!("shell" in detected)) {
    logManual("install", detected.found, opts);
    return;
  }
  const { shell } = detected;
  const line = loadingLine(shell.kind);
  const paths = aliasRcPaths(shell);
  const contents = await Promise.all(paths.map((path) => readRcFile(path, WHAT)));
  const installed = contents.some((text) => alreadyInstalled(text));
  const block = [MARKER_OPEN, line, MARKER_CLOSE].join("\n");
  const wrote: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (!alreadyInstalled(contents[index] ?? "")) {
      await appendToRcFile(path, `\n${block}\n`, WHAT);
      wrote.push(path);
    }
  }
  if (opts.json) {
    emitJson("install", {
      installed: true,
      alreadyInstalled: installed,
      wrote,
      shell: shell.kind,
      rcPath: shell.rcPath,
      ...(paths.length > 1 ? { rcPaths: paths } : {}),
      line,
    });
    return;
  }
  if (wrote.length === 0) {
    if (!opts.silent) emit("Already pithy.");
    return;
  }
  emit(`Added completion to ${wrote.join(" and ")}`);
  emit(`Open a new terminal, or run: source ${shell.rcPath}`);
}

/** Remove exactly the block install wrote. A hand-written line is the operator's, and is left alone. */
export async function removeCompletion(opts: CompletionOptions = {}): Promise<void> {
  const detected = await detect(opts);
  if (!("shell" in detected)) {
    logManual("remove", detected.found, opts);
    return;
  }
  const { shell } = detected;
  const paths = aliasRcPaths(shell);
  const removedFrom: string[] = [];
  for (const path of paths) {
    if (await removeFromRcFile(path, MARKER_OPEN, MARKER_CLOSE)) removedFrom.push(path);
  }
  if (opts.json) {
    emitJson("remove", {
      removed: removedFrom.length > 0,
      ...(removedFrom.length > 0 ? { removedFrom } : {}),
      rcPath: shell.rcPath,
      ...(paths.length > 1 ? { rcPaths: paths } : {}),
    });
    return;
  }
  if (removedFrom.length === 0) {
    emit("No Pithy completion installed.");
    return;
  }
  emit(`Removed completion from ${removedFrom.join(" and ")}`);
  emit(`Open a new terminal, or run: source ${shell.rcPath}`);
}

/** Report whether the block is in place, naming the files that carry it. Reads only. */
export async function completionStatus(opts: CompletionOptions = {}): Promise<void> {
  const detected = await detect(opts);
  if (!("shell" in detected)) {
    if (opts.json) {
      emitJson("status", { installed: false, shell: detected.found?.kind ?? null, rcPath: null });
      return;
    }
    emit(detected.found === null ? "Unable to detect shell." : `Completion does not cover ${detected.found.kind}.`);
    return;
  }
  const { shell } = detected;
  const paths = aliasRcPaths(shell);
  const contents = await Promise.all(paths.map((path) => readRcFile(path, WHAT)));
  const carriers = paths.filter((_, index) => (contents[index] ?? "").includes(MARKER_OPEN));
  if (opts.json) {
    emitJson("status", {
      installed: carriers.length > 0,
      ...(carriers.length > 0 ? { installedIn: carriers } : {}),
      shell: shell.kind,
      rcPath: shell.rcPath,
      ...(paths.length > 1 ? { rcPaths: paths } : {}),
    });
    return;
  }
  if (carriers.length > 0) emit(`Installed in ${carriers.join(" and ")}`);
  else emit(`Not installed. Run \`${pithyCommand("completion")}\` to install.`);
}

const Command = z.literal("completion").describe('`"completion"`.');
const Shell = z.enum(COMPLETION_SHELLS).describe("The shell, one of the four completion covers.");
const RcPath = z
  .string()
  .describe("Absolute path to the rc file the loading line belongs in — the one `pithy alias` uses.");
const RcPaths = z
  .array(z.string().describe("One rc file of the set."))
  .optional()
  .describe("The whole profile set, when it has more than one member: PowerShell on Windows.");

/** `pithy completion --json`: one object per path taken, `action` naming which. `docs/commands/completion.md`. */
const CompletionPayload = z
  .union([
    z
      .object({
        command: Command,
        action: z.literal("script").describe("A script was printed."),
        shell: Shell,
        source: z.string().describe("The script's source, exactly as it prints without `--json`."),
      })
      .describe("`pithy completion <shell>`."),
    z
      .object({
        command: Command,
        action: z.literal("install").describe("An install ran."),
        installed: z
          .literal(true)
          .describe("Completion is loaded from the rc file, whether this run put it there or found it."),
        alreadyInstalled: z
          .boolean()
          .describe("`true` when the block, or a hand-written loader, was there before this run."),
        wrote: z
          .array(z.string().describe("One file written."))
          .describe("The files this run wrote the block into. `[]` is the sentence 'this run wrote nothing.'"),
        shell: Shell,
        rcPath: RcPath,
        rcPaths: RcPaths,
        line: z.string().describe("The loading line inside the block."),
      })
      .describe("Install, in a shell completion covers."),
    z
      .object({
        command: Command,
        action: z.literal("remove").describe("A removal ran."),
        removed: z.boolean().describe("`false` when there was no block to remove. Not an error."),
        removedFrom: z
          .array(z.string().describe("One file the block came out of."))
          .optional()
          .describe("The files the block came out of — only the ones it was in."),
        rcPath: RcPath,
        rcPaths: RcPaths,
      })
      .describe("Remove, in a shell completion covers."),
    z
      .object({
        command: Command,
        action: z.literal("status").describe("A status check ran."),
        installed: z.boolean().describe("Whether the block is in any member of the set."),
        installedIn: z
          .array(z.string().describe("One file carrying the block."))
          .optional()
          .describe("The files that carry the block — named, not the whole set."),
        shell: z
          .enum(["bash", "zsh", "fish", "powershell", "nushell"])
          .nullable()
          .describe("The detected shell, or `null` when detection failed. `nushell` is detected and not covered."),
        rcPath: RcPath.nullable().describe("The rc file, or `null` when the shell is not one completion covers."),
        rcPaths: RcPaths,
      })
      .describe("Status."),
    z
      .object({
        command: Command,
        action: z.enum(["install", "remove"]).describe("Which of the two was asked for."),
        shell: z
          .literal("nushell")
          .nullable()
          .describe("`null` when no shell was detected; `nushell` when the one detected is not covered."),
        manual: z.literal(true).describe("Nothing was written; load `pithy completion <shell>` by hand."),
      })
      .describe("Install or remove, in a shell completion does not cover or nobody detected."),
  ])
  .describe("What `pithy completion --json` writes: which path ran, and what it found, printed or changed.");

export default withContract(
  defineCommand({
    meta: { name: "completion", description: "Install tab completion for `pithy`, or print a shell's script" },
    args: {
      shell: {
        type: "positional",
        required: false,
        description: "Print this shell's script instead of installing: bash, zsh, fish or powershell",
      },
      remove: { type: "boolean", default: false, description: "Uninstall completion" },
      status: { type: "boolean", default: false, description: "Report whether completion is installed" },
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
        if (args.shell !== undefined) {
          if (args.remove || args.status) {
            throw new ValidationError({
              message: `Pass a shell or ${args.remove ? "--remove" : "--status"}, not both.`,
              action: `Run \`${pithyCommand("completion")} <shell>\` to print a script, or drop the shell.`,
            });
          }
          return printScript(args.shell, { json: args.json });
        }
        if (args.remove) return removeCompletion({ json: args.json });
        if (args.status) return completionStatus({ json: args.json });
        return installCompletion({ json: args.json });
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: CompletionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
    flags: { shell: { enum: [...COMPLETION_SHELLS] } },
    flagGroups: [
      { kind: "atMostOne", flags: ["--remove", "--status"], rule: "Pass either --remove or --status, not both." },
    ],
  },
);
