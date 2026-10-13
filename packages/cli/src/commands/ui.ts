// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { defineCommand } from "citty";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { DRY_RUN_ARG, PlanKey, planText } from "../plan/plan";
import { unpublishedKitNotice } from "../project/scaffold";
import { WorkerIdentity, workerDirName, workerIdentity } from "../project/workerIdentity";
import { canceled, EXIT } from "../terminal/exitClass";
import { mayPrompt } from "../terminal/inputMode";
import { NextKey, uiAddNext } from "../terminal/nextSteps";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
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
  organization: "Scaffold the account chooser?",
};

/** Ask whether to scaffold one capability's screens. Attached only when a human can answer. */
async function promptScreens(request: { screens: UiScreenSet; suggestion: boolean }): Promise<boolean> {
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({
    message: SCREEN_QUESTIONS[request.screens],
    initialValue: request.suggestion,
  });
  if (isCancel(answer)) canceled();
  return answer;
}

/** `pithy ui add <framework>` — scaffold a front end into one worker and wire it. */
const Names = (what: string) => z.array(z.string().describe("One name.")).describe(what);

/** `pithy ui add --json`. `docs/commands/ui.md`. */
const UiAddPayload = z
  .object({
    command: z.literal("ui.add").describe('`"ui.add"`.'),
    dryRun: z.boolean().describe("Whether this was `--dry-run`. Nothing was written when it is `true`."),
    ...WorkerIdentity.shape,
    framework: z.string().describe("The stub that wrote it."),
    auth: z.boolean().describe("Whether the sign-in screens were included."),
    payments: z.boolean().describe("Whether the paywall screens were included."),
    organization: z.boolean().describe("Whether the account chooser was included."),
    created: Names("Worker-relative paths created by this run, sorted."),
    skipped: Names("Worker-relative paths that already existed and were left byte-identical, sorted."),
    unstyled: Names("Class names the screens render that nothing in this Worker's stylesheets defines."),
    runWorkerFirst: Names("The derived `assets.run_worker_first` allowlist now in `wrangler.jsonc`."),
    packageManager: z.string().describe("The project's package manager."),
    dependencies: Names("Dependency names added to the Worker's `package.json`."),
    devDependencies: Names("Dev-dependency names added to the Worker's `package.json`."),
    scripts: Names("Script names added or superseded."),
    plan: PlanKey,
    next: NextKey,
  })
  .describe("What `pithy ui add` scaffolded, or under `--dry-run` would.");

/** `pithy ui sync --json`. */
const UiSyncPayload = z
  .object({
    command: z.literal("ui.sync").describe('`"ui.sync"`.'),
    ...WorkerIdentity.shape,
    before: Names("The allowlist before this run."),
    after: Names("The allowlist after it."),
    changed: z.boolean().describe("Whether anything moved. `false` on a re-run."),
    uncovered: Names("Routes the allowlist in the file does not cover. Non-empty fails the run."),
    unstyled: Names("Class names the screens render that nothing defines. Fails the run under `--check`."),
    notFoundHandling: z
      .string()
      .optional()
      .describe("`assets.not_found_handling` as it stands, when the Worker sets one."),
  })
  .describe("What `pithy ui sync` re-derived, or found under `--check`.");

/** `pithy ui list --json`. */
const UiListPayload = z
  .object({
    command: z.literal("ui.list").describe('`"ui.list"`.'),
    stubs: z
      .array(
        z
          .object({
            id: z.string().describe("The stub's id — what `pithy ui add` takes."),
            description: z.string().describe("What it scaffolds."),
          })
          .describe("One framework stub."),
      )
      .describe("Every framework `pithy ui add` can scaffold, sorted."),
  })
  .describe("The framework stubs.");

const add = withContract(
  defineCommand({
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
      payments: {
        type: "boolean",
        description: "Include the paywall and subscription screens (--no-payments to skip)",
      },
      organization: {
        type: "boolean",
        description: "Include the account chooser (--no-organization to skip)",
      },
      "dry-run": DRY_RUN_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);
        const dryRun = args["dry-run"];
        // Composed for dev: which screens a Worker composes is read off the Worker `pithy dev` serves them
        // from. Each environment's route allowlist is composed for that environment by the flow itself.
        const target = await targetWorker(LOCAL_ENVIRONMENT, {
          projectDir,
          interactive,
          ...(args.worker === undefined ? {} : { worker: args.worker }),
        });

        const report = await runUiAdd({
          projectDir,
          workerDir: target.dir,
          config: target.config,
          framework: args.framework,
          ...(args.auth === undefined ? {} : { auth: args.auth }),
          ...(args.payments === undefined ? {} : { payments: args.payments }),
          ...(args.organization === undefined ? {} : { organization: args.organization }),
          ...(interactive ? { prompt: promptScreens } : {}),
          dryRun,
        });

        if (args.json) {
          // The install, when this run wrote dependencies nothing has installed yet (#697). Absent otherwise.
          const next = uiAddNext({
            dryRun,
            packageManager: report.packageManager,
            added: report.dependencies.length + report.devDependencies.length,
          });
          process.stdout.write(
            `${formatJsonLine({ command: "ui.add", dryRun, ...report, ...workerIdentity(target), next })}\n`,
          );
          return;
        }
        if (report.plan) {
          process.stdout.write(`Would scaffold a ${report.framework} front end into ${report.worker}.\n`);
          for (const line of planText(report.plan)) process.stdout.write(`${line}\n`);
          process.stdout.write("Dry run. Nothing written.\n");
          return;
        }
        const screens = [
          report.auth ? "sign-in" : null,
          report.payments ? "paywall" : null,
          report.organization ? "choose-organization" : null,
        ].filter((name) => name !== null);
        const template = screens.length === 0 ? "Bare template." : `Screens included: ${screens.join(", ")}.`;
        process.stdout.write(`Scaffolded a ${report.framework} front end into ${report.worker}. ${template}\n`);
        if (report.skipped.length > 0) {
          process.stdout.write(`${report.created.length} files added. ${report.skipped.length} left as they were.\n`);
        } else {
          process.stdout.write(`${report.created.length} files created.\n`);
        }
        // The one seeded test, named because its whole value is in being noticed. It is the only file
        // here whose subject is a *silence*: the action label drifting out of the projection is invisible
        // in dev and staging by construction — Cloudflare's test keys answer with no action to compare
        // (#374) — so the first environment that can tell is the one where it refuses every sign-in.
        if (report.auth) {
          process.stdout.write("src/turnstile.test.tsx is yours now. It goes red when the widget stops reading\n");
          process.stdout.write("its action from config. Dev and staging cannot see that drift. Production can.\n");
        }
        // Written and styled are two claims. Saying only the first is what let a backfill report a
        // sign-in screen as created while three of the classes it renders were defined nowhere.
        if (report.unstyled.length > 0) {
          process.stdout.write(`These screens render classes nothing here defines: ${report.unstyled.join(", ")}.\n`);
          process.stdout.write("Define them in src/styles.css, or restore src/pithy-screens.css.\n");
          // Said here because this line used to be the only time anyone was told (#401). It printed once,
          // did not affect the exit, and `pithy ui sync` never asked again.
          process.stdout.write(
            `${pithyCommand("ui sync", { flags: { "--worker": workerDirName(target), "--check": true } })} asks this again, and fails on it.\n`,
          );
        }
        process.stdout.write(`Worker-first: ${report.runWorkerFirst.join(", ")}.\n`);
        // Before the install line, because it is the instruction that would otherwise be wrong. While the
        // scope is unpublished the stub's `@pithy-sh/vite` range is dropped, so the install below succeeds
        // and the build then fails on a Vite plugin nothing declared. `pithy init` says this; so does
        // `pithy worker add`; the wording is decided once, in `unpublishedKitNotice`.
        for (const line of unpublishedKitNotice() ?? []) process.stdout.write(`${dim(line)}\n`);
        process.stdout.write(`Install the packages: ${report.packageManager} install. Then ${pithyCommand("dev")}.\n`);
        // Naming `pithy add` alone was the whole failure: it read as "capabilities change this list",
        // and the routes an adopter writes themselves change it too, with no command in the loop.
        process.stdout.write("That list covers the routes mounted now. Mount another — your own included —\n");
        const sync = pithyCommand("ui sync", { flags: { "--worker": workerDirName(target) } });
        const check = pithyCommand("ui sync", { flags: { "--worker": workerDirName(target), "--check": true } });
        process.stdout.write(`and run ${sync}. Gate it in CI with ${check}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: UiAddPayload,
    mutates: true,
    // A second identical add is refused with `core/conflict`: a Worker that already carries this front end
    // and gains nothing new is the "adding a UI twice" error (`ui/flow.ts`). `contract/idempotent.test.ts`.
    idempotent: false,
    needsNetwork: false,
    flags: { framework: { enum: listStubs().map((stub) => stub.id) } },
  },
);

/** `pithy ui sync` — re-derive the worker's asset allowlist from its current route table. */
const sync = withContract(
  defineCommand({
    meta: {
      name: "sync",
      description: "Re-derive a worker's assets.run_worker_first from its routes, after mounting one",
    },
    args: {
      worker: { type: "string", description: "Which worker to re-derive (apps/<name>)" },
      check: {
        type: "boolean",
        default: false,
        description: "Report drift and write nothing; exits 1 on a shadowed route or an unstyled screen",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);
        // Composed for dev: which screens a Worker composes is read off the Worker `pithy dev` serves them
        // from. Each environment's route allowlist is composed for that environment by the flow itself.
        const target = await targetWorker(LOCAL_ENVIRONMENT, {
          projectDir,
          interactive,
          ...(args.worker === undefined ? {} : { worker: args.worker }),
        });

        const report = await runUiSync({
          projectDir,
          workerDir: target.dir,
          config: target.config,
          check: args.check,
        });

        // A shadowed route is a 200 with the wrong body, so the gate is the exit code, not the wording.
        if (report.uncovered.length > 0) process.exitCode = EXIT.failed;
        // **And so is a screen with no rules (#401).** Same failure shape — a 200, the wrong output, no
        // error — and it fails only under `--check`, because that is the flag that means "report, write
        // nothing, and tell CI". A plain `pithy ui sync` is somebody fixing their allowlist; exiting 1 on
        // it would break every script that runs the fix.
        if (args.check && report.unstyled.length > 0) process.exitCode = EXIT.failed;

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "ui.sync", ...report, ...workerIdentity(target) })}\n`);
          return;
        }
        if (args.check) {
          if (report.uncovered.length > 0) {
            process.stdout.write(`${report.worker}: the SPA shell is answering these, not the worker.\n`);
            for (const route of report.uncovered) process.stdout.write(`  ${route}\n`);
            process.stdout.write(`Run ${pithyCommand("ui sync", { flags: { "--worker": report.worker } })}.\n`);
          }
          if (report.unstyled.length > 0) {
            process.stdout.write(`${report.worker}: these screens render classes nothing here defines.\n`);
            for (const name of report.unstyled) process.stdout.write(`  ${name}\n`);
            process.stdout.write("Define them in src/styles.css, or restore src/pithy-screens.css.\n");
          }
          if (report.uncovered.length === 0 && report.unstyled.length === 0) {
            process.stdout.write(`${report.worker}: every route reaches the worker, and every screen is styled.\n`);
            process.stdout.write(`${formatDone()}\n`);
          }
          return;
        }
        if (report.unstyled.length > 0) {
          process.stdout.write(`These screens render classes nothing here defines: ${report.unstyled.join(", ")}.\n`);
          process.stdout.write("Define them in src/styles.css, or restore src/pithy-screens.css.\n");
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
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: UiSyncPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
  },
);

/** `pithy ui list` — the framework stubs `pithy ui add` can scaffold. */
const list = withContract(
  defineCommand({
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
        process.stdout.write(
          `${formatList(stubs.map((stub) => ({ name: stub.id, description: stub.description })))}\n`,
        );
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: UiListPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
  },
);

export default defineCommand({
  meta: { name: "ui", description: "Scaffold and wire a front end served by one of the project's Workers" },
  subCommands: { add, sync, list },
});
