// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { listStubs, runUiAdd, runUiSync, type UiScreenSet } from "../ui/flow";
import { targetWorker } from "./add";

/**
 * `pithy ui` — one command scaffolds a front end into an existing worker and wires it end to end, so
 * the SPA and the API deploy as one unit on one origin.
 *
 * There are deliberately **no provider flags**. The sign-in screen renders its social buttons from the
 * target worker's own `pithy.config.ts` through `virtual:pithy/auth`; a `--google` here would be a
 * second source of truth that drifts the moment someone edits config or runs `pithy add auth`.
 */

/** What each capability's screen set is called at a prompt. */
const SCREEN_QUESTIONS: Record<UiScreenSet, string> = {
  auth: "Scaffold the passwordless sign-in screens?",
  payments: "Scaffold the paywall and subscription screens?",
};

/** Ask whether to scaffold one capability's screens. Attached only when a human can answer. */
async function promptScreens(request: { screens: UiScreenSet; suggestion: boolean }): Promise<boolean> {
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({
    message: SCREEN_QUESTIONS[request.screens],
    initialValue: request.suggestion,
  });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return answer;
}

/** `pithy ui add <framework>` — scaffold a front end into one worker and wire it. */
const add = defineCommand({
  meta: {
    name: "add",
    description:
      "Scaffold a front end into a worker and serve it from that worker (one origin, one deploy). No provider flags: the sign-in screen renders from that worker's pithy.config.ts",
  },
  args: {
    framework: { type: "positional", required: true, description: "Framework stub, e.g. react. See pithy ui list" },
    worker: { type: "string", description: "Which worker to scaffold into (apps/<name>)" },
    // No default on either: undefined means "decide" — prompt a human, else follow whether the
    // capability is composed on that worker.
    auth: { type: "boolean", description: "Include the passwordless sign-in screens (--no-auth for the bare SPA)" },
    payments: { type: "boolean", description: "Include the paywall and subscription screens (--no-payments to skip)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
      const target = await targetWorker({
        projectDir,
        interactive,
        ...(args.worker === undefined ? {} : { worker: args.worker }),
      });

      const report = await runUiAdd({
        projectDir,
        workerDir: target.dir,
        worker: target.name,
        config: target.config,
        framework: args.framework,
        ...(args.auth === undefined ? {} : { auth: args.auth }),
        ...(args.payments === undefined ? {} : { payments: args.payments }),
        ...(interactive ? { prompt: promptScreens } : {}),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "ui.add", ...report })}\n`);
        return;
      }
      const screens = [report.auth ? "sign-in" : null, report.payments ? "paywall" : null].filter(
        (name) => name !== null,
      );
      const template = screens.length === 0 ? "Bare template." : `Screens included: ${screens.join(", ")}.`;
      process.stdout.write(`Scaffolded a ${report.framework} front end into ${report.worker}. ${template}\n`);
      if (report.skipped.length > 0) {
        process.stdout.write(`${report.created.length} files added. ${report.skipped.length} left as they were.\n`);
      } else {
        process.stdout.write(`${report.created.length} files created.\n`);
      }
      process.stdout.write(`Worker-first: ${report.runWorkerFirst.join(", ")}.\n`);
      process.stdout.write(`Install the packages: ${report.packageManager} install. Then pithy dev.\n`);
      // Naming `pithy add` alone was the whole failure: it read as "capabilities change this list",
      // and the routes an adopter writes themselves change it too, with no command in the loop.
      process.stdout.write("That list covers the routes mounted now. Mount another — your own included —\n");
      process.stdout.write("and run pithy ui sync. Gate it in CI with pithy ui sync --check.\n");
      process.stdout.write(`${formatDone()}\n`);
    }),
});

/** `pithy ui sync` — re-derive the worker's asset allowlist from its current route table. */
const sync = defineCommand({
  meta: {
    name: "sync",
    description: "Re-derive a worker's assets.run_worker_first from its routes, after mounting one",
  },
  args: {
    worker: { type: "string", description: "Which worker to re-derive (apps/<name>)" },
    check: {
      type: "boolean",
      default: false,
      description: "Report drift and write nothing; exits 1 on a shadowed route",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
      const target = await targetWorker({
        projectDir,
        interactive,
        ...(args.worker === undefined ? {} : { worker: args.worker }),
      });

      const report = await runUiSync({
        workerDir: target.dir,
        worker: target.name,
        config: target.config,
        check: args.check,
      });

      // A shadowed route is a 200 with the wrong body, so the gate is the exit code, not the wording.
      if (report.uncovered.length > 0) process.exitCode = 1;

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "ui.sync", ...report })}\n`);
        return;
      }
      if (args.check) {
        if (report.uncovered.length === 0) {
          process.stdout.write(`${report.worker}: every route reaches the worker.\n`);
          process.stdout.write(`${formatDone()}\n`);
          return;
        }
        process.stdout.write(`${report.worker}: the SPA shell is answering these, not the worker.\n`);
        for (const route of report.uncovered) process.stdout.write(`  ${route}\n`);
        process.stdout.write(`Run pithy ui sync --worker ${report.worker}.\n`);
        return;
      }
      if (!report.changed) {
        process.stdout.write(`${report.worker} is already in sync.\n`);
        process.stdout.write(`${formatDone()}\n`);
        return;
      }
      const added = report.after.filter((path) => !report.before.includes(path));
      const removed = report.before.filter((path) => !report.after.includes(path));
      process.stdout.write(`Re-derived ${report.worker}'s worker-first paths.\n`);
      if (added.length > 0) process.stdout.write(`Added: ${added.join(", ")}.\n`);
      if (removed.length > 0) process.stdout.write(`Removed: ${removed.join(", ")}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

/** `pithy ui list` — the framework stubs `pithy ui add` can scaffold. */
const list = defineCommand({
  meta: { name: "list", description: "List the front-end frameworks pithy ui add can scaffold" },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const stubs = listStubs();
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "ui.list", stubs })}\n`);
        return;
      }
      process.stdout.write(`${formatList(stubs.map((stub) => ({ name: stub.id, description: stub.description })))}\n`);
    }),
});

export default defineCommand({
  meta: { name: "ui", description: "Scaffold and wire a front end served by one of the project's Workers" },
  subCommands: { add, sync, list },
});
