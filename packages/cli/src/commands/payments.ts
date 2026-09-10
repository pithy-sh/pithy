// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { createProjectCliAudit } from "../audit/cliAudit";
import {
  CloudflarePaymentsProvisioner,
  loadPayments,
  type PaymentsEnvResources,
} from "../capabilities/paymentsProvisioner";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients, cloudflareWorkflows } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { envArg, requireManagedEnvironment } from "../project/environment";
import {
  type EnvironmentReadiness,
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  readyStanza,
  requireReadyEnvironments,
} from "../project/environmentReadiness";
import { projectCapabilities, type ResolvedWorker, resolveSingleWorker, resolveWorkers } from "../project/workerScope";
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

/** Load the payments capability's resolved catalog from `pithy.config.ts`. */
async function loadPaymentsConfig(projectDir: string) {
  const { isPaymentsCapability } = await loadPayments();
  // Capabilities live in each Worker's `apps/<name>/pithy.config.ts`; provisioning is one project-wide
  // decision, so the first Worker composing this capability provides it.
  const capability = (await resolveWorkers({ projectDir }).then(projectCapabilities)).find(isPaymentsCapability);
  if (!capability) {
    throw new ValidationError({
      message: "The payments capability is not configured.",
      action: "Add `payments({ rails: { ... }, products: { ... } })` to pithy.config.ts (run `pithy add payments`).",
    });
  }
  return capability.paymentsConfig;
}

/**
 * The Cloudflare credentials this command provisions with, for **the account the project belongs to**.
 *
 * The account is a parameter rather than an ambient, so this cannot resolve before something has
 * established which account the project is for (#206).
 *
 * It also carries **what vouches for the account** (#378). A bare id is what every destructive and
 * creative site here used to hold, and an id alone cannot tell "this account has no such Worker" from
 * "I asked an account nothing claims" — the two arrive as one empty listing.
 */
function loadCloudflareCreds(account: CloudflareAccountSelection | null): {
  account: ConfirmedAccount;
  accountId: string;
  apiToken: string;
  storeId: string;
} {
  const vars = cloudflareEnv({ account });
  const confirmation = cloudflareAccountConfirmation({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.",
    });
  }
  if (!storeId) {
    throw new ValidationError({
      message: "The CF Secrets Store id is missing.",
      action:
        "Run pithy add secrets to record SECRETS_STORE_ID (the reconcile worker decrypts the rails' credentials from it).",
    });
  }
  return { account: { accountId, confirmation }, accountId, apiToken, storeId };
}

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
      throw new ValidationError({
        message: `The ${env} secrets database (${managerWorkerName(project, env)}) does not exist.`,
        action: "Run `pithy secrets provision` first — the reconcile worker reads the rails' credentials from it.",
      });
    }
    return { appDatabaseId, secretsDatabaseId: secretsDb.uuid };
  };
}

/**
 * Build the live provisioner for a project, and resolve the project name its worker and Workflow names
 * lead with. `requireProjectName` refuses to guess: the deployed script name has to be the same one the
 * app's `script_name` binding points at, and a guess would bind a Worker that does not exist.
 */
async function buildProvisioner(projectDir: string, worker?: string) {
  // The name first, before the credentials: both are local checks, and a config that cannot name the
  // project is not a Cloudflare problem to report as one.
  const config = await loadProject(projectDir);
  const project = requireProjectName(config);
  // The project's own environment set, read once here and carried, so provisioning and `--env` agree.
  const environments = loadProjectEnvironments(config);
  const { account, accountId, apiToken, storeId } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
  const paymentsConfig = await loadPaymentsConfig(projectDir);
  // Which environments a run can act on, read once per run and memoized. An environment whose app database
  // is not provisioned yet is skipped and reported, never fatal (#512). A thunk rather than an eager read
  // because `reconcile` shares this builder and dispatches into an already-deployed Workflow — making it
  // resolve a Worker and read that Worker's `wrangler.jsonc` would be a new way for a support query to
  // fail, and `resolveSingleWorker` genuinely can fail (a project with several Workers and no `--worker`).
  // So the Worker is resolved **inside** the thunk, not beside it.
  let readiness: Promise<{ appWorker: ResolvedWorker; readiness: EnvironmentReadiness }> | undefined;
  const appReadiness = () => {
    readiness ??= (async () => {
      const appWorker = await resolveSingleWorker({
        projectDir,
        ...(worker !== undefined ? { worker } : {}),
      });
      return {
        appWorker,
        readiness: await environmentReadiness({
          workerDir: appWorker.dir,
          label: `${appWorker.name}'s wrangler.jsonc`,
          environments,
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
      project,
      accountId,
      apiToken,
      storeId,
      paymentsConfig,
      resolveEnv: buildResolveEnv(appReadiness, cf, project, account),
      workflows: await cloudflareWorkflows({ accountId, apiToken }),
      audit: await buildAudit(projectDir, accountId, apiToken),
    }),
  };
}

const provision = defineCommand({
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
      const { provisioner, project, appReadiness } = await buildProvisioner(projectDir, args.worker);
      const { paymentsWorkflowRegistry, PAYMENTS_CAPABILITY } = await loadPayments();

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

      if (args.json) {
        // Written before the refusal below, so a run in which everything skipped still carries the
        // per-environment structure on stdout beside the `{"error":…}` line on stderr.
        process.stdout.write(
          `${formatJsonLine({ command: "payments provision", environments, skippedEnvironments: readiness.skipped })}\n`,
        );
        requireReadyEnvironments(readiness, "pithy payments provision");
        return;
      }
      process.stdout.write(
        formatEnvironmentOutcomes(
          environmentOutcomes(readiness, () => "reconcile worker deployed, PAYMENTS_RECONCILE bound"),
        ),
      );
      requireReadyEnvironments(readiness, "pithy payments provision");
      process.stdout.write(
        "Set each rail's credentials with `pithy secrets set payments-provider-credentials` — nothing can mint them.\n",
      );
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const reconcile = defineCommand({
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
    "dry-run": { type: "boolean", default: false, description: "Report the drift and write nothing" },
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
      const { provisioner } = await buildProvisioner(projectDir);
      const { PaymentsReconcileParams, decodeSubjectReference } = await loadPayments();

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

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "payments reconcile", env, report })}\n`);
        return;
      }
      process.stdout.write(
        `${report?.scanned ?? 0} scanned, ${report?.drifted ?? 0} drifted, ${report?.skipped ?? 0} skipped, ${report?.failed ?? 0} failed.\n`,
      );
      // A rising drift count is the signal the webhook path is broken, so it is worth one plain sentence here
      // rather than only a number.
      if ((report?.drifted ?? 0) > 0 && !args["dry-run"]) {
        process.stdout.write("Drift was repaired. Repeated drift means webhooks are not arriving — check the rail.\n");
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "payments", description: "Provision the reconciliation Workflow, and run a pass on demand" },
  subCommands: { provision, reconcile },
});
