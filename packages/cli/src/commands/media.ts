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
import { createProjectCliAudit } from "../audit/cliAudit";
import {
  CloudflareMediaDeprovisioner,
  CloudflareMediaProvisioner,
  loadMedia,
  type MediaEnvResources,
} from "../capabilities/mediaProvisioner";
import { resolveR2Credentials } from "../capabilities/r2Bucket";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy media provision` / `deprovision` — the command the media manifest, README, and wrangler template
 * have always pointed at. It creates the R2 bucket (and the `MEDIA` KV namespace in KV record-store mode),
 * writes the `media-storage-credentials` and `media-r2-credentials` secrets for every managed
 * environment, and deploys the prebuilt media worker that hosts the four enrichment Workflows.
 *
 * Two secrets because two owners: the Images + Stream token is media's, and the R2 bundle belongs to
 * `@pithy-sh/storage`'s `ObjectStore`, which media presigns through and whose key pair media never sees.
 *
 * **Credentials are supplied, not minted.** Cloudflare exposes no API for creating an R2 S3 access-key
 * pair, and the permission catalog carries no Images or Stream keys, so the pair and the scoped API token
 * come from flags or `.dev.vars` and are written into the secret as given. Minting them is a follow-up.
 */

/**
 * The audit emitter for a media command. Provisioning spans every managed environment at once, so there is
 * no single target env to key the audit database on — `"dev"` is the fallback (mirrors `pithy email`'s
 * convention for env-spanning commands). A no-op when creds or the audit capability aren't there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  // `env` selects the audit database only, and defaults to `dev`: this command spans environments, so no
  // single value is true for the run; each event states the environment it acted on.
  return createProjectCliAudit({ projectDir, accountId, apiToken });
}

/** Load the media capability's resolved config from `pithy.config.ts`. */
async function loadMediaConfig(projectDir: string) {
  const { isMediaCapability } = await loadMedia();
  // Capabilities live in each Worker's `apps/<name>/pithy.config.ts`; provisioning is one
  // project-wide decision, so the first Worker composing this capability provides it.
  const capability = (await resolveWorkers({ projectDir }).then(projectCapabilities)).find(isMediaCapability);
  if (!capability) {
    throw new ValidationError({
      message: "The media capability is not configured.",
      action: "Add `media({ ... })` to pithy.config.ts (run `pithy add media`).",
    });
  }
  return capability.mediaConfig;
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
      action: "Run pithy add secrets to record SECRETS_STORE_ID (the media worker decrypts its credentials from it).",
    });
  }
  return { account: { accountId, confirmation }, accountId, apiToken, storeId, r2Raw: vars.R2_CREDENTIALS };
}

/** A wrangler env stanza — only the fields the media worker deploy reads from the project's config. */
interface WranglerStanza {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, WranglerStanza | undefined>;
}

/**
 * Resolve the per-environment resources the media worker binds, from the project's `wrangler.jsonc` (the
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
  /**
   * The account the secrets database is looked for on, and what vouches for it (#378).
   *
   * The refusal below reads a missing database as "provision it first". Against an account nothing
   * claims, that database is missing because this run asked the wrong account — and the sentence sends
   * an operator to run a provisioning command they have already run.
   */
  account: ConfirmedAccount,
): (env: ManagedEnvironment) => Promise<MediaEnvResources> {
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
    const secretsDb = await findOnConfirmedAccount({
      ...account,
      what: `the ${managerWorkerName(project, env)} database`,
      find: () => cf.d1Provisioner().findDatabaseByName(managerWorkerName(project, env)),
    });
    if (!secretsDb) {
      throw new ValidationError({
        message: `The ${env} secrets database (${managerWorkerName(project, env)}) does not exist.`,
        action: "Run `pithy secrets provision` first — the media worker reads its credentials from it.",
      });
    }
    return { appDatabaseId, secretsDatabaseId: secretsDb.uuid };
  };
}

const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Create the media bucket and namespace, write the credentials, and deploy the enrichment workers",
  },
  args: {
    "api-token": {
      type: "string",
      description:
        "Cloudflare API token the media Worker mints Images and Stream direct-upload URLs with. Defaults to CLOUDFLARE_API_TOKEN from .dev.vars — a broad token; supply a scoped Images + Stream token for production.",
    },
    "r2-access-key-id": {
      type: "string",
      description:
        "R2 S3 access key id the Worker presigns R2 uploads and downloads with. Create the pair under R2 → Manage API tokens. Falls back to R2_CREDENTIALS in the account config.",
    },
    "r2-secret-access-key": {
      type: "string",
      description:
        "R2 S3 secret access key, paired with --r2-access-key-id. Falls back to R2_CREDENTIALS in the account config.",
    },
    "r2-api-token": {
      type: "string",
      description:
        "Cloudflare API token carried alongside the R2 key pair, so the object store can prove bucket access. Defaults to CLOUDFLARE_API_TOKEN from .dev.vars — a broad token; supply an R2-scoped one for production.",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // The leading segment of every name this run creates — the bucket, the KV namespace, the worker.
      // `requireProjectName` refuses to guess, because `deprovision` recomputes these same names to
      // find what to delete (docs/NAMING.md).
      const config = await loadProject(projectDir);
      const project = requireProjectName(config);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(config);
      const { provisionMedia } = await loadMedia();
      const { account, accountId, apiToken, storeId, r2Raw } = loadCloudflareCreds(
        await projectCloudflareAccount(projectDir),
      );
      const mediaConfig = await loadMediaConfig(projectDir);
      const r2Credentials = resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw);
      const cf = new CloudflareClients({ accountId, apiToken });
      const provisioner = new CloudflareMediaProvisioner({
        cf,
        project,
        environments,
        account,
        apiToken,
        storeId,
        mediaApiToken: args["api-token"] ?? apiToken,
        r2Credentials,
        r2ApiToken: args["r2-api-token"] ?? apiToken,
        mediaConfig,
        dispatcher: buildSecretDispatcher(accountId, apiToken, project),
        resolveEnv: buildResolveEnv(projectDir, cf, project, account),
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      const result = await provisionMedia(provisioner, environments);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "media provision", ...result })}\n`);
        return;
      }
      for (const entry of result.environments) {
        const namespace = entry.kvNamespaceId ? " and its MEDIA namespace" : "";
        process.stdout.write(`${entry.env}: bucket ${entry.bucketName}${namespace} ready, worker deployed.\n`);
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: { name: "deprovision", description: "Remove the media workers (and optionally the bucket and namespace)" },
  args: {
    storage: {
      type: "boolean",
      default: false,
      description: "Also delete the R2 bucket with every object in it, and the MEDIA KV namespace (irreversible)",
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
      const { deprovisionMedia } = await loadMedia();
      const { account, accountId, apiToken, r2Raw } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      // Resolve the key pair up front, before a single worker comes down. A bucket cannot be deleted
      // without it, so discovering it is missing at the bucket step would leave the media workers gone
      // and the bucket standing — a half-torn-down environment for a mistake we can catch here.
      const r2Credentials = args.storage
        ? resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw)
        : undefined;
      const cf = new CloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareMediaDeprovisioner({
        account,
        cf,
        project,
        r2Credentials,
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      await deprovisionMedia(deprovisioner, environments, { deleteStorage: args.storage });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "media deprovision", storageDeleted: args.storage })}\n`);
        return;
      }
      process.stdout.write(
        `Media workers removed${args.storage ? ", including the bucket, its objects, and the namespace" : ""}.\n`,
      );
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "media", description: "Provision and manage the media infrastructure" },
  subCommands: { provision, deprovision },
});
