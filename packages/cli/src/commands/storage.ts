// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { createCliAudit } from "../audit/cliAudit";
import { resolveR2Credentials } from "../capabilities/r2Bucket";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import {
  CloudflareStorageDeprovisioner,
  CloudflareStorageProvisioner,
  loadStorage,
  type StorageEnvResources,
} from "../capabilities/storageProvisioner";
import { cloudflareEnv } from "../cloudflare/config";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { loadProject, requireProjectName } from "../project/config";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
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

/** Load the storage capability's resolved config from `pithy.config.ts`. */
async function loadStorageConfig(projectDir: string) {
  const { isStorageCapability } = await loadStorage();
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

/** The CF credentials and Secrets Store id storage provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(): {
  accountId: string;
  apiToken: string;
  storeId: string;
  r2Raw: string | undefined;
} {
  const vars = cloudflareEnv();
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
  return { accountId, apiToken, storeId, r2Raw: vars.R2_CREDENTIALS };
}

/** A wrangler env stanza — only the fields the sweep worker deploy reads from the project's config. */
interface WranglerStanza {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, WranglerStanza | undefined>;
}

/**
 * Resolve the per-environment resources the sweep worker binds, from the project's `wrangler.jsonc`
 * (the app `DB` id per env) and a live lookup of the env's secrets database. Each missing value throws
 * an actionable error rather than deploying a half-wired worker.
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
): (env: ManagedEnvironment) => Promise<StorageEnvResources> {
  return async (env) => {
    const config = parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerStanza;
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to wrangler.jsonc with its DB binding.`,
      });
    }
    const appDatabaseId = stanza.d1_databases?.find((db) => db.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no DB database_id.`,
        action: `Provision the ${env} app database and set its id on the DB binding.`,
      });
    }
    const secretsDb = await cf.d1Provisioner().findDatabaseByName(managerWorkerName(project, env));
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
      const project = requireProjectName(await loadProject(projectDir));
      const { provisionStorage } = await loadStorage();
      const { accountId, apiToken, storeId, r2Raw } = loadCloudflareCreds();
      const storageConfig = await loadStorageConfig(projectDir);
      const r2Credentials = resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw);
      const cf = new CloudflareClients({ accountId, apiToken });
      const provisioner = new CloudflareStorageProvisioner({
        cf,
        project,
        accountId,
        apiToken,
        storeId,
        storageApiToken: args["api-token"] ?? apiToken,
        r2Credentials,
        storageConfig,
        dispatcher: buildSecretDispatcher(accountId, apiToken, project),
        resolveEnv: buildResolveEnv(projectDir, cf, project),
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      const result = await provisionStorage(provisioner);

      // Only now can the sweep's Workflow binding be written. `pithy add storage` cannot: wrangler
      // requires a `name` and a `class_name` on every `workflows` entry, and the deployed Workflow name
      // is per project and environment (`<project>-<env>-storage-sweep`). An entry short of either field fails the whole
      // config, so `add` emits none and this completes it — see capabilities/add.ts.
      const { storageWorkflowRegistry, STORAGE_CAPABILITY } = await loadStorage();
      for (const entry of result.environments) {
        await applyAppBindings(projectDir, entry.env, {
          workflows: appWorkflowBindings(storageWorkflowRegistry, {
            project,
            capability: STORAGE_CAPABILITY,
            env: entry.env,
          }),
        });
      }

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "storage provision", ...result })}\n`);
        return;
      }
      for (const entry of result.environments) {
        process.stdout.write(`${entry.env}: bucket ${entry.bucketName} ready, sweep worker deployed.\n`);
      }
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
      const project = requireProjectName(await loadProject(projectDir));
      const { deprovisionStorage } = await loadStorage();
      const { accountId, apiToken, r2Raw } = loadCloudflareCreds();
      // Resolve the key pair up front, before a single worker comes down. A bucket cannot be deleted
      // without it, so discovering it is missing at the bucket step would leave the sweep workers gone
      // and the buckets standing — a half-torn-down environment for a mistake we can catch here.
      const r2Credentials = args.storage
        ? resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw)
        : undefined;
      const cf = new CloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareStorageDeprovisioner({
        cf,
        project,
        r2Credentials,
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      await deprovisionStorage(deprovisioner, { deleteStorage: args.storage });

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
