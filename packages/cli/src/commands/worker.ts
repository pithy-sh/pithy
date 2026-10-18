// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { InputRequiredError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { defineCommand } from "citty";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { describeStaleAutostartRoots, StaleAutostartRoot } from "../feature/ports";
import { DRY_RUN_ARG, PlanKey, planText } from "../plan/plan";
import { applyDomains } from "../project/applyDomains";
import { reconcileAppWorkflows } from "../project/appWorkflows";
import { askDomains, writeDomains } from "../project/askDomains";
import { loadProject, loadWorkerDomains, projectCloudflareAccount, requireProjectName } from "../project/config";
import { renderDomainsBlock } from "../project/domainPrompt";
import { optionalEnvArg, requireEnvironment } from "../project/environment";
import { unpublishedKitNotice } from "../project/scaffold";
import { reconcileServiceStanzas, type ServiceWorkerNames, serviceScripts } from "../project/serviceStanzas";
import { bindableFrom, bindWorker, readServiceProject, unbindWorker } from "../project/workerBind";
import { addWorker, listWorkers, removeWorker, renameWorker } from "../project/workerCommand";
import { WorkerIdentity, workerIdentity } from "../project/workerIdentity";
import { discoverWorkers } from "../project/workers";
import { canceled } from "../terminal/exitClass";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import { targetWorker } from "./add";

/** `pithy worker add <name>` — scaffold a new worker under apps/ and wire it in. */
const Dir = z.string().describe("The Worker's directory.");
const Reconciled = z
  .boolean()
  .describe("Whether the feature's `.dev.config.json` was reconciled. Only inside a worktree.");

/** `pithy worker add --json`. `docs/commands/worker.md`. */
const WorkerAddPayload = z
  .object({
    command: z.literal("worker.add").describe('`"worker.add"`.'),
    ...WorkerIdentity.shape,
    dir: Dir,
    port: z.number().int().nullable().describe("The port pinned for it inside a feature worktree, else `null`."),
    reconciled: Reconciled,
    devVarsRefused: z
      .array(z.string().describe("One sentence."))
      .describe("One sentence per Worker whose `.dev.vars` this run did not generate."),
    domains: WorkerDomains.nullable().describe("The domains it was given, or `null` when none were."),
  })
  .describe("What `pithy worker add` scaffolded.");

/** `pithy worker list --json`. */
const WorkerListPayload = z
  .object({
    command: z.literal("worker.list").describe('`"worker.list"`.'),
    workers: z
      .array(
        z
          .object({
            ...WorkerIdentity.shape,
            dir: Dir,
            autostart: z.boolean().describe("Whether a plain `pithy dev` starts it on this branch."),
            autostartLocal: z
              .boolean()
              .nullable()
              .describe("Whether `autostart` is this branch's own answer, or `null` with no registry entry."),
            hasWrangler: z.boolean().describe("Whether it carries a `wrangler.jsonc`."),
            port: z.number().int().nullable().describe("Its pinned port, or `null` when none is pinned."),
          })
          .describe("One Worker."),
      )
      .describe("Every Worker under `apps/`."),
    staleAutostart: z
      .array(StaleAutostartRoot)
      .describe("Checkout roots that are gone and still hold autostart answers."),
  })
  .describe("The project's Workers.");

/** `pithy worker remove --json`. */
const WorkerRemovePayload = z
  .object({
    command: z.literal("worker.remove").describe('`"worker.remove"`.'),
    ...WorkerIdentity.shape,
    dir: Dir,
    reconciled: Reconciled,
  })
  .describe("What `pithy worker remove` deleted.");

/** `pithy worker rename --json`. */
const WorkerRenamePayload = z
  .object({
    command: z.literal("worker.rename").describe('`"worker.rename"`.'),
    dryRun: z.boolean().describe("Whether this was `--dry-run`. Nothing was moved or written when it is `true`."),
    ...WorkerIdentity.shape,
    from: z.string().describe("The old name."),
    to: z.string().describe("The new name."),
    dir: Dir,
    script: z
      .object({
        from: z.string().describe("The old deployed script name."),
        to: z.string().describe("The new one."),
      })
      .nullable()
      .describe("The deployed script name it moved between, or `null` when it did not change."),
    orphaned: z.array(z.string().describe("A script name.")).describe("Scripts still deployed under the old name."),
    accountChecked: z.boolean().describe("Whether the account was reached to look for a live script."),
    reconciled: Reconciled,
    rebound: z
      .array(z.string().describe("An `apps/` Worker, by its directory name."))
      .describe("The other Workers whose service bindings now name the new name. Their binding names stay."),
    plan: PlanKey,
  })
  .describe("What `pithy worker rename` moved, or under `--dry-run` would.");

/** The five keys `pithy worker bind --json` and `pithy worker unbind --json` share. */
const WorkerBindingShape = {
  from: z.string().describe("The `apps/` Worker that holds the binding, by its directory name."),
  to: z
    .string()
    .nullable()
    .describe(
      "The Worker it calls: an `apps/` Worker by its directory name, or a kit Worker by its capability. `null` only for an `unbind --binding` that found nothing.",
    ),
  binding: z.string().describe("The binding name in `from`'s env."),
  kind: z
    .enum(["app", "kit"])
    .nullable()
    .describe("`app` for an `apps/` Worker, `kit` for a kit Worker. `null` exactly when `to` is."),
  changed: z.boolean().describe("Whether this run wrote anything. `false` on a run that found it already so."),
};

/** `pithy worker bind --json`. */
const WorkerBindPayload = z
  .object({ command: z.literal("worker.bind").describe('`"worker.bind"`.'), ...WorkerBindingShape })
  .describe("The service binding `pithy worker bind` settled.");

/** `pithy worker unbind --json`: the same keys as `bind`, under its own `command`. */
const WorkerUnbindPayload = z
  .object({ command: z.literal("worker.unbind").describe('`"worker.unbind"`.'), ...WorkerBindingShape })
  .describe("The service binding `pithy worker unbind` settled.");

/** `pithy worker sync --json`. */
const WorkerSyncPayload = z
  .object({
    command: z.literal("worker.sync").describe('`"worker.sync"`.'),
    ...WorkerIdentity.shape,
    routes: z
      .array(
        z
          .object({
            env: z.string().describe("The environment written."),
            pattern: z.string().describe("The hostname the route now points at."),
            baseUrl: z.string().describe("The base URL written to `vars.BASE_URL`."),
            changed: z.boolean().describe("Whether this environment's stanza changed."),
          })
          .describe("One environment's route."),
      )
      .describe("What the `domains` declaration wrote, per environment."),
    runs: z
      .array(
        z
          .object({
            env: z.string().describe("The environment reconciled — `dev` for the top-level stanza."),
            workflows: z
              .array(
                z
                  .object({
                    binding: z.string().describe("The binding the Worker env exposes."),
                    name: z.string().describe("The deployed Workflow name."),
                    class_name: z.string().describe("The exported `WorkflowEntrypoint` subclass."),
                  })
                  .describe("One app Workflow entry."),
              )
              .describe("The app's entries in its `workflows` table."),
            crons: z.array(z.string().describe("A cron schedule.")).describe("The schedules its `triggers` carries."),
            changed: z.boolean().describe("Whether anything moved."),
          })
          .describe("One environment's Workflows and crons."),
      )
      .describe("What the `app` declaration wrote, per environment."),
    serviceRuns: z
      .array(
        z
          .object({
            env: z.string().describe("The environment reconciled — `dev` for the top-level stanza."),
            services: z
              .array(
                z
                  .object({
                    binding: z.string().describe("The binding name in the Worker's env."),
                    service: z.string().describe("The script it calls in this environment."),
                  })
                  .describe("One `services` entry."),
              )
              .describe("The service bindings the app declares, resolved for this environment."),
            changed: z.boolean().describe("Whether this environment's stanza changed."),
          })
          .describe("One environment's service bindings."),
      )
      .describe("What the app's service bindings wrote, per environment."),
  })
  .describe("What `pithy worker sync` wrote.");

const add = withContract(
  defineCommand({
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
          account: await projectCloudflareAccount(projectDir),
          workerName: report.worker,
          interactive: mayPrompt(args.json),
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
        process.stdout.write(`Worker ${report.worker} scaffolded at ${report.dir}.\n`);
        if (wrote && !wrote.declared && asked.domains) {
          process.stdout.write(
            `Could not write the domains block into pithy.config.ts. Add it by hand:\n${renderDomainsBlock(asked.domains)}\n`,
          );
        }
        // Three states, not two. A reconciled run that pinned nothing used to print the sentence below it —
        // "run pithy feature sync to assign a port" — immediately after a sync had assigned one, because the
        // port lookup could not find it (#229). The lookup is fixed; the branch stays three-way so the
        // sentence about assigning a port is only ever printed where none has been.
        if (report.port !== null) {
          process.stdout.write(`Pinned to port ${report.port}.\n`);
        } else if (report.reconciled) {
          process.stdout.write("Reconciled the feature's ports. This worker took none.\n");
        } else {
          process.stdout.write(
            `Ports are assigned when you run ${commandName("feature create")} or ${commandName("feature sync")}.\n`,
          );
        }
        // The worker's `src/index.ts` imports `@pithy-sh/core` and, while the scope is unpublished, its
        // `package.json` declares no range for it — so this said "Done." over a worker that cannot resolve
        // its own entrypoint. `pithy init` printed a notice for the identical gap; this is that notice,
        // from the one function that decides the wording for all three commands.
        for (const line of unpublishedKitNotice() ?? []) process.stdout.write(`${dim(line)}\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkerAddPayload,
    mutates: true,
    idempotent: false,
    needsNetwork: true,
  },
);

/** `pithy worker list` — the discovered workers with autostart state and pinned port. */
const list = withContract(
  defineCommand({
    meta: { name: "list", description: "List the project's workers with their autostart state and pinned port" },
    args: {
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { workers, staleAutostart } = await listWorkers({ projectDir: process.cwd() });
        // Stderr in both modes, on the rule a dev session already states: stdout is the machine's, one
        // object per line, and this is prose for whoever is reading. It is said before the rows because it
        // is the answer to the question the rows provoke — *why is the worker I parked starting again*.
        for (const line of describeStaleAutostartRoots(staleAutostart)) process.stderr.write(`${line}\n`);
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "worker.list", workers, staleAutostart })}\n`);
          return;
        }
        if (workers.length === 0) {
          process.stdout.write(`No workers. Name one and create it with ${commandName("worker add")}.\n`);
          return;
        }
        const rows = workers.map((worker) => {
          const port = worker.port === null ? "—" : String(worker.port);
          // `off here` rather than `manual`, and the distinction is the point (#548): a worker that does
          // not start is never a property of the project any more, so the word has to say whose decision
          // it was. `manual` read like a setting somebody would find in a committed file, and there is no
          // longer any such file to find.
          const auto = worker.autostart ? "autostart" : "off here";
          // The deployed name leads the row, because it is the string the Cloudflare dashboard shows and
          // the one `--worker`, `remove` and `rename` all also accept. The directory is what the adopter
          // acts on, so it is named too rather than left to be inferred from the deployed one — the two
          // are free to be unrelated, which is the whole reason they are separate fields (#144).
          return { name: worker.deployedAs, description: dim(`${worker.worker}  ${auto}  port ${port}`) };
        });
        process.stdout.write(`${formatList(rows)}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkerListPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
  },
);

/** `pithy worker remove <name>` — delete apps/<name> and release its port. */
const remove = withContract(
  defineCommand({
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
        process.stdout.write(`Removed ${report.worker}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkerRemovePayload,
    mutates: true,
    idempotent: false,
    needsNetwork: false,
  },
);

/**
 * The value of a flag a run was not given: asked at a terminal, refused with the flag named anywhere else.
 *
 * A binding has a direction, so a Worker is never named by position here, and a question is asked only where a
 * person can answer it. An agent under `--json` is told which flag to pass and every value it takes.
 */
export async function askFlag(options: {
  flag: string;
  question: string;
  choices: readonly string[];
  interactive: boolean;
  missing: string;
}): Promise<string> {
  if (options.interactive && options.choices.length > 0) {
    const { isCancel, select } = await import("@clack/prompts");
    const answer = await select({
      message: options.question,
      options: options.choices.map((choice) => ({ value: choice, label: choice })),
    });
    if (isCancel(answer)) canceled();
    return answer as string;
  }
  throw new InputRequiredError({
    message: options.missing,
    action: `Pass ${options.flag} <worker>. Known: ${options.choices.join(", ") || "none"}.`,
    flag: options.flag,
    choices: [...options.choices],
  });
}

/** `--from`, or the question that answers it: which `apps/` Worker holds the binding. */
async function askFrom(projectDir: string, from: string | undefined, interactive: boolean): Promise<string> {
  if (from !== undefined) return from;
  const project = await readServiceProject({ projectDir });
  return askFlag({
    flag: "--from",
    question: "Which Worker holds the binding?",
    choices: project.workers.map((worker) => worker.app),
    interactive,
    missing: "Pass --from: the apps/ Worker that holds the binding.",
  });
}

/** `pithy worker bind` — declare a service binding from one of the project's Workers to another. */
const bind = withContract(
  defineCommand({
    meta: { name: "bind", description: "Bind an apps/ Worker to another Worker of this project, kit Workers included" },
    args: {
      from: { type: "string", description: "The apps/ Worker that holds the binding" },
      to: { type: "string", description: "The Worker it calls: an apps/ Worker, or a kit Worker by its capability" },
      binding: { type: "string", description: "The binding name in env (default: --to in upper snake case)" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);
        const from = await askFrom(projectDir, args.from, interactive);
        const to =
          args.to ??
          (await askFlag({
            flag: "--to",
            question: `Which Worker does ${from} call?`,
            choices: bindableFrom(await readServiceProject({ projectDir }), from),
            interactive,
            missing: "Pass --to: the Worker the binding calls.",
          }));
        const report = await bindWorker({
          projectDir,
          from,
          to,
          ...(args.binding === undefined ? {} : { binding: args.binding }),
        });
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "worker.bind", from: report.from, to: report.to, binding: report.binding, kind: report.kind, changed: report.changed })}\n`,
          );
          return;
        }
        process.stdout.write(
          report.changed
            ? `Bound ${report.from} to ${report.to} as ${report.binding}.\n`
            : `${report.from} already binds ${report.to} as ${report.binding}.\n`,
        );
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkerBindPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
  },
);

/** `pithy worker unbind` — take a service binding out, chosen by the Worker it calls or by its name. */
const unbind = withContract(
  defineCommand({
    meta: { name: "unbind", description: "Remove a service binding from an apps/ Worker" },
    args: {
      from: { type: "string", description: "The apps/ Worker that holds the binding" },
      to: { type: "string", description: "The Worker the binding calls" },
      binding: { type: "string", description: "The binding name, instead of --to" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        // First, before anything is read: the call says which entry, by exactly one of the two.
        if ((args.to === undefined) === (args.binding === undefined)) {
          throw new ValidationError({
            message:
              args.to === undefined
                ? "Pass --to or --binding: which binding to remove."
                : "Pass --to or --binding, not both.",
            action: "--to names the Worker it calls. --binding names the binding.",
          });
        }
        const projectDir = process.cwd();
        const from = await askFrom(projectDir, args.from, mayPrompt(args.json));
        const report = await unbindWorker({
          projectDir,
          from,
          ...(args.to === undefined ? {} : { to: args.to }),
          ...(args.binding === undefined ? {} : { binding: args.binding }),
        });
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "worker.unbind", from: report.from, to: report.to, binding: report.binding, kind: report.kind, changed: report.changed })}\n`,
          );
          return;
        }
        if (report.changed) process.stdout.write(`Unbound ${report.binding} from ${report.from}.\n`);
        else if (args.binding !== undefined) process.stdout.write(`${report.from} binds no ${args.binding}.\n`);
        else process.stdout.write(`${report.from} does not bind ${report.to}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkerUnbindPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
    flagGroups: [
      {
        kind: "exactlyOne",
        flags: ["--to", "--binding"],
        rule: "Pass either --to or --binding: exactly one says which binding to remove.",
      },
    ],
  },
);

/**
 * `pithy worker rename --from <old> --to <new>` — move `apps/<old>` and reconcile the names that must move with it.
 *
 * A worker's name is stamped in three places that have to agree — the directory, the deployed script
 * name, and `vars.WORKER`. This is the command that moves all three at once, and points every other Worker's
 * service binding at the new name; `pithy doctor` is what catches a rename done by hand.
 *
 * **`--from` and `--to`, so the `worker` group reads one way (#617).** `bind` and `unbind` name every Worker by
 * flag, because a binding has a direction. The positional `rename <old> <new>` is still accepted, and says once
 * which flags it stands for.
 */
const rename = withContract(
  defineCommand({
    meta: { name: "rename", description: "Rename a worker: move apps/<old> and reconcile its name everywhere" },
    args: {
      from: { type: "string", description: "The worker to rename (an apps/<name> directory)" },
      to: { type: "string", description: "The new name, kebab-case, e.g. web or admin-api" },
      old: { type: "positional", required: false, description: "The worker to rename, positionally (use --from)" },
      new: { type: "positional", required: false, description: "The new name, positionally (use --to)" },
      force: {
        type: "boolean",
        default: false,
        description: "Rename even though a script is deployed under the old name (it stays live)",
      },
      "dry-run": DRY_RUN_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const positional = args.old !== undefined || args.new !== undefined;
        if (positional && (args.from !== undefined || args.to !== undefined)) {
          throw new ValidationError({
            message: "Name the worker by --from and --to, or by position, not both.",
            action: "Pass --from <worker> --to <name>.",
          });
        }
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);
        const from = args.from ?? args.old ?? (await askFrom(projectDir, undefined, interactive));
        const to = args.to ?? args.new ?? (await askNewName(from, interactive));
        if (positional) {
          // Stderr, so a `--json` caller's one line on stdout is still the only one there.
          process.stderr.write(
            `${dim(`The flag form is ${pithyCommand("worker rename", { flags: { "--from": from, "--to": to } })}.`)}\n`,
          );
        }
        const dryRun = args["dry-run"];
        const report = await renameWorker({ projectDir, from, to, force: args.force, dryRun });
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "worker.rename", dryRun, ...report })}\n`);
          return;
        }
        if (report.plan) {
          for (const line of planText(report.plan)) process.stdout.write(`${line}\n`);
          if (report.script) process.stdout.write(`Would deploy as ${report.script.to}, not ${report.script.from}.\n`);
          if (report.orphaned.length > 0) {
            process.stdout.write(`Would leave ${report.orphaned.join(", ")} deployed under the old name.\n`);
          }
          process.stdout.write("Dry run. Nothing written.\n");
          return;
        }
        process.stdout.write(`Renamed ${report.from} to ${report.to}.\n`);
        if (report.script) {
          process.stdout.write(`Deploys as ${report.script.to}, not ${report.script.from}.\n`);
        }
        if (report.rebound.length > 0) {
          process.stdout.write(`Pointed ${report.rebound.join(", ")} at ${report.to}.\n`);
        }
        if (report.orphaned.length > 0) {
          // Under --force only: the old script is still live, still serving, and still billing.
          process.stdout.write(`Still deployed under the old name: ${report.orphaned.join(", ")}. Delete or keep.\n`);
        }
        if (!report.accountChecked) {
          // Never "nothing is deployed" — the account was not reached, and saying so is the whole difference.
          process.stdout.write(dim("The account could not be reached, so nothing was checked for a live script.\n"));
        }
        process.stdout.write(dim("Check anything outside the worker that names it: tsconfig, CI, imports.\n"));
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    // 2: `plan.resources[].kind` takes `queue`, the fourth kind provisioning creates (#662).
    schemaVersion: 2,
    payload: WorkerRenamePayload,
    mutates: true,
    idempotent: false,
    needsNetwork: true,
  },
);

/** `--to` for a rename, asked at a terminal: a name is open, so it is typed rather than chosen. */
export async function askNewName(from: string, interactive: boolean): Promise<string> {
  if (interactive) {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({ message: `Rename ${from} to?` });
    if (isCancel(answer)) canceled();
    return String(answer);
  }
  throw new InputRequiredError({
    message: "Pass --to: the new name.",
    action: `Pass --to <name>, kebab-case, e.g. ${from}-api.`,
    flag: "--to",
  });
}

/** Every `apps/` Worker by both of its names, for resolving a service binding's script per environment. */
async function serviceWorkerNames(projectDir: string): Promise<ServiceWorkerNames[]> {
  return (await discoverWorkers(projectDir)).map((worker) => ({
    app: basename(worker.dir),
    dir: worker.dir,
    deployedAs: worker.name,
  }));
}

/**
 * The declaration narrowed to what `--env` asked for.
 *
 * `applyDomains` writes every environment the declaration names, which is right for a bare run and wrong
 * for a flag that names one: `--env staging` on a project mid-cutover must not also rewrite prod's route.
 * An environment `domains` cannot carry — `dev`, a feature environment, a custom one — narrows to nothing,
 * which is the honest answer rather than an error, because the Workflow half of this command still has
 * work to do for it.
 */
function scopeDomains(domains: WorkerDomains, env: string | undefined): WorkerDomains {
  if (env === undefined) return domains;
  return {
    ...(env === "staging" && domains.staging ? { staging: domains.staging } : {}),
    ...(env === "prod" && domains.prod ? { prod: domains.prod } : {}),
  };
}

/**
 * `pithy worker sync` — write what the Worker's `pithy.config.ts` declares into its `wrangler.jsonc`: the
 * route and `vars.BASE_URL` its `domains` block implies, and the app capability's Workflows and cron
 * schedule, for every environment it declares.
 *
 * **One command for one job: the declaration is the truth, this is what makes wrangler agree with it.**
 * A library capability's Workflows arrive with `pithy <capability> provision`. The adopter's own had no
 * command at all, so the binding table was hand-written per environment against a naming rule that only
 * fails at deploy. `domains` had the same hole and a worse ending: `applyDomains` writes the route, and the
 * only way to reach it was an interactive prompt during `pithy init` or `pithy worker add`, so a
 * declaration added by hand routed nowhere and `doctor` and `deploy` both called it healthy (#264). This is
 * the command `pithy doctor` names when it reports that fault.
 *
 * It writes config and nothing else — no Cloudflare call, no deploy — so it is safe to run on any branch,
 * at any time, as often as you like. A second run reports "already in sync" and touches no file.
 */
const sync = withContract(
  defineCommand({
    meta: {
      name: "sync",
      description: "Write what pithy.config.ts declares — domains routes, Workflows, cron — into wrangler.jsonc",
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
        const interactive = mayPrompt(args.json);
        // Composed for `--env` when one is named. Without it every environment is reconciled from the
        // composition for dev: a `domains` or `app` declaration that differs by environment is written from
        // dev's value into every stanza. That is this command's limit, not a composition for none.
        const target = await targetWorker(env ?? LOCAL_ENVIRONMENT, {
          projectDir,
          interactive,
          ...(args.worker === undefined ? {} : { worker: args.worker }),
        });

        // The address first, and separately from the app capability: `domains` says where this Worker
        // answers, and a Worker with no `app` block still answers somewhere. Validated on the way through —
        // a malformed declaration must name the field here, not produce a route Cloudflare rejects at deploy.
        const domains = loadWorkerDomains(target.config);
        const routes = domains ? await applyDomains(target.dir, scopeDomains(domains, env)) : [];

        const app = target.config.app;
        if (!app && domains === undefined) {
          throw new NotFoundError({
            message: `${target.name} declares neither domains nor an app capability.`,
            action:
              "Declare `domains` or `app` in the worker's pithy.config.ts. This writes what they imply into wrangler.jsonc — the route and BASE_URL, the Workflow bindings and cron.",
          });
        }

        // `requireProjectName`, never `resolveProjectName`: a Workflow name is account-scoped and stable forever
        // once deployed, so a guessed project would name a Workflow another owns. A script name is the same.
        const project = app ? await loadProject(projectDir).then(requireProjectName) : undefined;
        const runs =
          app && project
            ? await reconcileAppWorkflows({
                workerDir: target.dir,
                project,
                app,
                ...(env === undefined ? {} : { env }),
              })
            : [];
        // The app's service bindings, each at the script its target deploys as per environment (#617).
        const declared = (app?.requiredBindings ?? []).flatMap((binding) =>
          binding.type === "service" && binding.service !== undefined
            ? [{ binding: binding.name, target: binding.service }]
            : [],
        );
        const serviceRuns =
          project && declared.length > 0
            ? await reconcileServiceStanzas({
                workerDir: target.dir,
                services: declared,
                scripts: await serviceScripts(project, await serviceWorkerNames(projectDir)),
                ...(env === undefined ? {} : { env }),
              })
            : [];

        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "worker.sync", ...workerIdentity(target), routes, runs, serviceRuns })}\n`,
          );
          return;
        }
        // One sentence for a run that changed nothing, whichever half had nothing to do. A reconcile
        // command is run on a hunch, often, and it has to be obvious when it did nothing.
        if (
          routes.every((route) => !route.changed) &&
          runs.every((run) => !run.changed) &&
          serviceRuns.every((run) => !run.changed)
        ) {
          // "Nothing to sync" is about what was *declared*, not about how many environments were walked.
          // An app capability declaring no Workflows is still reconciled — that is what takes a dropped
          // job's binding out — so a run per environment saying nothing is exactly the empty case.
          const nothing =
            routes.length === 0 &&
            serviceRuns.length === 0 &&
            runs.every((run) => run.workflows.length === 0 && run.crons.length === 0);
          process.stdout.write(
            nothing ? `${target.name} declares nothing to sync.\n` : `${target.name} is already in sync.\n`,
          );
          process.stdout.write(`${formatDone()}\n`);
          return;
        }
        for (const route of routes) {
          if (!route.changed) continue;
          process.stdout.write(`${route.env}: routed to ${route.pattern}. BASE_URL ${route.baseUrl}.\n`);
        }
        for (const run of runs) {
          if (!run.changed) continue;
          const crons = run.crons.length === 0 ? "no cron" : run.crons.join(", ");
          // `nothing` rather than an empty gap: a run that moved to an empty table took a job's binding
          // out, and a line reading ": . no cron." says that as badly as it can be said.
          const bound = run.workflows.length === 0 ? "nothing" : run.workflows.map((entry) => entry.binding).join(", ");
          process.stdout.write(`${run.env}: ${bound} bound. ${crons}.\n`);
        }
        for (const run of serviceRuns) {
          if (!run.changed) continue;
          const bound = run.services.map((entry) => `${entry.binding} to ${entry.service}`).join(", ");
          process.stdout.write(`${run.env}: ${bound}.\n`);
        }
        // Cloudflare resolves class_name in the script the binding names, and that script is this one.
        const classes = [...new Set(runs.flatMap((run) => run.workflows.map((entry) => entry.class_name)))];
        if (classes.length > 0) {
          process.stdout.write(
            dim(`Export a WorkflowEntrypoint subclass from main for each: ${classes.join(", ")}.\n`),
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkerSyncPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
  },
);

export default defineCommand({
  meta: { name: "worker", description: "Manage the project's Workers under apps/ (the dev/deploy registry)" },
  subCommands: { add, list, remove, rename, sync, bind, unbind },
});
