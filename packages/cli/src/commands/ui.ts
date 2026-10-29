// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
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
import { listStubs, runUiAdd, runUiSync, type UiSyncReport } from "../ui/flow";
import { nativeApp, runNativeUiSync } from "../ui/nativeFlow";
import { RAIL_PLATFORMS, type RailPlatform, type UiRailPrompt } from "../ui/rails";
import { composes, type UiScreenSet } from "../ui/screens";
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
  consent: "Scaffold the consent settings screen?",
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

/** What each platform's rail is called at a prompt. */
const RAIL_QUESTIONS: Record<RailPlatform, string> = {
  ios: "Which rail does the iOS app sell through?",
  android: "Which rail does the Android app sell through?",
  web: "Which rail does the web build sell through?",
};

/** Ask which rail one platform sells through. Attached only when a human can answer. */
const promptRail: UiRailPrompt = async (request) => {
  const { isCancel, select } = await import("@clack/prompts");
  const answer = await select({
    message: RAIL_QUESTIONS[request.platform],
    options: request.choices.map((rail) => ({
      value: rail,
      label: rail === "none" ? "none. Show plans, sell nothing." : rail,
    })),
    initialValue: request.suggestion,
  });
  if (isCancel(answer)) canceled();
  return answer;
};

/** The three rail flags, as `pithy ui add` and `pithy ui sync` declare them. */
const RAIL_ARGS = {
  "ios-rail": {
    type: "string",
    description: "The rail the iOS app sells through: apple, stripe, lemonSqueezy, paddle or none (react-native)",
  },
  "android-rail": {
    type: "string",
    description: "The rail the Android app sells through: google, stripe, lemonSqueezy, paddle or none (react-native)",
  },
  "web-rail": {
    type: "string",
    description: "The rail the web build sells through: stripe, lemonSqueezy, paddle or none (react-native)",
  },
} as const;

/** The rail flags a run was given, keyed by platform, or undefined when it was given none. */
function railFlags(
  args: Partial<Record<`${RailPlatform}-rail`, string | undefined>>,
): Partial<Record<RailPlatform, string>> | undefined {
  const flags: Partial<Record<RailPlatform, string>> = {};
  for (const platform of RAIL_PLATFORMS) {
    const value = args[`${platform}-rail`];
    if (value !== undefined) flags[platform] = value;
  }
  return Object.keys(flags).length === 0 ? undefined : flags;
}

/** `rails` in a `--json` payload: the rail each platform of a React Native app sells through. */
const Rails = z
  .object({
    ios: z.string().describe("The rail the iOS app sells through."),
    android: z.string().describe("The rail the Android app sells through."),
    web: z.string().describe("The rail the web build sells through."),
  })
  .optional()
  .describe("The rail each platform sells through. Only for `react-native`, whose app lives in its own directory.");

/** What `pithy ui add react-native` says once it has written the app. */
function writeNativeAdded(
  report: {
    app: string;
    worker: WorkerDir;
    framework: string;
    created: string[];
    skipped: string[];
    packageManager: string;
    rails: Record<RailPlatform, string>;
    trustedOrigins?: string[] | undefined;
    untrustedOrigins?: string[] | undefined;
    unresolvedPackages?: string[] | undefined;
    backfill?: boolean | undefined;
  },
  template: string,
  composesAuth: boolean,
): void {
  process.stdout.write(
    `Scaffolded a ${report.framework} app into apps/${report.app}. It calls ${report.worker}. ${template}\n`,
  );
  if (report.skipped.length > 0) {
    process.stdout.write(`${report.created.length} files added. ${report.skipped.length} left as they were.\n`);
  } else {
    process.stdout.write(`${report.created.length} files created.\n`);
  }
  process.stdout.write(`Rails: iOS ${report.rails.ios}, Android ${report.rails.android}, web ${report.rails.web}.\n`);
  const generated = `apps/${report.app}/src/pithy-config.generated.ts`;
  process.stdout.write(
    report.backfill
      ? `${generated} was rewritten from ${report.worker}'s config. Its rails, appScheme, universalLinkOrigin and Google client ids were kept.\n`
      : `${generated} holds ${report.worker}'s config. Set appScheme and universalLinkOrigin there before a store build.\n`,
  );
  const quoted = (entries: readonly string[]) => entries.map((entry) => `"${entry}"`).join(" and ");
  if ((report.untrustedOrigins ?? []).length > 0) {
    process.stdout.write(
      `Add ${quoted(report.untrustedOrigins ?? [])} to auth's trustedOrigins in apps/${report.worker}/pithy.config.ts. A sign-in returns to the app there.\n`,
    );
  } else if (!composesAuth && (report.trustedOrigins ?? []).length > 0) {
    process.stdout.write(
      `When ${report.worker} composes auth, its trustedOrigins needs ${quoted(report.trustedOrigins ?? [])}.\n`,
    );
  }
  for (const name of report.unresolvedPackages ?? []) {
    process.stdout.write(`No range found for ${name}. Add one to apps/${report.app}/package.json.\n`);
  }
  const sync = pithyCommand("ui sync", { flags: { "--app": report.app, "--worker": report.worker } });
  process.stdout.write(`Change ${report.worker}'s config, then run ${sync}.\n`);
  for (const line of unpublishedKitNotice() ?? []) process.stdout.write(`${dim(line)}\n`);
  process.stdout.write(`Install the packages: ${report.packageManager} install. Then ${pithyCommand("dev")}.\n`);
  process.stdout.write(`${formatDone()}\n`);
}

/** What `pithy ui sync --app` says. */
function writeNativeSynced(report: { app: string; worker: WorkerDir; changed: boolean }, check: boolean): void {
  const file = `apps/${report.app}/src/pithy-config.generated.ts`;
  if (check && report.changed) {
    process.stdout.write(`${file} is behind ${report.worker}'s config.\n`);
    const sync = pithyCommand("ui sync", { flags: { "--app": report.app, "--worker": report.worker } });
    process.stdout.write(`Run ${sync}.\n`);
    return;
  }
  if (!report.changed) {
    process.stdout.write(`${file} is already in sync with ${report.worker}.\n`);
  } else {
    process.stdout.write(`Rewrote ${file} from ${report.worker}'s config. Your scheme, links and rails are kept.\n`);
  }
  process.stdout.write(`${formatDone()}\n`);
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
    app: z
      .string()
      .optional()
      .describe("The app's own `apps/` directory. Only for `react-native`; the paths below are relative to it."),
    rails: Rails,
    trustedOrigins: Names(
      "The entries auth's `trustedOrigins` needs for the app: its scheme as `<scheme>://`, and its universal-link origin when set.",
    )
      .optional()
      .describe(
        "The entries auth's `trustedOrigins` needs for the app: its scheme as `<scheme>://`, and its universal-link origin when set. Only for `react-native`.",
      ),
    untrustedOrigins: Names("The entries the Worker's auth config lacks.")
      .optional()
      .describe(
        "Of `trustedOrigins`, the entries the Worker's auth config does not list. Empty when nothing is missing or the Worker composes no auth. Only for `react-native`.",
      ),
    unresolvedPackages: Names("Kit packages with no range.")
      .optional()
      .describe(
        "Kit packages the app's templates import that no source had a range for, so the app's `package.json` declares none. Only for `react-native`.",
      ),
    backfill: z
      .boolean()
      .optional()
      .describe(
        "Whether the app already existed, so this run added screens to it and rewrote its generated config from the Worker, keeping its rails, `appScheme`, `universalLinkOrigin` and Google client ids. Only for `react-native`.",
      ),
    auth: z.boolean().describe("Whether the sign-in screens were included."),
    payments: z.boolean().describe("Whether the paywall screens were included."),
    organization: z.boolean().describe("Whether the account chooser was included."),
    consent: z.boolean().describe("Whether the consent settings screen was included."),
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
    app: z.string().optional().describe("The app whose generated config was rewritten. Only with `--app`."),
    rails: Rails,
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
      worker: {
        type: "string",
        description: "Which worker to scaffold into (apps/<name>), or for react-native the worker the app calls",
      },
      app: {
        type: "string",
        description: 'The app\'s own directory, apps/<name> (react-native only). Defaults to "app"',
      },
      ...RAIL_ARGS,
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
      consent: {
        type: "boolean",
        description: "Include the consent settings screen (--no-consent to skip)",
      },
      "dry-run": DRY_RUN_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);
        const dryRun = args["dry-run"];
        const rails = railFlags(args);
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
          ...(args.consent === undefined ? {} : { consent: args.consent }),
          ...(args.app === undefined ? {} : { app: args.app }),
          ...(rails === undefined ? {} : { rails }),
          ...(interactive ? { prompt: promptScreens, railPrompt: promptRail } : {}),
          deployedName: target.name,
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
          const into = report.app === undefined ? report.worker : `apps/${report.app}, calling ${report.worker}`;
          process.stdout.write(`Would scaffold a ${report.framework} front end into ${into}.\n`);
          for (const line of planText(report.plan)) process.stdout.write(`${line}\n`);
          process.stdout.write("Dry run. Nothing written.\n");
          return;
        }
        const screens = [
          report.auth ? "sign-in" : null,
          report.payments ? "paywall" : null,
          report.organization ? "choose-organization" : null,
          report.consent ? "consent" : null,
        ].filter((name) => name !== null);
        const template = screens.length === 0 ? "Bare template." : `Screens included: ${screens.join(", ")}.`;
        if (report.app !== undefined && report.rails !== undefined) {
          writeNativeAdded(
            { ...report, app: report.app, rails: report.rails },
            template,
            composes(target.config, "auth"),
          );
          return;
        }
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
    // 2: `plan.resources[].kind` takes `queue`, the fourth kind provisioning creates (#662).
    schemaVersion: 2,
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
      worker: {
        type: "string",
        description: "Which worker to re-derive (apps/<name>), or with --app the worker the app calls",
      },
      app: {
        type: "string",
        description: "Rewrite this React Native app's generated config from its worker instead (apps/<name>)",
      },
      ...RAIL_ARGS,
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
        const rails = railFlags(args);
        if (args.app === undefined && rails !== undefined) {
          throw new ValidationError({
            message: "The rail flags set a React Native app's rails, and no --app names one.",
            action: "Pass --app with the app's apps/ directory.",
          });
        }
        // An app of its own names the Worker it calls in its manifest; `--worker` overrides it.
        const native = args.app === undefined ? null : await nativeApp(projectDir, args.app);
        const worker = args.worker ?? native?.worker ?? undefined;
        // Composed for dev: which screens a Worker composes is read off the Worker `pithy dev` serves them
        // from. Each environment's route allowlist is composed for that environment by the flow itself.
        const target = await targetWorker(LOCAL_ENVIRONMENT, {
          projectDir,
          interactive,
          ...(worker === undefined ? {} : { worker }),
        });

        const report: UiSyncReport =
          native === null
            ? await runUiSync({ projectDir, workerDir: target.dir, config: target.config, check: args.check })
            : await runNativeUiSync({
                projectDir,
                appDir: native.appDir,
                workerDir: target.dir,
                config: target.config,
                deployedName: target.name,
                check: args.check,
                ...(rails === undefined ? {} : { rails }),
              });
        // A generated config behind its Worker is the same finding as a stale allowlist: the app reads values
        // the Worker no longer serves.
        if (args.check && report.app !== undefined && report.changed) process.exitCode = EXIT.failed;

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
        if (report.app !== undefined) {
          writeNativeSynced({ ...report, app: report.app }, args.check);
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
