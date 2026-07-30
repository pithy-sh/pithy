// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
import { addWorker, listWorkers, removeWorker } from "../project/workerCommand";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";

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
      const report = await addWorker({
        projectDir: process.cwd(),
        name: args.name,
        skipInstall: args["skip-install"],
      });
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "worker.add", ...report })}\n`);
        return;
      }
      process.stdout.write(`Worker ${report.name} scaffolded at ${report.dir}.\n`);
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

export default defineCommand({
  meta: { name: "worker", description: "Manage the project's Workers under apps/ (the dev/deploy registry)" },
  subCommands: { add, list, remove },
});
