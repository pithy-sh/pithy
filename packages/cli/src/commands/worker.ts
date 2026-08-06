// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { reconcileAppWorkflows } from "../project/appWorkflows";
import { askDomains, writeDomains } from "../project/askDomains";
import { loadProject, requireProjectName } from "../project/config";
import { renderDomainsBlock } from "../project/domainPrompt";
import { optionalEnvArg, requireEnvironment } from "../project/environment";
import { addWorker, listWorkers, removeWorker } from "../project/workerCommand";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import { targetWorker } from "./add";

/** `pithy worker add <name>` — scaffold a new worker under apps/ and wire it in. */
const add = defineCommand({
  meta: { name: "add", description: "Scaffold a new worker under apps/<name> and wire it into the dev set" },
  args: {
    name: { type: "positional", required: true, description: "Worker name, kebab-case, e.g. web or admin-api" },
    "skip-install": { type: "boolean", default: false, description: "Skip the workspace install after scaffolding" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const report = await addWorker({ projectDir, name: args.name, skipInstall: args["skip-install"] });

      // Every Worker serves its own hostname, so a new one is asked about too — the same question
      // `pithy init` asks, against the same account zones, and equally skippable.
      const asked = await askDomains({
        projectDir,
        workerName: report.name,
        interactive: !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
      });
      // A declaration the writer could not place must not vanish. `writeDomains` still generates the
      // wrangler values either way, so the Worker routes correctly — but the `domains` block is the
      // source of truth, and an adopter who answered the prompt needs to know it did not land.
      const wrote = asked.domains ? await writeDomains(report.dir, asked.domains) : null;

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "worker.add", ...report, domains: asked.domains ?? null })}\n`,
        );
        return;
      }
      process.stdout.write(`Worker ${report.name} scaffolded at ${report.dir}.\n`);
      if (wrote && !wrote.declared && asked.domains) {
        process.stdout.write(
          `Could not write the domains block into pithy.config.ts. Add it by hand:\n${renderDomainsBlock(asked.domains)}\n`,
        );
      }
      if (report.reconciled && report.port !== null) {
        process.stdout.write(`Pinned to port ${report.port}.\n`);
      } else {
        process.stdout.write("Ports are assigned when you run pithy feature create or sync.\n");
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

/** `pithy worker list` — the discovered workers with autostart state and pinned port. */
const list = defineCommand({
  meta: { name: "list", description: "List the project's workers with their autostart state and pinned port" },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const workers = await listWorkers({ projectDir: process.cwd() });
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "worker.list", workers })}\n`);
        return;
      }
      if (workers.length === 0) {
        process.stdout.write("No workers. Run pithy worker add <name>, or pithy init.\n");
        return;
      }
      const rows = workers.map((worker) => {
        const port = worker.port === null ? "—" : String(worker.port);
        const auto = worker.autostart ? "autostart" : "manual";
        return { name: worker.name, description: dim(`${auto}  port ${port}`) };
      });
      process.stdout.write(`${formatList(rows)}\n`);
    }),
});

/** `pithy worker remove <name>` — delete apps/<name> and release its port. */
const remove = defineCommand({
  meta: { name: "remove", description: "Delete a worker under apps/<name> and release its port" },
  args: {
    name: { type: "positional", required: true, description: "Worker name to remove (an apps/<name> directory)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const report = await removeWorker({ projectDir: process.cwd(), name: args.name });
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "worker.remove", ...report })}\n`);
        return;
      }
      process.stdout.write(`Removed ${report.name}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

/**
 * `pithy worker sync` — write the app capability's declared Workflows and cron schedule into the Worker's
 * `wrangler.jsonc`, for every environment it declares.
 *
 * A library capability's Workflows arrive with `pithy <capability> provision`. The adopter's own had no
 * command at all, so the binding table was hand-written per environment against a naming rule that only
 * fails at deploy. This is that command. It writes config and nothing else — no Cloudflare call, no
 * deploy — so it is safe to run on any branch, at any time, as often as you like.
 */
const sync = defineCommand({
  meta: {
    name: "sync",
    description: "Write the app capability's declared Workflows and cron triggers into the worker's wrangler.jsonc",
  },
  args: {
    worker: { type: "string", description: "Which worker to reconcile (apps/<name>)" },
    env: optionalEnvArg("Reconcile just this environment (omit for every one the worker declares)"),
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      // First, before any config is loaded: an illegal environment must cost nothing.
      const env = args.env === undefined ? undefined : requireEnvironment(args.env);
      const projectDir = process.cwd();
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
      const target = await targetWorker({
        projectDir,
        interactive,
        ...(args.worker === undefined ? {} : { worker: args.worker }),
      });

      const app = target.config.app;
      if (!app) {
        throw new NotFoundError({
          message: `${target.name} has no app capability.`,
          action: "Declare `app` in the worker's pithy.config.ts. Its `workflows` map is what this reconciles.",
        });
      }

      const runs = await reconcileAppWorkflows({
        workerDir: target.dir,
        // `requireProjectName`, never `resolveProjectName`: a Workflow name is account-scoped and stable
        // forever once deployed, so a guessed project would name a Workflow another project owns.
        project: await loadProject(projectDir).then(requireProjectName),
        app,
        ...(env === undefined ? {} : { env }),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "worker.sync", worker: target.name, runs })}\n`);
        return;
      }
      if (runs.length === 0) {
        process.stdout.write(`${target.name}'s app capability declares no workflows.\n`);
        process.stdout.write(`${formatDone()}\n`);
        return;
      }
      if (runs.every((run) => !run.changed)) {
        process.stdout.write(`${target.name} is already in sync.\n`);
        process.stdout.write(`${formatDone()}\n`);
        return;
      }
      for (const run of runs) {
        const crons = run.crons.length === 0 ? "no cron" : run.crons.join(", ");
        const bound = run.workflows.map((entry) => entry.binding).join(", ");
        process.stdout.write(`${run.env}: ${bound} bound. ${crons}.\n`);
      }
      // Cloudflare resolves class_name in the script the binding names, and that script is this one.
      const classes = [...new Set(runs.flatMap((run) => run.workflows.map((entry) => entry.class_name)))];
      process.stdout.write(dim(`Export a WorkflowEntrypoint subclass from main for each: ${classes.join(", ")}.\n`));
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "worker", description: "Manage the project's Workers under apps/ (the dev/deploy registry)" },
  subCommands: { add, list, remove, sync },
});
