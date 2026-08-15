// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { runWrangler } from "../project/wrangler";
import { capabilityLoadError } from "./loadFailure";
import { deleteR2BucketWithContents } from "./r2Bucket";

/**
 * The live storage provisioner — the Cloudflare + wrangler implementation behind `@pithy-sh/storage`'s
 * `StorageProvisioner` seam. Control-plane steps go through `@pithy-sh/cloudflare` (CLAUDE.md: the CF
 * API only via that client) and are each idempotent; the worker deploy shells out to wrangler with the
 * bootstrap token.
 *
 * `@pithy-sh/storage` is an **optional** capability, so the CLI must not hard-depend on it. Types come
 * in through type-only imports (erased at build), and every runtime value comes through
 * {@link loadStorage} — a guarded dynamic import that turns "the package isn't installed" into an
 * actionable error rather than an unresolved-module crash.
 */

/** The storage runtime surface provisioning needs, loaded from the project's own install. */
type StorageProvisionModule = typeof import("@pithy-sh/storage/src/provision/provisionStorage");
type StorageResolveModule = typeof import("@pithy-sh/storage/src/provision/resolveStorageConfig");
type StorageRegistryModule = typeof import("@pithy-sh/storage/src/secret/registry");
type StorageCapabilityModule = typeof import("@pithy-sh/storage/src/capability");
type StorageSpecsModule = typeof import("@pithy-sh/storage/src/workflows/specs");

/** The provisioner seams, referenced by type only so the CLI gains no dependency on the package. */
type StorageProvisioner = import("@pithy-sh/storage/src/provision/provisionStorage").StorageProvisioner;
type StorageDeprovisioner = import("@pithy-sh/storage/src/provision/provisionStorage").StorageDeprovisioner;
type StorageResources = import("@pithy-sh/storage/src/provision/provisionStorage").StorageResources;
type StorageConfig = import("@pithy-sh/storage/src/config/config").StorageConfig;

/** Everything `pithy storage` loads out of the optional package, in one guarded import. */
export type StorageModule = StorageProvisionModule &
  StorageResolveModule &
  StorageRegistryModule &
  StorageCapabilityModule &
  StorageSpecsModule;

/**
 * Load `@pithy-sh/storage` from the project's own install. The one place the optional dependency is
 * resolved, so a project that has not added storage gets one clear instruction instead of a module
 * error from whichever call site happened to run first.
 */
export async function loadStorage(): Promise<StorageModule> {
  try {
    const [provision, resolve, registry, capability, specs] = await Promise.all([
      import("@pithy-sh/storage/src/provision/provisionStorage"),
      import("@pithy-sh/storage/src/provision/resolveStorageConfig"),
      import("@pithy-sh/storage/src/secret/registry"),
      import("@pithy-sh/storage/src/capability"),
      import("@pithy-sh/storage/src/workflows/specs"),
    ]);
    return { ...provision, ...resolve, ...registry, ...capability, ...specs };
  } catch (error) {
    throw capabilityLoadError("storage", "@pithy-sh/storage", error);
  }
}

/** The message of an unknown thrown value, for surfacing both legs of a failed upsert. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The routing facts the storage credential secret carries — an encrypted D1 row, per-environment JSON.
 *
 * `d1` is where this value has always physically gone: the write below dispatches to the secrets
 * manager Workflow, which stores it in `pithy_secrets_system_secrets`. No wrangler template ever bound
 * it from the Cloudflare Secrets Store. These facts must agree with `storageSecretsRegistry`'s
 * declaration, because the read seam routes strictly on `backend` — a disagreement sends a deployed
 * read to a binding that does not exist.
 */
const SECRET_FACTS = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "json",
} as const;

/** The per-environment resource ids the sweep worker binds, resolved by the caller. */
export interface StorageEnvResources {
  /** The app database id for this environment — where the `pithy_storage_*` tables live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`<project>-<env>-secrets`) — holds the R2 credentials. */
  secretsDatabaseId: string;
}

/** Resolve the per-environment resources for the sweep worker (from the project wrangler + name lookups). */
export type ResolveStorageEnv = (env: ManagedEnvironment) => Promise<StorageEnvResources>;

export interface CloudflareStorageProvisionerOptions {
  cf: CloudflareClients;
  /**
   * The account this provisions into, and what vouches for it (#378).
   *
   * Replaces a bare `accountId`, and the replacement is the point: an id on its own is what six sites
   * already held while a find-or-create read an empty listing as "this account has none" and minted a
   * real resource in whichever account the shell had named. The id is still here — `account.accountId` —
   * and it now travels with the answer to "who says so".
   */
  account: ConfirmedAccount;
  /**
   * The project name, from `requireProjectName(await loadProject(projectDir))` — never
   * `resolveProjectName`. Every name this provisioner creates, finds, and deletes leads with it, so a
   * guessed value would create a second set of resources beside the real ones and tear down neither.
   */
  project: string;
  /** The broad bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /** The CF Secrets Store id holding the per-env master keys (the sweep worker decrypts its credentials). */
  storeId: string;
  /**
   * The API token written into the storage secret. An R2 S3 access key *is* a CF API token, so whatever
   * minted the key pair already holds this; it is carried so `CloudflareR2Manager` can prove bucket access.
   */
  storageApiToken: string;
  /**
   * The R2 S3 access-key pair the Worker presigns uploads and downloads with. Supplied, not minted:
   * Cloudflare exposes no API for creating one.
   */
  r2Credentials: { accessKeyId: string; secretAccessKey: string };
  /** The app's resolved storage config — serialized into the sweep worker's `STORAGE_CONFIG` var. */
  storageConfig: StorageConfig;
  /** The secrets manager dispatcher — writes the credentials into a deployed env's managed store. */
  dispatcher: SecretDispatcher;
  /** Resolve the per-env app DB id and secrets DB id — injected so it is testable + decoupled. */
  resolveEnv: ResolveStorageEnv;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /** Every environment this project declares, from the root `pithy.config.ts` — the fan-out set for a `global` secret. */
  environments: DeclaredEnvironments | readonly string[];
}

/** The live {@link StorageProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareStorageProvisioner implements StorageProvisioner {
  readonly #cf: CloudflareClients;
  readonly #account: ConfirmedAccount;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #storeId: string;
  readonly #storageApiToken: string;
  readonly #r2Credentials: { accessKeyId: string; secretAccessKey: string };
  readonly #storageConfig: StorageConfig;
  readonly #dispatcher: SecretDispatcher;
  /**
   * The project's declared environments (#241) — what a `global` secret write fans out across. Carried
   * rather than assumed, so a shared secret reaches every environment the project deploys to.
   */
  readonly #environments: DeclaredEnvironments | readonly string[];
  readonly #resolveEnv: ResolveStorageEnv;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareStorageProvisionerOptions) {
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#storeId = options.storeId;
    this.#storageApiToken = options.storageApiToken;
    this.#r2Credentials = options.r2Credentials;
    this.#storageConfig = options.storageConfig;
    this.#dispatcher = options.dispatcher;
    this.#environments = options.environments;
    this.#resolveEnv = options.resolveEnv;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Require a registered `workers.dev` subdomain — Cloudflare needs one to deploy a Workflow host. */
  async preflight(): Promise<void> {
    if (!(await this.#cf.workers().accountSubdomain())) {
      throw new ValidationError({
        message: "This Cloudflare account has no workers.dev subdomain, which Workflows require.",
        action: "Open Workers & Pages in the dashboard once to create one, then re-run.",
      });
    }
  }

  /**
   * Reuse this environment's R2 bucket if it exists, otherwise create it.
   *
   * Find-then-create is only safe because the name carries the project: R2's namespace is flat and
   * account-wide, so an unscoped name would make "reuse" mean "adopt whatever another Pithy project
   * left here". Cloudflare offers no tags on an R2 bucket, so the name is the whole ownership record —
   * and the audit event writes the project down beside it, which is the only place a human can later
   * read who this bucket belongs to.
   */
  async ensureBucket(env: ManagedEnvironment): Promise<{ bucketName: string }> {
    const { storageBucketName } = await loadStorage();
    const name = storageBucketName(this.#project, env);
    const existing = await this.#cf.r2Provisioner().findBucketByName(name);
    if (existing) return { bucketName: existing.name };
    const created = await this.#cf.r2Provisioner().createBucket(name);
    await this.#audit({
      environment: env,
      action: "storage/bucket_created",
      outcome: "success",
      severity: "info",
      resourceType: "cf_r2_bucket",
      resourceId: created.name,
      metadata: { name },
    });
    return { bucketName: created.name };
  }

  /** Write the environment's R2 credentials. Upserts, so a re-run heals rather than fails. */
  async writeCredentials(env: ManagedEnvironment, resources: StorageResources): Promise<void> {
    const { STORAGE_R2_SECRET, R2StorageCredentials } = await loadStorage();
    // Validate before dispatching: a malformed secret is otherwise only discovered at the Worker's
    // first presign, long after the operator has walked away from the terminal.
    const value = R2StorageCredentials.parse({
      accessKeyId: this.#r2Credentials.accessKeyId,
      secretAccessKey: this.#r2Credentials.secretAccessKey,
      accountId: this.#account.accountId,
      bucket: resources.bucketName,
      apiToken: this.#storageApiToken,
    });
    // Upsert: create on first provision, update on a re-run (create rejects an existing secret) — so
    // the write is idempotent. If create fails for a real reason the update almost always fails too;
    // surface BOTH causes so the true failure isn't masked by the fallback's error.
    const write = {
      name: STORAGE_R2_SECRET,
      ...SECRET_FACTS,
      value: JSON.stringify(value),
      requested: env,
    };
    try {
      await dispatchSecretWrite(this.#dispatcher, { mode: "create", ...write }, this.#environments);
    } catch (createError) {
      try {
        await dispatchSecretWrite(this.#dispatcher, { mode: "update", ...write }, this.#environments);
      } catch (updateError) {
        throw new InternalError(
          {
            message: `Could not write the storage R2 credentials to ${env}.`,
            action: "Check that `pithy secrets provision` has run for this environment, then re-run.",
            detail: `create failed: ${errorMessage(createError)}; update failed: ${errorMessage(updateError)}`,
          },
          { cause: createError },
        );
      }
    }
    await this.#audit({
      environment: env,
      action: "storage/credentials_written",
      outcome: "success",
      severity: "info",
      resourceType: "secret",
      resourceId: STORAGE_R2_SECRET,
    });
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment, resources: StorageResources): Promise<void> {
    const { storageWorkerName, resolveStorageConfig } = await loadStorage();
    const { appDatabaseId, secretsDatabaseId } = await this.#resolveEnv(env);
    const dir = await storageWorkerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolveStorageConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      secretsDatabaseId,
      storeId: this.#storeId,
      resources,
      storageConfig: this.#storageConfig,
    });
    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#account.accountId },
      });
      await this.#audit({
        environment: env,
        action: "storage/worker_deployed",
        outcome: "success",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: storageWorkerName(this.#project, env),
      });
    } catch (error) {
      await this.#audit({
        environment: env,
        action: "storage/worker_deployed",
        outcome: "failure",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: storageWorkerName(this.#project, env),
      });
      throw error;
    } finally {
      await unlink(configPath).catch(() => {});
    }
  }
}

/** The directory of the prebuilt sweep worker inside the installed `@pithy-sh/storage` package. */
async function storageWorkerDir(): Promise<string> {
  try {
    return dirname(fileURLToPath(import.meta.resolve("@pithy-sh/storage/src/workflows/worker")));
  } catch (error) {
    throw capabilityLoadError("storage", "@pithy-sh/storage/src/workflows/worker", error);
  }
}

export interface CloudflareStorageDeprovisionerOptions {
  cf: CloudflareClients;
  /** The project name, from `requireProjectName` — teardown finds resources by no other key. */
  project: string;
  /**
   * The R2 S3 key pair, needed only when the buckets come down. Emptying a bucket is an S3-protocol
   * operation and R2 refuses to delete a non-empty one, so a bucket teardown cannot run on the API token
   * alone. Omitted when `deleteStorage` is off and no bucket is touched.
   */
  r2Credentials?: R2Credentials;
  /**
   * The account this teardown deletes from, and what vouches for it (#378).
   *
   * Required, and required for the reason `CloudflareConfigOptions.account` is: the guard below reads a
   * miss as "already gone", so against an account nothing claims it deletes nothing, audits nothing, and
   * exits 0. A caller that has not decided which account it is tearing down cannot compile.
   */
  account: ConfirmedAccount;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * The live {@link StorageDeprovisioner} — removes each environment's sweep worker and, when asked, the
 * R2 bucket with every object in it. Every step is guarded so a missing resource is a no-op: teardown is
 * idempotent.
 */
export class CloudflareStorageDeprovisioner implements StorageDeprovisioner {
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #r2Credentials: R2Credentials | undefined;
  readonly #account: ConfirmedAccount;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareStorageDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#r2Credentials = options.r2Credentials;
    this.#account = options.account;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Delete the env's sweep worker if it is deployed. */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const { storageWorkerName } = await loadStorage();
    const name = storageWorkerName(this.#project, env);
    if (
      await findOnConfirmedAccount({
        ...this.#account,
        what: `the ${name} Worker`,
        find: () => this.#cf.workers().getWorker(name),
      })
    ) {
      await this.#cf.workers().deleteWorker(name);
      await this.#audit({
        environment: env,
        action: "storage/worker_deleted",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_worker",
        resourceId: name,
      });
    }
  }

  /**
   * Delete this environment's R2 bucket and every object in it, if it exists — destructive, and only on
   * an explicit storage teardown. The drain is not optional: R2 refuses to delete a bucket that still
   * holds an object or a dangling multipart upload. What went is audited, not just that the bucket did.
   */
  async deleteBucket(env: ManagedEnvironment): Promise<void> {
    const { storageBucketName } = await loadStorage();
    const name = storageBucketName(this.#project, env);
    const teardown = await deleteR2BucketWithContents({
      cf: this.#cf,
      credentials: this.#r2Credentials,
      bucketName: name,
    });
    if (!teardown.deleted) return;
    await this.#audit({
      environment: env,
      action: "storage/bucket_deleted",
      outcome: "success",
      severity: "warning",
      resourceType: "cf_r2_bucket",
      resourceId: name,
      metadata: {
        name,
        objectsDeleted: teardown.objectsDeleted,
        uploadsAborted: teardown.uploadsAborted,
      },
    });
  }
}
