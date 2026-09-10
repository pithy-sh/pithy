// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { createProjectCliAudit } from "../audit/cliAudit";
import { resolveR2Credentials } from "../capabilities/r2Bucket";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import {
  CloudflareStorageDeprovisioner,
  CloudflareStorageProvisioner,
  loadStorage,
  type StorageEnvResources,
} from "../capabilities/storageProvisioner";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import {
  type EnvironmentReadiness,
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  readyStanza,
  requireReadyEnvironments,
} from "../project/environmentReadiness";
import { projectCapabilities, resolveSingleWorker, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy storage provision` / `deprovision`.
 *
 * `pithy add storage` writes bindings and touches no Cloudflare account. This command stands up what
 * those bindings point at: the per-environment R2 bucket, the `storage-r2-credentials` secret, and the
 * prebuilt sweep worker that hosts the daily orphan reconciliation.
 *
 * **The R2 key pair is supplied, not minted.** Cloudflare exposes no API for creating an R2 S3
 * access-key pair, so it comes from flags or `R2_CREDENTIALS` in `.dev.vars` and is written into the
 * secret as given. Make the pair under R2 → Manage API tokens.
 */

/**
 * The audit emitter for a storage command. Provisioning spans every managed environment at once, so
 * there is no single target env to key the audit database on — `"dev"` is the fallback (mirrors
 * `pithy media`'s convention for env-spanning commands). A no-op when creds or the audit capability
 * aren't there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  // `env` selects the audit database only, and defaults to `dev`: this command spans environments, so no
  // single value is true for the run; each event states the environment it acted on.
  return createProjectCliAudit({ projectDir, accountId, apiToken });
}

/** Load the storage capability's resolved config from `pithy.config.ts`. */
async function loadStorageConfig(projectDir: string) {
  const { isStorageCapability } = await loadStorage(projectDir);
  // Capabilities live in each Worker's `apps/<name>/pithy.config.ts`; provisioning is one
  // project-wide decision, so the first Worker composing this capability provides it.
  const capability = (await resolveWorkers({ projectDir }).then(projectCapabilities)).find(isStorageCapability);
  if (!capability) {
    throw new ValidationError({
      message: "The storage capability is not configured.",
      action: "Add `storage({ ... })` to pithy.config.ts (run `pithy add storage`).",
    });
  }
  return capability.storageConfig;
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
  r2Raw: string | undefined;
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
      action: "Run pithy add secrets to record SECRETS_STORE_ID (the sweep worker decrypts its credentials from it).",
    });
  }
  return { account: { accountId, confirmation }, accountId, apiToken, storeId, r2Raw: vars.R2_CREDENTIALS };
}

/**
 * Resolve the per-environment resources the sweep worker binds: the app `DB` id, already read and judged
 * ready by {@link environmentReadiness}, and a live lookup of the env's secrets database — which does still
 * throw, because by the time an environment is ready a missing secrets store is a genuine failure rather
 * than a not-yet.
 *
 * Which Worker is the app Worker? Every Worker owns its own `wrangler.jsonc` under `apps/<name>/` and
 * **there is no root Worker** (CLAUDE.md §CLI), so a project with several names one with `--worker` and one
 * Worker needs no ceremony — the shape `pithy email` and `pithy support` already had. This command read
 * `<root>/wrangler.jsonc` instead, a file no scaffolded project has, so every run died on a missing file
 * before it reached the partition, the skip, the report or the exit code: #512 claimed six commands and
 * delivered two.
 */
function buildResolveEnv(
  /** The partition this run acts on; the app database id per ready environment comes out of it. */
  readiness: EnvironmentReadiness,
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
): (env: ManagedEnvironment) => Promise<StorageEnvResources> {
  return async (env) => {
    const { appDatabaseId } = readyStanza(readiness, env);
    const secretsDb = await findOnConfirmedAccount({
      ...account,
      what: `the ${managerWorkerName(project, env)} database`,
      find: () => cf.d1Provisioner().findDatabaseByName(managerWorkerName(project, env)),
    });
    if (!secretsDb) {
      throw new ValidationError({
        message: `The ${env} secrets database (${managerWorkerName(project, env)}) does not exist.`,
        action: "Run `pithy secrets provision` first — the sweep worker reads its credentials from it.",
      });
    }
    return { appDatabaseId, secretsDatabaseId: secretsDb.uuid };
  };
}

const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Create the storage buckets, write the R2 credentials, and deploy the sweep workers",
  },
  args: {
    worker: {
      type: "string",
      description:
        "The app worker whose wrangler.jsonc carries the per-environment DB binding and receives the sweep Workflow binding (default: the project's only worker)",
    },
    "api-token": {
      type: "string",
      description:
        "Cloudflare API token carried alongside the R2 key pair, so the object store can prove bucket access. Defaults to CLOUDFLARE_API_TOKEN from .dev.vars — a broad token; supply an R2-scoped one for production.",
    },
    "r2-access-key-id": {
      type: "string",
      description:
        "R2 S3 access key id the Worker presigns uploads and downloads with. Create the pair under R2 → Manage API tokens. Falls back to R2_CREDENTIALS in the account config.",
    },
    "r2-secret-access-key": {
      type: "string",
      description:
        "R2 S3 secret access key, paired with --r2-access-key-id. Falls back to R2_CREDENTIALS in the account config.",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // The leading segment of every name this run creates — the bucket, the sweep worker, the
      // Workflow. `requireProjectName` refuses to guess, because `deprovision` recomputes these same
      // names to find what to delete (docs/NAMING.md).
      const config = await loadProject(projectDir);
      const project = requireProjectName(config);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(config);
      const { provisionStorage } = await loadStorage(projectDir);
      const { account, accountId, apiToken, storeId, r2Raw } = loadCloudflareCreds(
        await projectCloudflareAccount(projectDir),
      );
      const storageConfig = await loadStorageConfig(projectDir);
      const r2Credentials = resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw);
      const appWorker = await resolveSingleWorker({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });
      // Which environments this run can act on, decided once and before a single bucket exists. An
      // environment whose app database is not provisioned yet is skipped and reported, never fatal — the
      // old refusal fired from inside the fan-out, after every environment's bucket and secret (#512).
      const readiness = await environmentReadiness({
        workerDir: appWorker.dir,
        label: `${appWorker.name}'s wrangler.jsonc`,
        environments,
      });
      const cf = await cloudflareClients({ accountId, apiToken });
      const provisioner = new CloudflareStorageProvisioner({
        cf,
        projectDir,
        project,
        environments,
        account,
        apiToken,
        storeId,
        storageApiToken: args["api-token"] ?? apiToken,
        r2Credentials,
        storageConfig,
        dispatcher: await buildSecretDispatcher(accountId, apiToken, project),
        resolveEnv: buildResolveEnv(readiness, cf, project, account),
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      // The ready list, not the declaration — every skipped environment is left with nothing created for
      // it at all, which is the point: a staging-only bring-up must not make a production bucket. The
      // `environments` the provisioner carries stays the declaration, because that is what a `global`
      // secret write fans out across and narrowing it moves which manager writes one (#512).
      const result = await provisionStorage(provisioner, readiness.ready);
      const provisioned = new Map(result.environments.map((entry) => [entry.env, entry]));

      // Only now can the sweep's Workflow binding be written. `pithy add storage` cannot: wrangler
      // requires a `name` and a `class_name` on every `workflows` entry, and the deployed Workflow name
      // is per project and environment (`<project>-<env>-storage-sweep`). An entry short of either field fails the whole
      // config, so `add` emits none and this completes it — see capabilities/add.ts.
      const { storageWorkflowRegistry, STORAGE_CAPABILITY } = await loadStorage(projectDir);
      for (const entry of result.environments) {
        // Into the **app Worker's** `wrangler.jsonc`, the same file readiness was read from. A project
        // root holds no wrangler config at all, so writing there wrote nothing an adopter ever loads.
        await applyAppBindings(appWorker.dir, entry.env, {
          workflows: appWorkflowBindings(storageWorkflowRegistry, {
            project,
            capability: STORAGE_CAPABILITY,
            env: entry.env,
          }),
        });
      }

      if (args.json) {
        // Written before the refusal below, so a run in which everything skipped still carries the
        // per-environment structure on stdout beside the `{"error":…}` line on stderr.
        process.stdout.write(
          `${formatJsonLine({ command: "storage provision", ...result, skippedEnvironments: readiness.skipped })}\n`,
        );
        requireReadyEnvironments(readiness, "pithy storage provision");
        return;
      }
      process.stdout.write(
        formatEnvironmentOutcomes(
          environmentOutcomes(
            readiness,
            (env) => `bucket ${provisioned.get(env)?.bucketName} ready, sweep worker deployed`,
          ),
        ),
      );
      requireReadyEnvironments(readiness, "pithy storage provision");
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: { name: "deprovision", description: "Remove the sweep workers (and optionally the buckets)" },
  args: {
    storage: {
      type: "boolean",
      default: false,
      description: "Also delete the R2 buckets and every file in them (irreversible)",
    },
    "r2-access-key-id": {
      type: "string",
      description:
        "R2 S3 access key id, required with --storage: a bucket must be emptied over the S3 protocol before R2 will delete it. Falls back to R2_CREDENTIALS in the account config.",
    },
    "r2-secret-access-key": {
      type: "string",
      description:
        "R2 S3 secret access key, paired with --r2-access-key-id. Falls back to R2_CREDENTIALS in the account config.",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // Teardown finds resources by recomputing their names, so this must be the same name
      // `provision` used. A guess would match nothing, delete nothing, and still exit 0.
      const config = await loadProject(projectDir);
      const project = requireProjectName(config);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(config);
      const { deprovisionStorage } = await loadStorage(projectDir);
      const { account, accountId, apiToken, r2Raw } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      // Resolve the key pair up front, before a single worker comes down. A bucket cannot be deleted
      // without it, so discovering it is missing at the bucket step would leave the sweep workers gone
      // and the buckets standing — a half-torn-down environment for a mistake we can catch here.
      const r2Credentials = args.storage
        ? resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw)
        : undefined;
      const cf = await cloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareStorageDeprovisioner({
        account,
        cf,
        projectDir,
        project,
        r2Credentials,
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      await deprovisionStorage(deprovisioner, environments, { deleteStorage: args.storage });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "storage deprovision", storageDeleted: args.storage })}\n`);
        return;
      }
      process.stdout.write(`Sweep workers removed${args.storage ? ", including the buckets and their files" : ""}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "storage", description: "Provision and manage the storage infrastructure" },
  subCommands: { provision, deprovision },
});
