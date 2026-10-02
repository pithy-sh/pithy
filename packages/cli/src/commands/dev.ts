// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { devCloudflareAccount } from "../dev/delivery";
import { resolveDevSet, selectDevMembers } from "../dev/devSet";
import { devListingRows, listDevSet } from "../dev/listDev";
import { type DevHandle, resolveAutostartOverrides, startDev } from "../dev/orchestrator";
import { chooseRenderer, interruptAction, rendererInputsFromProcess } from "../dev/tui/choose";
import { portsRegistryPath, registryRootFor, setWorkerAutostart } from "../feature/ports";
import { currentBranch, defaultGit } from "../feature/worktree";
import { openUrl } from "../platform/browser";
import { formatJsonLine, formatJsonStreamLine, formatList, withErrorReporting } from "../terminal/output";
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
  // The same resolution `startDev` makes, through the same function. `--list` promises to describe the
  // run this command would make, and a second way of answering *what starts* is a second answer.
  const listing = await listDevSet({
    projectDir,
    apps,
    autostartOverrides: await resolveAutostartOverrides({ projectDir }),
  });
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

/**
 * Mount `pithy dev`'s live roster.
 *
 * **Behind `await import`, and that is enforced rather than remembered.** Ink is ~630 ms to import — a
 * React reconciler and a Yoga layout engine, more than twice miniflare's cost and the heaviest single
 * import in this CLI. `ci/lazyHeavyImports.test.ts` lists `ink` and `react` in its `HEAVY` table, so the
 * gate fails the moment either reaches a command's static graph. `pithy dev --json`, a piped run, CI, and
 * every other command pay nothing.
 */
async function mountTui(keys: boolean, live: () => DevHandle | undefined) {
  const [{ createDevStore }, { startTui }] = await Promise.all([import("../dev/tui/store"), import("../dev/tui/app")]);
  const store = createDevStore();
  /** A key action's failure is a line, never a crash: the supervisor outranks its own footer. */
  const report = (error: unknown) => store.line(messageOf(error));

  // Typed off `store` rather than imported: a type-only import of the renderer would put its
  // module name in this file's import list, and `ci/lazyHeavyImports.test.ts` reads that list.
  let tui: { store: typeof store; stop: () => Promise<void> } | undefined;
  let stopping = false;

  /**
   * Stop the session — and, pressed a second time, stop waiting for it.
   *
   * **The second press is not a convenience.** `shutdown` returns early once it has begun, and the
   * roster holds raw mode with `exitOnCtrlC: false`, so without this there is no key that does anything
   * while a teardown is in flight: a session whose child would not die could not be stopped at all. The
   * orchestrator's own waits are bounded now, which makes that nearly unreachable — this is the backstop
   * for the case the bound does not cover, because the cost of being wrong is a terminal nobody can
   * recover without another one.
   *
   * The footer is unmounted first, which is what hands the terminal back; `130` is the conventional
   * interrupted-by-user code and is honest here, because the session did not shut down cleanly.
   */
  const stop = (reason: string) => {
    const action = interruptAction({ hasSession: live() !== undefined, stopping });
    stopping = true;
    if (action === "shutdown") {
      store.line(dim("  press Ctrl-C again to stop waiting"));
      void live()?.shutdown(reason).catch(report);
      return;
    }
    // Hand the terminal back first — unmounting is what does that — then go, bounded in case the
    // unmount is the thing that is stuck.
    void Promise.race([tui?.stop() ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 2000))]).finally(
      () => process.exit(130),
    );
  };

  /**
   * `l` — ask who, unless there is nothing to ask.
   *
   * The list is read as the key is pressed, so a `pithy seed` run beside the session is picked up. With
   * none or one identity there is no question: `devLogin` opens the only one, and says why when there is
   * none. With several, the roster hands the pane over to the picker rather than printing the list into
   * the stream, which is what it used to do — fine for three identities, a wall of output for
   * twenty-nine, and impossible past nine, where it fell back to a prompt that cannot have the keyboard
   * while Ink holds it.
   */
  const openIdentityPicker = async (worker: string) => {
    const handle = live();
    if (!handle) return;
    try {
      const identities = await handle.listIdentities();
      if (identities.length <= 1) {
        await handle.devLogin(worker);
        return;
      }
      store.openPicker(
        identities.map((identity) => ({ userId: identity.userId, email: identity.email })),
        worker,
      );
    } catch (error) {
      report(error);
    }
  };

  tui = startTui({
    store,
    keys,
    onRestart: (worker) => void live()?.restart(worker).catch(report),
    onOpen: (worker) => {
      // From the whole dev set, not the startup snapshot: a worker started later from a parked row is
      // not in `workers`, and resolving from there lit `o` up and then did nothing.
      const origin = live()?.originOf(worker);
      if (origin) void openUrl(origin).catch(report);
    },
    // The row, not a heuristic: an app stack can carry several front ends, and the marker says which.
    onLogin: (worker) => void openIdentityPicker(worker),
    onSignIn: (userId, worker) => void live()?.signInAs(userId, worker).catch(report),
    // Writes this branch's answer to `dev-ports.json` — the same key `--disable-autostart` writes.
    onAutostart: (worker, autostart) => void live()?.setAutostart(worker, autostart).catch(report),
    // Forwarded verbatim, and inert unless `l` has a list open — digits belong to the identity list
    // rather than to the roster, which moves on the arrow keys (#667).
    onDigit: (digit) => void live()?.pickIdentity(digit).catch(report),
    onQuit: () => stop("stopped"),
    // Raw mode took the terminal's own Ctrl-C handling away, and Ink is rendered with
    // `exitOnCtrlC: false`, so this is the only thing that stops the session. It goes to `shutdown` —
    // unmounting first would orphan every `wrangler → workerd` subtree.
    onInterrupt: () => stop("interrupted"),
  });
  return tui;
}

/** Report the session, wire the signals, and wait for it to end. */
async function runSession(handle: DevHandle, json: boolean): Promise<void> {
  if (json) {
    const workers = Object.fromEntries(handle.workers.map((w) => [w.name, { port: w.port, origin: w.origin }]));
    // `identities` names who this session can sign in as and **never how** — `#667`. The claim is a
    // credential, and a machine-readable line is as public as a printed one; `devLoginIdentities` is
    // where that omission is stated and asserted.
    //
    // The session line opens a stream that runs until the session ends, so it is framed as one:
    // compact, one object per line, whatever this terminal would otherwise be given (#666).
    process.stdout.write(`${formatJsonStreamLine({ command: "dev", workers, identities: handle.identities })}\n`);
  }

  process.once("SIGINT", () => void handle.shutdown("interrupted"));
  process.once("SIGTERM", () => void handle.shutdown("terminated"));

  await handle.closed;
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
    tui: {
      type: "boolean",
      default: true,
      description: "Render the live roster at a terminal",
      // citty renders a `--no-<name>` line for any boolean defaulting true, and takes its text from
      // here. Left unset it prints the flag with no description at all — which is most of the way back
      // to the undiscoverable environment variable this flag exists to replace.
      negativeDescription: "Use the plain stream instead of the live roster",
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

      // The account is resolved here, where the project is loaded, and handed down — never reached for
      // inside the orchestrator. It is what every worker this session spawns authenticates as (#555).
      const account = await devCloudflareAccount(projectDir);

      /**
       * **Which renderer this run gets — the one place that knows both exist (#670).**
       *
       * A person at a terminal gets the live roster; `--json`, a pipe and CI get the plain stream, which
       * is the contract anything automated reads. Every term of that decision, and the reads behind it,
       * live together in `dev/tui/choose.ts` where the clauses are tested one by one.
       */
      // `--tui` is read from the raw argv as well as from citty, because only the typed form beats a
      // `PITHY_NO_TUI` in somebody's profile — and citty cannot tell its default from an explicit true.
      // Both spellings count: citty accepts `--tui=true`, and matching only the bare flag meant that
      // form was treated as the default and lost to the variable it was typed to override.
      const tuiExplicit = rawArgs.some((arg) => arg === "--tui" || arg.startsWith("--tui="));
      const renderer = chooseRenderer(rendererInputsFromProcess(args.json, args.tui, tuiExplicit));

      /**
       * The live session, once there is one.
       *
       * Late-bound because the footer is mounted *before* `startDev` runs — so that the first thing it
       * says lands in the roster's stream rather than above it — and its keys act on a handle that does
       * not exist yet. Every handler is inert until it does, which is the correct behavior anyway: there
       * is nothing to restart before anything has started.
       */
      let live: DevHandle | undefined;
      const tui = renderer.tui ? await mountTui(renderer.keys, () => live) : undefined;

      try {
        const handle = await startDev({
          projectDir,
          account,
          json: args.json,
          apps,
          // Ink owns the cursor, so a line written behind its back corrupts the frame: under the footer
          // the supervisor's output is committed through the store instead. `logs/dev.log` is written by
          // the orchestrator either way and is not affected.
          ...(tui
            ? {
                stdout: (text: string, origin?: string) => tui.store.line(text.replace(/\n$/, ""), origin),
                stderr: (text: string, origin?: string) => tui.store.line(text.replace(/\n$/, ""), origin),
                events: tui.store.event,
                // The roster carries every worker's state, port and address, so the banner leaves its
                // own list of them out. `logs/dev.log` records them either way.
                roster: true,
                // `terminal/keys.ts` and Ink's `useInput` both claim raw mode, and only one may. The
                // reader is stubbed out with `active` reporting whether there is in fact a keyboard, so
                // the banner still offers `l` rather than printing a URL nobody needs.
                readKeys: () => ({ active: renderer.keys, stop: () => {} }),
              }
            : {}),
        });
        live = handle;
        await runSession(handle, args.json);
      } finally {
        // Whatever happened, give the terminal back. A session that died with raw mode on leaves a shell
        // that echoes nothing. Unmounting here is also what leaves the footer's last frame printed as
        // ordinary output — the roster as it stood, with exit codes.
        await tui?.stop();
      }

      // After the footer is down, never before: the exit is explicit because a supervisor that has
      // reaped its children can still be holding a stdin listener or a stream that would keep Node alive.
      process.exit(0);
    }),
});
