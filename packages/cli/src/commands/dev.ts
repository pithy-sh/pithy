// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { resolveDevSet, selectDevMembers } from "../dev/devSet";
import { devListingRows, listDevSet } from "../dev/listDev";
import { startDev } from "../dev/orchestrator";
import { portsRegistryPath, registryRootFor, setWorkerAutostart } from "../feature/ports";
import { currentBranch, defaultGit } from "../feature/worktree";
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

/**
 * `pithy dev --app <name> --disable-autostart` — stop a worker starting on this branch, on this machine.
 *
 * **Why a flag and a registry key rather than `dev.autostart` in `pithy.worker.jsonc`.** The manifest is
 * the project's shared answer, committed, the same for everyone: it says a worker exists and how it is
 * run. Which workers one developer is exercising this week is not that. Editing the manifest to stop
 * running `payments` locally puts that into everyone else's checkout and into a diff somebody has to
 * review, and the review comment is *why is payments off*. So the answer lives beside the port block —
 * keyed on the same checkout, the same branch, the same machine — and the manifest keeps meaning what it
 * has always meant.
 *
 * **Per branch, inherited once.** `pithy feature create` copies the branch it cut from, so a worker you
 * parked on `main` stays parked in the feature; from then on the two disagree freely, and the command
 * acts on whichever branch you run it from. Nothing here is a project-wide switch, and nothing here is
 * committed.
 *
 * It writes and returns. Starting is `pithy dev`, and `--app <name>` on its own still starts a parked
 * worker for one run — naming a worker outright is the more specific act, and it is how you reach a
 * worker you have turned off without turning it back on.
 */
/**
 * Which of the two autostart flags was meant, refusing the two ways of meaning neither.
 *
 * Pulled out of {@link setDevAutostart} because it is the only branching in that path and the rest of it
 * touches the registry, a git checkout and the real dev set — so this is the half that can be held to
 * account directly. Both refusals are about the same thing: a flag that writes to a file the person
 * cannot see has no business guessing.
 */
export function autostartIntent(flags: { disable: boolean; enable: boolean; apps: readonly string[] }): {
  enabled: boolean;
} {
  // Both at once is not a mistake with a safe reading — neither order is more obviously meant — so it is
  // refused rather than resolved. Silently preferring one would write the opposite of what half the
  // people who typed it expected, to a file they cannot see.
  if (flags.disable && flags.enable) {
    throw new ValidationError({
      message: "--disable-autostart and --enable-autostart cannot both be given.",
      action: "Pass one of them with --app <name>.",
    });
  }
  const enabled = flags.enable;
  // Without `--app` there is nothing to act on, and the permissive reading — *every worker* — is the one
  // answer nobody means: it would park the entire dev set on a flag somebody typed by itself.
  if (flags.apps.length === 0) {
    throw new ValidationError({
      message: `Name the workers to ${enabled ? "enable" : "disable"}.`,
      action: `pithy dev --app <name> ${enabled ? "--enable-autostart" : "--disable-autostart"}`,
    });
  }
  return { enabled };
}

async function setDevAutostart(options: {
  projectDir: string;
  apps: string[];
  enabled: boolean;
  json: boolean;
}): Promise<void> {
  // Resolved against the real set, and through `selectDevMembers` — the same resolution a run does, so
  // the three name forms are the three name forms and an unknown name is refused here exactly as it
  // would be there. Turning off a name that could never have started is a silent no-op otherwise, and
  // the file would keep a key nothing ever reads.
  const listing = await resolveDevSet({ projectDir: options.projectDir });
  const selected = selectDevMembers(listing.members, options.apps);
  const names = selected.map((member) => member.worker.name);

  const registryPath = portsRegistryPath();
  const root = await registryRootFor(options.projectDir);
  const branch = (await currentBranch(defaultGit, options.projectDir)) ?? `local:${options.projectDir}`;
  const autostart = await setWorkerAutostart({ registryPath, root, branch, workers: names, enabled: options.enabled });

  if (options.json) {
    process.stdout.write(
      `${formatJsonLine({ command: "dev", event: "autostart", branch, apps: names, enabled: options.enabled, autostart })}\n`,
    );
    return;
  }
  const verb = options.enabled ? "starts" : "no longer starts";
  for (const name of names) process.stdout.write(`${name} ${verb} on ${branch}.\n`);
  process.stdout.write(dim(`  ${registryPath}\n`));
}

export default defineCommand({
  meta: { name: "dev", description: "Run every worker locally under one supervisor" },
  args: {
    list: { type: "boolean", default: false, description: "Print the workers a run would start, and start nothing" },
    app: {
      type: "string",
      description: "Start only the worker named, whatever its dev.autostart says (repeatable)",
    },
    "disable-autostart": {
      type: "boolean",
      default: false,
      description: "Stop --app's workers starting on this branch, on this machine. Starts nothing",
    },
    "enable-autostart": {
      type: "boolean",
      default: false,
      description: "Undo --disable-autostart for --app's workers. Starts nothing",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const apps = collectAppFlags(rawArgs);

      // Before every other branch: these two write the registry and start nothing. `--app` names what
      // they act on, which is the same resolution a run uses, so a name that would not start is a name
      // that cannot be turned off either.
      if (args["disable-autostart"] || args["enable-autostart"]) {
        const { enabled } = autostartIntent({
          disable: args["disable-autostart"],
          enable: args["enable-autostart"],
          apps,
        });
        await setDevAutostart({ projectDir, apps, enabled, json: args.json });
        return;
      }

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
