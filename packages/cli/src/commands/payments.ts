// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { callerOf, pithyCommand, rerunRemedy } from "@pithy-sh/core/src/cli/command";
import { fromZodError, InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { z } from "zod";
import { createProjectCliAudit } from "../audit/cliAudit";
import { hostEntrySource } from "../capabilities/hostEntry";
import { hostWorkerFor } from "../capabilities/hostRegistry";
import { capabilityNotComposed } from "../capabilities/notComposed";
import {
  CloudflarePaymentsProvisioner,
  loadPayments,
  type PaymentsEnvResources,
} from "../capabilities/paymentsProvisioner";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients, cloudflareWorkflows } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { DRY_RUN_ARG, emptyPlan, type Plan, PlanKey } from "../plan/plan";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { resolveCapabilityWorker } from "../project/capabilityWorker";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { envArg, requireManagedEnvironment } from "../project/environment";
import {
  type EnvironmentReadiness,
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  ProvisionReportExitCode,
  readyStanza,
  requireReadyEnvironments,
  SkippedEnvironment,
  writeProvisionReport,
} from "../project/environmentReadiness";
import { workerDirName } from "../project/workerIdentity";
import { projectCapabilities, type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { secretsDatabaseMissing } from "../provision/missingDatabase";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy payments provision` / `reconcile`.
 *
 * `pithy add payments` writes bindings and touches no Cloudflare account. This command stands up the one
 * thing those bindings point at: the prebuilt reconcile worker that hosts the nightly pass, per environment.
 *
 * **No credential is written here, and that is not an omission.** Apple's `.p8`, Google's service-account key,
 * Stripe's key pair, and Lemon Squeezy's API key and webhook secret are downloaded by a human from four
 * consoles — nothing can mint them. They go in through `pithy secrets set` under
 * `payments-provider-credentials`, and this command deploys the worker that reads them. A provision run
 * before the secrets are set still succeeds; the first pass is what reports the missing rail.
 *
 * `reconcile` runs the same pass on demand, in a deployed environment, and waits for its report. It is the
 * support tool the issue names — "my subscription isn't showing up" is answered by `--subject`, through exactly
 * the steps the cron runs, so an answer here is an answer about production behavior rather than about a
 * script somebody wrote for the occasion.
 */

/**
 * The audit emitter for a payments command. Provisioning spans every managed environment at once, so there is
 * no single target env to key the audit database on — `"dev"` is the fallback, matching `pithy storage` and
 * `pithy media`. A no-op when the credentials or the audit capability are not there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  // `env` selects the audit database only, and defaults to `dev`: this command spans environments, so no
  // single value is true for the run; each event states the environment it acted on.
  return createProjectCliAudit({ projectDir, accountId, apiToken });
}

/**
 * The payments catalog a run that writes into no Worker reads: the first Worker composing payments.
 *
 * `reconcile` alone, which dispatches into an already-deployed Workflow and touches no Worker's files. A run
 * that writes into a Worker reads that Worker's own capability through `resolveCapabilityWorker` instead.
 */
async function loadProjectPaymentsConfig(projectDir: string) {
  const { isPaymentsCapability } = await loadPayments(projectDir);
  const workers = await resolveWorkers({ projectDir });
  const capability = projectCapabilities(workers).find(isPaymentsCapability);
  if (!capability) {
    throw capabilityNotComposed(
      "payments",
      {
        message: "The payments capability is not configured.",
        action: (add) => `Add \`payments({ rails: { ... }, products: { ... } })\` to pithy.config.ts (run ${add}).`,
      },
      { projectDir, workerDirs: workers.map((worker) => worker.dir) },
    );
  }
  return capability.paymentsConfig;
}

/**
 * Where a run's payments config comes from. `worker` for a run that deploys against and writes into one app
 * Worker — the config is that Worker's own. `project` for a run that writes into none.
 */
type PaymentsSource = { kind: "worker"; worker?: string } | { kind: "project" };

/**
 * Resolve the per-environment resources the reconcile worker binds: the app `DB` id, already read and
 * judged ready by {@link environmentReadiness}, and a live lookup of the env's secrets database — which
 * does still throw, because by the time an environment is ready a missing secrets store is a genuine
 * failure rather than a not-yet.
 *
 * The app database id is a lookup rather than a file read because the decision it used to make is now made
 * once, before anything is deployed: an environment with no app database is skipped and reported instead
 * of failing the run part way through (#512).
 *
 * Which Worker is the app Worker? Every Worker owns its own `wrangler.jsonc` under `apps/<name>/` and
 * **there is no root Worker** (CLAUDE.md §CLI), so a project with several names one with `--worker` and one
 * Worker needs no ceremony — the shape `pithy email` and `pithy support` already had. This command read
 * `<root>/wrangler.jsonc` instead, a file no scaffolded project has, so every run died on a missing file
 * before it reached the partition, the skip, the report or the exit code: #512 claimed six commands and
 * delivered two.
 */
function buildResolveEnv(
  /** The partition this run acts on, memoized — `reconcile` shares the builder and never resolves one. */
  appReadiness: () => Promise<{ readiness: EnvironmentReadiness }>,
  cf: CloudflareClients,
  /**
   * The project name the secrets database is found by — `<project>-<env>-secrets`. Resolved once by the
   * caller via `requireProjectName`, never guessed: the lookup is by name, so a wrong one either reports
   * a database that "does not exist" or binds another project's secrets store.
   */
  project: string,
  /**
   * The account the secrets database is looked for on, and what vouches for it (#378).
   *
   * The refusal below reads a missing database as "provision it first". Against an account nothing
   * claims, that database is missing because this run asked the wrong account — and the sentence sends
   * an operator to run a provisioning command they have already run.
   */
  account: ConfirmedAccount,
): (env: ManagedEnvironment) => Promise<PaymentsEnvResources> {
  return async (env) => {
    const { appDatabaseId } = readyStanza((await appReadiness()).readiness, env);
    const secretsDb = await findOnConfirmedAccount({
      ...account,
      what: `the ${managerWorkerName(project, env)} database`,
      find: () => cf.d1Provisioner().findDatabaseByName(managerWorkerName(project, env)),
    });
    if (!secretsDb) {
      throw secretsDatabaseMissing(
        env,
        managerWorkerName(project, env),
        "the reconcile worker reads the rails' credentials from it.",
      );
    }
    return { appDatabaseId, secretsDatabaseId: secretsDb.uuid };
  };
}

/**
 * Build the live provisioner for a project, and resolve the project name its worker and Workflow names
 * lead with. `requireProjectName` refuses to guess: the deployed script name has to be the same one the
 * app's `script_name` binding points at, and a guess would bind a Worker that does not exist.
 */
async function buildProvisioner(projectDir: string, source: PaymentsSource) {
  // The name first, before the credentials: both are local checks, and a config that cannot name the
  // project is not a Cloudflare problem to report as one.
  const config = await loadProject(projectDir);
  const project = requireProjectName(config);
  // The project's own environment set, read once here and carried, so provisioning and `--env` agree.
  const environments = loadProjectEnvironments(config);
  const { account, accountId, apiToken, storeId } = commandCredentials(await projectCloudflareAccount(projectDir), {
    projectDir,
    why: "the reconcile worker decrypts the rails' credentials from it",
  });
  // A run that writes into a Worker reads the catalog off **that** Worker, in the same resolution that names
  // it — the reconcile worker is deployed with the catalog of the Worker whose stanza gets its binding, never
  // a sibling's (#590 review). `reconcile` resolves no Worker: it dispatches into an already-deployed
  // Workflow, and resolving one would be a new way for a support query to fail.
  let appWorker: ResolvedWorker | undefined;
  let composed: Capability | undefined;
  let paymentsConfig: Awaited<ReturnType<typeof loadProjectPaymentsConfig>>;
  if (source.kind === "worker") {
    const { isPaymentsCapability } = await loadPayments(projectDir);
    const resolved = await resolveCapabilityWorker({
      projectDir,
      ...(source.worker !== undefined ? { worker: source.worker } : {}),
      name: "payments",
      is: isPaymentsCapability,
    });
    appWorker = resolved.worker;
    composed = resolved.capability;
    paymentsConfig = resolved.capability.paymentsConfig;
  } else {
    paymentsConfig = await loadProjectPaymentsConfig(projectDir);
  }
  // Which environments a run can act on, read once per run and memoized. An environment whose app database
  // is not provisioned yet is skipped and reported, never fatal (#512). A thunk rather than an eager read,
  // because only `provision` deploys and reads a stanza.
  let readiness: Promise<{ appWorker: ResolvedWorker; readiness: EnvironmentReadiness }> | undefined;
  const appReadiness = () => {
    readiness ??= (async () => {
      if (appWorker === undefined) {
        throw new InternalError({
          message: "This payments run resolved no app Worker, so it has no environment to deploy.",
          detail: "appReadiness called from a run built with source kind `project`",
        });
      }
      return {
        appWorker,
        readiness: await environmentReadiness({
          workerDir: appWorker.dir,
          label: `${appWorker.name}'s wrangler.jsonc`,
          environments,
          productionEnvironments: config.seed?.productionEnvironments,
        }),
      };
    })();
    return readiness;
  };
  const cf = await cloudflareClients({ accountId, apiToken });
  return {
    project,
    environments,
    appReadiness,
    paymentsConfig,
    provisioner: new CloudflarePaymentsProvisioner({
      cf,
      projectDir,
      project,
      accountId,
      apiToken,
      storeId,
      paymentsConfig,
      // The ledger, handed to the reconcile host when the catalog credits a balance — asked only when a deploy
      // runs, which is only ever from a resolved Worker (#645).
      hostEntry: () => {
        const spec = hostWorkerFor("payments");
        return spec && composed ? hostEntrySource(projectDir, spec, composed, []) : undefined;
      },
      resolveEnv: buildResolveEnv(appReadiness, cf, project, account),
      workflows: await cloudflareWorkflows({ accountId, apiToken }),
      audit: await buildAudit(projectDir, accountId, apiToken),
    }),
  };
}

const Skipped = z
  .array(SkippedEnvironment)
  .describe("One entry per declared environment nothing was provisioned for. Empty when none was skipped.");

/** `pithy payments provision --json`. `docs/commands/payments.md`. */
const PaymentsProvisionPayload = z
  .object({
    command: z.literal("payments provision").describe('`"payments provision"`.'),
    environments: z
      .array(z.string().describe("An environment."))
      .describe("The environments whose reconcile Worker was deployed."),
    skippedEnvironments: Skipped,
    exitCode: ProvisionReportExitCode,
  })
  .describe("What `pithy payments provision` provisioned.");

const Count = (what: string) => z.number().int().optional().describe(what);

/** `pithy payments reconcile --json`. */
const PaymentsReconcilePayload = z
  .object({
    command: z.literal("payments reconcile").describe('`"payments reconcile"`.'),
    env: z.string().describe("The environment reconciled."),
    dryRun: z.boolean().describe("Whether this was `--dry-run`. No drift was repaired when it is `true`."),
    report: z
      .looseObject({
        scanned: Count("Entitlements read."),
        drifted: Count("Entitlements whose state disagreed with the rail. Repaired unless `--dry-run`."),
        unchanged: Count("Entitlements that agreed."),
        skipped: Count("Entitlements not checked."),
        failed: Count("Entitlements the rail could not answer for."),
      })
      .nullable()
      .describe("The pass's own report, or `null` when the Workflow returned none."),
    plan: PlanKey,
  })
  .describe("What `pithy payments reconcile` found.");

/**
 * **`pithy payments reconcile --dry-run`, as the one plan every dry run shares (#697).** The pass runs in
 * the deployed Workflow and reports the drift it would repair; that count is the plan's one `repair`. The
 * run itself is a Workflow instance started on Cloudflare, which a dry run starts too — the one dry run
 * that calls Cloudflare to plan — so the plan says so rather than leaving it to be discovered.
 */
export function reconcilePlan(env: string, rail: string | undefined, drifted: number | undefined): Plan {
  return {
    ...emptyPlan(),
    data:
      drifted !== undefined && drifted > 0
        ? [{ store: "payments", target: rail ?? "every rail", count: drifted, action: "repair" }]
        : [],
    notes: [
      `The pass ran in ${env}'s reconcile Workflow, which a dry run starts too. It read the entitlements in scope and repaired none.`,
    ],
  };
}

const provision = withContract(
  defineCommand({
    meta: { name: "provision", description: "Deploy the reconciliation Workflow worker and write its bindings" },
    args: {
      json: { type: "boolean", default: false, description: "Machine-readable output" },
      worker: {
        type: "string",
        description:
          "The app worker whose wrangler.jsonc carries the per-environment DB binding and receives the PAYMENTS_RECONCILE binding (default: the project's only worker)",
      },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const { provisioner, project, appReadiness } = await buildProvisioner(projectDir, {
          kind: "worker",
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
        });
        const { paymentsWorkflowRegistry, PAYMENTS_CAPABILITY } = await loadPayments(projectDir);

        // The account check first, before a single deploy. Failing here means failing before one environment is
        // half provisioned rather than part way through the fan-out.
        await provisioner.preflight();

        const { appWorker, readiness } = await appReadiness();
        // The ready list, not the declaration: a staging-only bring-up deploys staging's reconcile worker and
        // leaves production with nothing, rather than failing after staging's is already up.
        const environments: ManagedEnvironment[] = readiness.ready;
        for (const env of environments) {
          await provisioner.deployWorker(env);
          // Only now can the Workflow binding be written. `pithy add payments` cannot: wrangler requires a
          // `name` and a `class_name` on every `workflows` entry, and the deployed name is per environment
          // (`<project>-<env>-payments-reconcile`). An entry short of either field fails the whole config, so `add`
          // emits none and this completes it — see capabilities/add.ts.
          // Into the **app Worker's** `wrangler.jsonc`, the same file readiness was read from. A project
          // root holds no wrangler config at all, so writing there wrote nothing an adopter ever loads.
          await applyAppBindings(appWorker.dir, env, {
            workflows: appWorkflowBindings(paymentsWorkflowRegistry, { project, capability: PAYMENTS_CAPABILITY, env }),
          });
        }

        // The caller's own run, as the refusal names it to run again: every flag it was given, and the Worker it
        // resolved when none was named (#711).
        const again = rerunRemedy(callerOf("payments provision", args), {
          flags: { "--worker": workerDirName(appWorker) },
          productionEnvironments: readiness.productionEnvironments,
        });
        if (args.json) {
          // One outcome (#711): the error line alone when nothing was provisioned, or this report alone.
          writeProvisionReport(
            {
              command: "payments provision",
              environments,
              skippedEnvironments: readiness.skipped,
            },
            readiness,
            again,
          );
          return;
        }
        process.stdout.write(
          formatEnvironmentOutcomes(
            environmentOutcomes(readiness, () => "reconcile worker deployed, PAYMENTS_RECONCILE bound"),
          ),
        );
        requireReadyEnvironments(readiness, again);
        process.stdout.write(
          `Set each rail's credentials with \`${pithyCommand("secrets update", { args: ["payments-provider-credentials"] })}\` — nothing can mint them.\n`,
        );
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: PaymentsProvisionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

const reconcile = withContract(
  defineCommand({
    meta: { name: "reconcile", description: "Run a reconciliation pass now and report the drift it found" },
    args: {
      env: { ...envArg("Target environment"), default: "staging" },
      // One flag, not a `--subject-type`/`--subject-id` pair. A holder is `(kind, id)` and half of one names
      // nobody, so two flags would need a cross-arg rule to say what a single flag says by existing. The
      // spelling is `encodeSubjectReference`'s — the same string the rails stamp into a store — so an operator
      // reading a provider dashboard can paste what they see.
      subject: {
        type: "string",
        description: "Reconcile one holder only, as `user:<id>` or `organization:<id>` — the support path",
      },
      // Every rail is named, in the spelling the parse accepts — `lemonSqueezy`, camelCase, the same
      // identifier the config and the credential bundle key on. A help line that lists three of four rails
      // is why somebody types the fourth as a guess.
      rail: { type: "string", description: "Reconcile one rail only: apple, google, stripe, lemonSqueezy, or paddle" },
      "dry-run": DRY_RUN_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        // Checked, not cast. `--env dev` is a real thing to type and dev is local-only, so the cast turned a
        // one-line answer into a lookup for `<project>-dev-payments-reconcile` and a raw Cloudflare request
        // error from a worker that was never deployed. Still checked first, before any Cloudflare client is
        // built: the declaration it is checked against is a config read, so the refusal costs nothing.
        const projectDir = process.cwd();
        const config = await loadProject(projectDir);
        // The name before the flag, because both payments names lead with it and a guessed one dispatches
        // to a script that does not exist — the refusal that helps most goes first. Both are reads of this
        // project's own config, so the whole check still happens before any Cloudflare client is built.
        requireProjectName(config);
        const env = requireManagedEnvironment(args.env, loadProjectEnvironments(config));
        const { provisioner } = await buildProvisioner(projectDir, { kind: "project" });
        const { PaymentsReconcileParams, decodeSubjectReference } = await loadPayments(projectDir);

        // Decoded through payments' own strict decoder, never split here. `--subject ada` is the shape
        // somebody types from memory, and a lenient read of it would narrow the pass to whichever user *or*
        // organization carries that id — a support tool answering about the wrong holder, silently. The
        // refusal names the format instead.
        const subject = args.subject === undefined ? undefined : decodeSubjectReference(args.subject);
        if (args.subject !== undefined && subject === undefined) {
          throw new ValidationError({
            message: `"${args.subject}" does not name a holder.`,
            action: "Pass --subject user:<id> or --subject organization:<id>.",
          });
        }

        // Parsed here rather than sent raw: a mistyped rail is a message in this terminal instead of a Workflow
        // instance that starts, fails a step, and burns its retry budget where nobody is watching.
        //
        // **Mapped, not thrown raw.** "A message in this terminal" means the house two-line refusal, and a
        // bare `ZodError` is a stack trace — `--rail lemon-squeezy` is exactly the typo that used to earn
        // one. The rails are not listed again here: Zod's own message names the accepted set, so the list
        // stays in one place and gains the next rail on the day the schema does.
        const parsed = PaymentsReconcileParams.safeParse({
          ...(subject ?? {}),
          ...(args.rail === undefined ? {} : { rail: args.rail }),
          ...(args["dry-run"] ? { dryRun: true } : {}),
        });
        if (!parsed.success) {
          throw fromZodError(parsed.error, {
            message: parsed.error.issues.map((issue) => issue.message).join(" "),
            action: "Spell --rail the way pithy.config.ts spells it, or drop it to reconcile every rail.",
          });
        }
        const params = parsed.data;

        const report = (await provisioner.reconcile(env, params)) as {
          scanned?: number;
          drifted?: number;
          unchanged?: number;
          skipped?: number;
          failed?: number;
        } | null;

        const dryRun = args["dry-run"];
        if (args.json) {
          const plan = dryRun ? reconcilePlan(env, args.rail, report?.drifted) : undefined;
          process.stdout.write(`${formatJsonLine({ command: "payments reconcile", env, dryRun, report, plan })}\n`);
          return;
        }
        process.stdout.write(
          `${report?.scanned ?? 0} scanned, ${report?.drifted ?? 0} drifted, ${report?.skipped ?? 0} skipped, ${report?.failed ?? 0} failed.\n`,
        );
        // A rising drift count is the signal the webhook path is broken, so it is worth one plain sentence here
        // rather than only a number.
        if ((report?.drifted ?? 0) > 0 && !dryRun) {
          process.stdout.write(
            "Drift was repaired. Repeated drift means webhooks are not arriving — check the rail.\n",
          );
        }
        process.stdout.write(dryRun ? "Dry run. Nothing repaired.\n" : `${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: PaymentsReconcilePayload,
    // Repairs drift, unless `--dry-run`.
    mutates: true,
    idempotent: true,
    needsNetwork: true,
    // The project's own `@pithy-sh/payments` parses `--rail` at run time and cannot be imported here, so this
    // list is a copy — held to `PaymentsRail.options` by `payments.test.ts`, which goes red the day they part.
    flags: { rail: { enum: ["apple", "google", "stripe", "lemonSqueezy", "paddle"] } },
  },
);

export default defineCommand({
  meta: { name: "payments", description: "Provision the reconciliation Workflow, and run a pass on demand" },
  subCommands: { provision, reconcile },
});
