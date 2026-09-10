// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { devListingRows, listDevSet } from "../dev/listDev";
import { startDev } from "../dev/orchestrator";
import { formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";

/**
 * `pithy dev` — run the project's workers locally under one supervisor.
 *
 * Discovers the workers from `apps/` plus the host Worker of every capability they compose, resolves each
 * one's pinned port from `.dev.config.json` (verifying it is free, never drifting), spawns them as process
 * groups, tees their labeled output to the terminal and `logs/dev.log`, and prints one ready banner. Ctrl-C
 * (SIGINT) or SIGTERM tears the whole session down; any worker exiting brings the rest down with it. The
 * real work lives in `startDev`; this stays thin.
 *
 * Two flags narrow it. `--list` prints the set a run would start and starts nothing — through `listDevSet`,
 * a module that imports none of the orchestrator's writers. `--app` names exactly what to start, whatever a
 * worker's `dev.autostart` says.
 */

/**
 * Collect every `--app` from the raw argv. citty keeps only the last occurrence of a repeated string flag,
 * so a multi-worker run would otherwise silently drop all but the last — the same reason `token`'s
 * `--permission` is read from rawArgs (see `collectPermissionFlags`). Handles `--app x` and `--app=x`.
 *
 * **A `--app` with no name is refused, and that is where this parts company with its precedent.** The next
 * token is not a value if it is another flag, and a dropped value leaves the collection empty — which here
 * does not mean *nothing was asked for*, it means *start everything*. So a forgotten name would spawn the
 * whole estate, which is the exact opposite of what was typed, and `--app --json` would quietly eat the
 * `--json` as well. `--permission` can afford to fail open into a refusal; this fails open into processes.
 */
export function collectAppFlags(rawArgs: string[]): string[] {
  const found: string[] = [];
  let missingValue = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--app") {
      const value = rawArgs[i + 1];
      if (value === undefined || value.startsWith("-")) {
        missingValue = true;
        continue;
      }
      found.push(value);
      i++;
    } else if (arg?.startsWith("--app=")) {
      const value = arg.slice("--app=".length);
      if (value === "") missingValue = true;
      else found.push(value);
    }
  }
  if (missingValue) {
    throw new ValidationError({
      message: "--app needs a worker name.",
      action: "Run pithy dev --list to see this project's dev set, then name one: pithy dev --app <name>.",
    });
  }
  return found;
}

/** Print the set a run would start. Reads only — no port is assigned, no file is written, nothing spawns. */
async function printDevSet(projectDir: string, apps: string[], json: boolean): Promise<void> {
  const listing = await listDevSet({ projectDir, apps });
  const members = listing.members;

  if (json) {
    process.stdout.write(`${formatJsonLine({ command: "dev", event: "list", members })}\n`);
    // Notes are the operator's, and stdout is the machine's — one object per line, as a session's own
    // output already promises.
    for (const note of listing.notes) process.stderr.write(`${note}\n`);
    return;
  }

  for (const note of listing.notes) process.stderr.write(`${note}\n`);
  if (members.length === 0) {
    process.stdout.write("No workers. Run pithy worker add <name>, or pithy init.\n");
    return;
  }
  const rows = devListingRows(listing).map((row) => ({ name: row.name, description: dim(row.description) }));
  process.stdout.write(`${formatList(rows)}\n`);
}

export default defineCommand({
  meta: { name: "dev", description: "Run every worker locally under one supervisor" },
  args: {
    list: { type: "boolean", default: false, description: "Print the workers a run would start, and start nothing" },
    app: {
      type: "string",
      description: "Start only the worker named, whatever its dev.autostart says (repeatable)",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const apps = collectAppFlags(rawArgs);

      // Before `startDev`, before the signal wiring, and above all before the `process.exit(0)` below:
      // `--list` answers a question and hands the process back.
      if (args.list) {
        await printDevSet(projectDir, apps, args.json);
        return;
      }

      const handle = await startDev({ projectDir, json: args.json, apps });

      if (args.json) {
        const workers = Object.fromEntries(handle.workers.map((w) => [w.name, { port: w.port, origin: w.origin }]));
        process.stdout.write(`${formatJsonLine({ command: "dev", workers })}\n`);
      }

      process.once("SIGINT", () => void handle.shutdown("interrupted"));
      process.once("SIGTERM", () => void handle.shutdown("terminated"));

      await handle.closed;
      process.exit(0);
    }),
});
