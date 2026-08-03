// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { defaultRemoveSteps, removeCapability } from "../capabilities/remove";
import { loadProject, requireProjectName } from "../project/config";
import { envArg, requireEnvironment } from "../project/environment";
import { formatDone, withErrorReporting } from "../terminal/output";
import { buildAudit, targetWorker } from "./add";

/**
 * `remove` is the deliberate exception to the agent-drivable / `--json` convention: it is destructive,
 * so it is human-only. `--json` fast-fails here — before anything is read or changed.
 */
export function rejectJson(json: boolean): void {
  if (json) {
    throw new ValidationError({
      message: "pithy remove is a manual command. --json is not supported.",
      action: "Run pithy remove <capability> at a terminal.",
    });
  }
}

/**
 * The `--drop` confirmation for an environment. `dev` asks a light yes/no; any non-dev env demands the
 * exact typed phrase `drop <cap> from <env>` (the Cloudflare-dashboard delete pattern) — a mismatch or
 * a cancel returns false and aborts with zero changes. There is no bypass flag.
 */
export function dropConfirm(capability: string, env: string): () => Promise<boolean> {
  return async () => {
    const clack = await import("@clack/prompts");
    if (env === "dev") {
      const answer = await clack.confirm({ message: `Drop ${capability}'s tables from dev? This deletes data.` });
      return !clack.isCancel(answer) && answer === true;
    }
    const phrase = `drop ${capability} from ${env}`;
    const typed = await clack.text({ message: `This deletes ${env} data. Type "${phrase}" to confirm:` });
    return !clack.isCancel(typed) && typed === phrase;
  };
}

export default defineCommand({
  meta: { name: "remove", description: "Remove a capability — the manual, interactive inverse of add" },
  args: {
    capability: { type: "positional", required: true, description: "Capability name, e.g. auth" },
    worker: { type: "string", description: "Which worker to unwire it from (apps/<name>)" },
    drop: {
      type: "boolean",
      default: false,
      description: "Also roll back the capability's migrations (drops its tables)",
    },
    env: envArg("With --drop, the environment whose tables to drop"),
    json: { type: "boolean", default: false, description: "Not supported — remove is manual-only" },
  },
  // Errors always render as terminal problem/action lines: `remove` has no machine-readable surface.
  run: ({ args }) =>
    withErrorReporting(false, async () => {
      rejectJson(args.json);

      const projectDir = process.cwd();
      const env = requireEnvironment(args.env);

      // Which Worker to unwire. `remove` is human-only, so the prompt is available whenever a TTY is.
      const target = await targetWorker({
        projectDir,
        interactive: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
        ...(args.worker === undefined ? {} : { worker: args.worker }),
      });
      const capabilities = target.capabilities;

      // `requireProjectName`, never `resolveProjectName`: a `--drop` reverses migrations against a live
      // database, and the name is what that database's owner stamp is checked against. A guessed one
      // (the alphabetically-first Worker, the directory basename) differs between checkouts, so it would
      // either refuse this project's own database or claim another's. Resolved here, at the command edge,
      // before anything is read or unwired — a nameless project is told to fix its config, not half-removed.
      const project = requireProjectName(await loadProject(projectDir));

      const result = await removeCapability({
        workerDir: target.dir,
        capability: args.capability,
        drop: args.drop ? { env, confirm: dropConfirm(args.capability, env) } : undefined,
        steps: defaultRemoveSteps({
          projectDir,
          workerDir: target.dir,
          loadCapabilities: async () => capabilities,
          project,
        }),
        // `--drop`'s env is the natural audit target when given; otherwise "dev", which is inert — a
        // plain unwiring has no live environment, and the audit database is resolved from the project
        // root, narrowed to the Worker being unwired.
        audit: await buildAudit({
          projectDir,
          worker: target.name,
          env: args.drop ? env : "dev",
          capabilities,
        }),
      });

      if (!result.present) {
        process.stdout.write(`${args.capability} is not present in ${target.name}. Nothing to remove.\n`);
        return;
      }
      if (result.aborted) {
        process.stdout.write("Aborted. Nothing changed.\n");
        return;
      }

      process.stdout.write(`Removed ${args.capability} from ${target.name}.\n`);
      if (result.dropped) {
        const total = result.dropped.reduce((sum, run) => sum + run.results.length, 0);
        process.stdout.write(`Dropped ${total} migration${total === 1 ? "" : "s"} from ${env}.\n`);
      }
      if (result.ejected) {
        process.stdout.write(`Deleted ${relative(projectDir, join(target.dir, "capabilities", args.capability))}/.\n`);
      } else if (result.packageManager) {
        process.stdout.write(`Uninstalled @pithy-sh/${args.capability}.\n`);
      } else if (result.keptFor.length > 0) {
        // The wiring is gone from this Worker, but the package is one shared install — say so plainly,
        // and name who still holds it, so the leftover dependency is never a surprise.
        const holders = result.keptFor.join(", ");
        const verb = result.keptFor.length === 1 ? "still wires it" : "still wire it";
        process.stdout.write(`Kept @pithy-sh/${args.capability} installed — ${holders} ${verb}.\n`);
      }
      if (result.tablesRemain) {
        // The down code is gone now, so there's no post-removal pithy command to reverse them — name
        // the tables to drop by hand, and point at --drop for next time.
        //
        // Unless a sibling Worker still wires the capability: Workers sharing a binding name share one
        // database, so those tables are live for the sibling. Telling someone to drop them by hand would
        // be telling them to delete data another Worker is serving.
        const shared = result.keptFor.length > 0;
        process.stdout.write(
          shared
            ? `${args.capability}'s D1 tables were left in place — ${result.keptFor.join(", ")} still ${result.keptFor.length === 1 ? "wires" : "wire"} it and ${result.keptFor.length === 1 ? "is" : "are"} using them. Don't drop them by hand.\n`
            : `${args.capability}'s D1 tables were left in place — your data is safe, and a later pithy add ${args.capability} reuses them. To drop them, remove the pithy_${args.capability}_* tables by hand (pass --drop to reverse them during removal).\n`,
        );
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
