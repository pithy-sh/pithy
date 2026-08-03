// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, resolve } from "node:path";
import { defineCommand } from "citty";
import { DEFAULT_WORKER, ensureEmptyTarget, scaffoldProject } from "../project/scaffold";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import { installAlias } from "./alias";

/**
 * Offer the `p.` shortcut once, right after scaffolding (docs/CLI.md §2.7). Interactive only — a `--json`
 * or non-TTY run never prompts. `pithy init` requires an empty directory, so it runs at most once per
 * project; there is no "asked before" flag to persist. On yes, the alias installs silently (its own
 * Added/Reload lines are the only output).
 */
async function offerAlias(): Promise<void> {
  const { isCancel, confirm } = await import("@clack/prompts");
  const wants = await confirm({ message: "Want a shortcut? Type `p.` instead of `pithy`." });
  if (!isCancel(wants) && wants) await installAlias({ silent: true });
}

/** Whether a human is attached — the only condition under which `init` prompts for anything. */
function interactive(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/**
 * Ask one question, falling back to `fallback` when there is nobody to ask. A cancel aborts the whole
 * run rather than proceeding on a value the user did not choose.
 */
async function ask(message: string, fallback: string, json: boolean): Promise<{ value: string; prompted: boolean }> {
  if (!interactive(json)) return { value: fallback, prompted: false };
  const { isCancel, text } = await import("@clack/prompts");
  const answer = await text({ message, defaultValue: fallback, placeholder: fallback });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return { value: answer, prompted: true };
}

export default defineCommand({
  meta: { name: "init", description: "Scaffold a new project" },
  args: {
    name: { type: "string", description: "Application name. Defaults to the directory name." },
    worker: {
      type: "string",
      description: `Name of the first worker, created at apps/<name>. Defaults to "${DEFAULT_WORKER}".`,
    },
    dir: { type: "string", default: ".", description: "Target directory. Created if missing; must be empty." },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const targetDir = resolve(process.cwd(), args.dir);
      // Gate on the target before prompting — a doomed run fails fast, not after
      // the user answers (scaffoldProject re-checks, so the guard still holds).
      await ensureEmptyTarget(targetDir);

      // Said before the question, not after it. The name leads every Cloudflare resource this project
      // provisions (docs/NAMING.md), teardown recomputes those names rather than storing them, and the
      // scope decision behind it — one project or two — cannot be undone by editing a string later.
      if (!args.name && interactive(args.json)) {
        process.stdout.write(
          `${dim("One project per set of apps that share users or data. Another app? Add a worker, not a project.")}\n${dim("The name leads every Cloudflare resource this project provisions. Changing it later orphans them.")}\n\n`,
        );
      }
      const name = args.name
        ? { value: args.name, prompted: false }
        : await ask("Project name:", basename(targetDir), args.json);
      // Every worker lives in apps/<name>, so the first one is named too. `api` is the default because
      // this scaffold is a backend — a project that wants `web`, `edge`, or `admin` says so here.
      const worker = args.worker
        ? { value: args.worker, prompted: false }
        : await ask("First worker (apps/<name>):", DEFAULT_WORKER, args.json);

      const appName = name.value;
      const prompted = name.prompted || worker.prompted;
      await scaffoldProject({ targetDir, appName, worker: worker.value });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "init", targetDir, appName, worker: worker.value })}\n`);
        return;
      }
      // Set Done. off from the prompt's gutter; a flagged run has nothing above it.
      process.stdout.write(`${prompted ? "\n" : ""}${formatDone()}\n`);

      // Offer the shortcut only to a human at a terminal — never in a --json or piped run.
      if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
        await offerAlias();
      }
    }),
});
