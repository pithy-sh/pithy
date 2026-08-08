// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { createCliAudit } from "../audit/cliAudit";
import {
  CloudflarePaymentsProvisioner,
  loadPayments,
  type PaymentsEnvResources,
} from "../capabilities/paymentsProvisioner";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { envArg, requireManagedEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy payments provision` / `reconcile`.
 *
 * `pithy add payments` writes bindings and touches no Cloudflare account. This command stands up the one
 * thing those bindings point at: the prebuilt reconcile worker that hosts the nightly pass, per environment.
 *
 * **No credential is written here, and that is not an omission.** Apple's `.p8`, Google's service-account key,
 * and Stripe's key pair are downloaded by a human from three consoles — nothing can mint them. They go in
 * through `pithy secrets set` under `payments-provider-credentials`, and this command deploys the worker that
 * reads them. A provision run before the secrets are set still succeeds; the first pass is what reports the
 * missing rail.
 *
 * `reconcile` runs the same pass on demand, in a deployed environment, and waits for its report. It is the
 * support tool the issue names — "my subscription isn't showing up" is answered by `--user`, through exactly
 * the steps the cron runs, so an answer here is an answer about production behaviour rather than about a
 * script somebody wrote for the occasion.
 */

/**
 * The audit emitter for a payments command. Provisioning spans every managed environment at once, so there is
 * no single target env to key the audit database on — `"dev"` is the fallback, matching `pithy storage` and
 * `pithy media`. A no-op when the credentials or the audit capability are not there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    // `env` selects the audit database only. This command spans environments, so no single
    // value is true for the run; each event states the environment it acted on.
    env: "dev",
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
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
 */
function loadCloudflareCreds(account: CloudflareAccountSelection | null): {
  accountId: string;
  apiToken: string;
  storeId: string;
} {
  const vars = cloudflareEnv({ account });
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
  return { accountId, apiToken, storeId };
}

/** A wrangler env stanza — only the fields the reconcile worker deploy reads from the project's config. */
interface WranglerStanza {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, WranglerStanza | undefined>;
}

/**
 * Resolve the per-environment resources the reconcile worker binds, from the project's `wrangler.jsonc` (the
 * app `DB` id per env) and a live lookup of the env's secrets database. Each missing value throws an
 * actionable error rather than deploying a half-wired worker.
 */
function buildResolveEnv(
  projectDir: string,
  cf: CloudflareClients,
  /**
   * The project name the secrets database is found by — `<project>-<env>-secrets`. Resolved once by the
   * caller via `requireProjectName`, never guessed: the lookup is by name, so a wrong one either reports
   * a database that "does not exist" or binds another project's secrets store.
   */
  project: string,
): (env: ManagedEnvironment) => Promise<PaymentsEnvResources> {
  return async (env) => {
    const config = parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerStanza;
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to wrangler.jsonc with its DB binding.`,
      });
    }
    const appDatabaseId = stanza.d1_databases?.find((database) => database.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no DB database_id.`,
        action: `Provision the ${env} app database and set its id on the DB binding — the purchase rows live there.`,
      });
    }
    const secretsDb = await cf.d1Provisioner().findDatabaseByName(managerWorkerName(project, env));
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
async function buildProvisioner(projectDir: string) {
  // The name first, before the credentials: both are local checks, and a config that cannot name the
  // project is not a Cloudflare problem to report as one.
  const project = requireProjectName(await loadProject(projectDir));
  const { accountId, apiToken, storeId } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
  const paymentsConfig = await loadPaymentsConfig(projectDir);
  const cf = new CloudflareClients({ accountId, apiToken });
  return {
    project,
    paymentsConfig,
    provisioner: new CloudflarePaymentsProvisioner({
      cf,
      project,
      accountId,
      apiToken,
      storeId,
      paymentsConfig,
      resolveEnv: buildResolveEnv(projectDir, cf, project),
      workflows: new CloudflareWorkflowsClient({ accountId, apiToken }),
      audit: await buildAudit(projectDir, accountId, apiToken),
    }),
  };
}

const provision = defineCommand({
  meta: { name: "provision", description: "Deploy the reconciliation Workflow worker and write its bindings" },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { provisioner, project } = await buildProvisioner(projectDir);
      const { paymentsWorkflowRegistry, PAYMENTS_CAPABILITY } = await loadPayments();

      // The account check first, before a single deploy. Failing here means failing before one environment is
      // half provisioned rather than part way through the fan-out.
      await provisioner.preflight();

      const environments: ManagedEnvironment[] = [...managedEnvironments()];
      for (const env of environments) {
        await provisioner.deployWorker(env);
        // Only now can the Workflow binding be written. `pithy add payments` cannot: wrangler requires a
        // `name` and a `class_name` on every `workflows` entry, and the deployed name is per environment
        // (`<project>-<env>-payments-reconcile`). An entry short of either field fails the whole config, so `add`
        // emits none and this completes it — see capabilities/add.ts.
        await applyAppBindings(projectDir, env, {
          workflows: appWorkflowBindings(paymentsWorkflowRegistry, { project, capability: PAYMENTS_CAPABILITY, env }),
        });
      }

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "payments provision", environments })}\n`);
        return;
      }
      for (const env of environments) {
        process.stdout.write(`${env}: reconcile worker deployed, PAYMENTS_RECONCILE bound.\n`);
      }
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
    user: { type: "string", description: "Reconcile one user's purchases only — the support path" },
    rail: { type: "string", description: "Reconcile one rail only: apple, google, or stripe" },
    "dry-run": { type: "boolean", default: false, description: "Report the drift and write nothing" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      // Checked, not cast. `--env dev` is a real thing to type and dev is local-only, so the cast turned a
      // one-line answer into a lookup for `<project>-dev-payments-reconcile` and a raw Cloudflare request
      // error from a worker that was never deployed. Checked first, before any Cloudflare client is built.
      const env = requireManagedEnvironment(args.env);
      const projectDir = process.cwd();
      const { provisioner } = await buildProvisioner(projectDir);
      const { PaymentsReconcileParams } = await loadPayments();

      // Parsed here rather than sent raw: a mistyped rail is a message in this terminal instead of a Workflow
      // instance that starts, fails a step, and burns its retry budget where nobody is watching.
      const params = PaymentsReconcileParams.parse({
        ...(args.user === undefined ? {} : { userId: args.user }),
        ...(args.rail === undefined ? {} : { rail: args.rail }),
        ...(args["dry-run"] ? { dryRun: true } : {}),
      });

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
