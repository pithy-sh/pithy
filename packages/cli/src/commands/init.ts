// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, join, resolve } from "node:path";
import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { defineCommand } from "citty";
import { askDomains, writeDomains } from "../project/askDomains";
import { renderDomainsBlock } from "../project/domainPrompt";
import { DEFAULT_WORKER, ensureScaffoldable, kitRange, scaffoldProject } from "../project/scaffold";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import { installAlias } from "./alias";

/**
 * Offer the `p.` shortcut once, right after scaffolding (docs/CLI.md §2.7). Interactive only — a `--json`
 * or non-TTY run never prompts. Asked at most once per project because a second `pithy init` in the same
 * directory never reaches this line — it collides on the files the first one wrote — so there is no
 * "asked before" flag to persist. On yes, the alias installs silently (its own Added/Reload lines are
 * the only output).
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
    dir: {
      type: "string",
      default: ".",
      description: "Target directory. Created if missing; must not already hold the files init writes.",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const targetDir = resolve(process.cwd(), args.dir);
      // Gate on the target before prompting — a doomed run fails fast, not after
      // the user answers (scaffoldProject re-checks, so the guard still holds).
      // `--worker` is passed when given: it decides which `apps/<name>` the scaffold lands at, and so
      // what counts as a collision. A prompted worker name is only known later, and the re-check covers
      // it. `ensureScaffoldable` validates the name before it builds a path out of it.
      await ensureScaffoldable(targetDir, args.worker);

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
      await scaffoldProject({ targetDir, appName, worker: worker.value });

      // Where the Worker answers, asked against the account's real zones. Skippable — a project without
      // a domain yet is legitimate, and adding one later is a config edit plus a deploy. Asked after the
      // scaffold exists, because the answer is written into files this just created.
      const asked = await askDomains({
        projectDir: targetDir,
        workerName: worker.value,
        interactive: interactive(args.json),
      });
      // A declaration the writer could not place must not vanish. `writeDomains` still generates the
      // wrangler values either way, so the Worker routes correctly — but the `domains` block is the
      // source of truth, and an adopter who answered the prompt needs to know it did not land.
      const wrote = asked.domains ? await writeDomains(join(targetDir, "apps", worker.value), asked.domains) : null;
      const prompted = name.prompted || worker.prompted || asked.prompted;

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "init", targetDir, appName, worker: worker.value, domains: asked.domains ?? null })}\n`,
        );
        return;
      }
      if (wrote && !wrote.declared && asked.domains) {
        process.stdout.write(
          `Could not write the domains block into pithy.config.ts. Add it by hand:\n${renderDomainsBlock(asked.domains)}\n`,
        );
      }
      // The scaffolded worker declares no kit dependency while nothing under `@pithy-sh/*` is published
      // ({@link kitRange}), so say where the kit comes from instead. Unsaid, the adopter meets the gap as
      // an unresolved import at the first typecheck — which is a worse introduction than a sentence here,
      // and the only alternative is the range that 404s their first install.
      if (kitRange(PACKAGE_VERSION) === null) {
        process.stdout.write(
          `${dim("@pithy-sh/* isn't published yet, so this worker declares no kit dependency.")}\n${dim("Link the kit from a checkout, then install.")}\n`,
        );
      }
      // Set Done. off from the prompt's gutter; a flagged run has nothing above it.
      process.stdout.write(`${prompted ? "\n" : ""}${formatDone()}\n`);

      // Offer the shortcut only to a human at a terminal — never in a --json or piped run.
      if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
        await offerAlias();
      }
    }),
});
