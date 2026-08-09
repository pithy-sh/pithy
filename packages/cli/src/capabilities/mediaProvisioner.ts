// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { runWrangler } from "../project/wrangler";
import { capabilityLoadError } from "./loadFailure";
import { deleteR2BucketWithContents } from "./r2Bucket";

/**
 * The live media provisioner — the Cloudflare + wrangler implementation behind `@pithy-sh/media`'s
 * `MediaProvisioner` seam. Control-plane steps go through `@pithy-sh/cloudflare` (CLAUDE.md: the CF API
 * only via that client) and are each idempotent; the worker deploy shells out to wrangler with the
 * bootstrap token.
 *
 * `@pithy-sh/media` is an **optional** capability, so the CLI must not hard-depend on it. Types come in
 * through type-only imports (erased at build), and every runtime value comes through {@link loadMedia} —
 * a guarded dynamic import that turns "the package isn't installed" into an actionable error rather than
 * an unresolved-module crash.
 */

/** The media runtime surface provisioning needs, loaded from the project's own install. */
type MediaProvisionModule = typeof import("@pithy-sh/media/src/provision/provisionMedia");
type MediaResolveModule = typeof import("@pithy-sh/media/src/provision/resolveMediaConfig");
type MediaRegistryModule = typeof import("@pithy-sh/media/src/secret/registry");
type MediaCapabilityModule = typeof import("@pithy-sh/media/src/capability");

/** The provisioner seams, referenced by type only so the CLI gains no dependency on the package. */
type MediaProvisioner = import("@pithy-sh/media/src/provision/provisionMedia").MediaProvisioner;
type MediaDeprovisioner = import("@pithy-sh/media/src/provision/provisionMedia").MediaDeprovisioner;
type MediaResources = import("@pithy-sh/media/src/provision/provisionMedia").MediaResources;
type MediaConfig = import("@pithy-sh/media/src/config/config").MediaConfig;

/** Everything `pithy media` loads out of the optional package, in one guarded import. */
export type MediaModule = MediaProvisionModule & MediaResolveModule & MediaRegistryModule & MediaCapabilityModule;

/**
 * Load `@pithy-sh/media` from the project's own install. The one place the optional dependency is
 * resolved, so a project that has not added media gets one clear instruction instead of a module error
 * from whichever call site happened to run first.
 */
export async function loadMedia(): Promise<MediaModule> {
  try {
    const [provision, resolve, registry, capability] = await Promise.all([
      import("@pithy-sh/media/src/provision/provisionMedia"),
      import("@pithy-sh/media/src/provision/resolveMediaConfig"),
      import("@pithy-sh/media/src/secret/registry"),
      import("@pithy-sh/media/src/capability"),
    ]);
    return { ...provision, ...resolve, ...registry, ...capability };
  } catch (error) {
    throw capabilityLoadError("media", "@pithy-sh/media", error);
  }
}

/** The message of an unknown thrown value, for surfacing both legs of a failed upsert. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The routing facts the media storage secret carries — an encrypted D1 row, per-environment JSON.
 *
 * `d1` is where this value has always physically gone: the write below dispatches to the secrets
 * manager Workflow, which stores it in `pithy_secrets_system_secrets`. No wrangler template ever bound
 * it from the Cloudflare Secrets Store. These facts must agree with `mediaSecretsRegistry`'s
 * declaration, because the read seam routes strictly on `backend` — a disagreement sends a deployed
 * read to a binding that does not exist.
 */
const SECRET_FACTS = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "json",
} as const;

/** The per-environment resource ids the media worker binds, resolved by the caller. */
export interface MediaEnvResources {
  /** The app database id for this environment — where media records and hashes live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`<project>-<env>-secrets`) — holds the storage credentials. */
  secretsDatabaseId: string;
}

/** Resolve the per-environment resources for the media worker (from the project wrangler + name lookups). */
export type ResolveMediaEnv = (env: ManagedEnvironment) => Promise<MediaEnvResources>;

export interface CloudflareMediaProvisionerOptions {
  cf: CloudflareClients;
  accountId: string;
  /**
   * The project name, from `requireProjectName(await loadProject(projectDir))` — never
   * `resolveProjectName`. Every name this provisioner creates, finds, and deletes leads with it, so a
   * guessed value would stand up a second set of resources beside the real ones and tear down neither.
   */
  project: string;
  /** The broad bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /** The CF Secrets Store id holding the per-env master keys (the media worker decrypts its credentials). */
  storeId: string;
  /**
   * The API token written into the media secret — what the Worker mints Images and Stream direct-upload
   * URLs with. Supplied, not minted: the permission catalog carries no Images or Stream keys yet.
   */
  mediaApiToken: string;
  /**
   * The R2 S3 access-key pair the Worker presigns R2 uploads and downloads with. Supplied, not minted:
   * Cloudflare exposes no API for creating one.
   */
  r2Credentials: { accessKeyId: string; secretAccessKey: string };
  /**
   * The API token carried alongside the R2 key pair so the object store can prove bucket access — a
   * different scope from `mediaApiToken`, which is Images and Stream. Defaults to the bootstrap token,
   * matching what `pithy storage provision` does; supply an R2-scoped one for production.
   */
  r2ApiToken?: string;
  /** The app's resolved media config — decides whether a KV namespace is needed, and fills `MEDIA_CONFIG`. */
  mediaConfig: MediaConfig;
  /** The secrets manager dispatcher — writes the credentials into a deployed env's managed store. */
  dispatcher: SecretDispatcher;
  /** Resolve the per-env app DB id and secrets DB id — injected so it is testable + decoupled. */
  resolveEnv: ResolveMediaEnv;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/** The live {@link MediaProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareMediaProvisioner implements MediaProvisioner {
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #storeId: string;
  readonly #mediaApiToken: string;
  readonly #r2Credentials: { accessKeyId: string; secretAccessKey: string };
  readonly #r2ApiToken: string;
  readonly #mediaConfig: MediaConfig;
  readonly #dispatcher: SecretDispatcher;
  readonly #resolveEnv: ResolveMediaEnv;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareMediaProvisionerOptions) {
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#storeId = options.storeId;
    this.#mediaApiToken = options.mediaApiToken;
    this.#r2Credentials = options.r2Credentials;
    this.#r2ApiToken = options.r2ApiToken ?? options.apiToken;
    this.#mediaConfig = options.mediaConfig;
    this.#dispatcher = options.dispatcher;
    this.#resolveEnv = options.resolveEnv;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Require a registered `workers.dev` subdomain — Cloudflare needs one to deploy the Workflow-hosting worker. */
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
   * left here". R2 exposes no tags through the API, so the name is the whole ownership record — and
   * the audit event writes the project down beside it.
   */
  async ensureBucket(env: ManagedEnvironment): Promise<{ bucketName: string }> {
    const { mediaBucketName } = await loadMedia();
    const name = mediaBucketName(this.#project, env);
    const existing = await this.#cf.r2Provisioner().findBucketByName(name);
    if (existing) return { bucketName: existing.name };
    const created = await this.#cf.r2Provisioner().createBucket(name);
    await this.#audit({
      environment: env,
      action: "media/bucket_created",
      outcome: "success",
      severity: "info",
      resourceType: "cf_r2_bucket",
      resourceId: created.name,
      metadata: { name },
    });
    return { bucketName: created.name };
  }

  /** Reuse or create this environment's `MEDIA` KV namespace — but only when records live in KV. */
  async ensureKvNamespace(env: ManagedEnvironment): Promise<{ namespaceId: string } | null> {
    if (this.#mediaConfig.recordStore !== "kv") return null;
    const { mediaKvTitle } = await loadMedia();
    const title = mediaKvTitle(this.#project, env);
    const existing = await this.#cf.kvProvisioner().findNamespaceByTitle(title);
    if (existing) return { namespaceId: existing.id };
    const created = await this.#cf.kvProvisioner().createNamespace(title);
    await this.#audit({
      environment: env,
      action: "media/kv_namespace_created",
      outcome: "success",
      severity: "info",
      resourceType: "cf_kv_namespace",
      resourceId: created.id,
      metadata: { title },
    });
    return { namespaceId: created.id };
  }

  /**
   * Write the environment's two secrets. Upserts, so a re-run heals rather than fails.
   *
   * `media-storage-credentials` is media's own — the Images + Stream token and the account id.
   * `media-r2-credentials` is `@pithy-sh/storage`'s R2 bundle, which media declares and never reads; it
   * is validated against the schema the registry entry itself carries, so the value written here and the
   * value the `ObjectStore` re-validates on read come from one declaration and cannot drift.
   */
  async writeCredentials(env: ManagedEnvironment, resources: MediaResources): Promise<void> {
    const { MEDIA_STORAGE_SECRET, MEDIA_R2_SECRET, MediaStorageCredentials, mediaR2Registry } = await loadMedia();
    // Validate before dispatching: a malformed secret is only discovered at the Worker's first read
    // otherwise, long after the operator has walked away from the terminal.
    const storage = MediaStorageCredentials.parse({
      apiToken: this.#mediaApiToken,
      accountId: this.#accountId,
    });
    const r2 = mediaR2Registry[MEDIA_R2_SECRET].schema.parse({
      accountId: this.#accountId,
      apiToken: this.#r2ApiToken,
      accessKeyId: this.#r2Credentials.accessKeyId,
      secretAccessKey: this.#r2Credentials.secretAccessKey,
      bucket: resources.bucketName,
    });
    // The R2 secret goes first. It names the bucket, so a half-finished run leaves the object plane
    // wired and the enrichment token missing — the failure an operator can read off the error.
    await this.#upsertSecret(env, MEDIA_R2_SECRET, r2);
    await this.#upsertSecret(env, MEDIA_STORAGE_SECRET, storage);
    // One event for one provisioning step. Both names ride in the metadata rather than becoming two
    // events, because nothing can write one secret and not the other — the pair is the unit.
    await this.#audit({
      environment: env,
      action: "media/credentials_written",
      outcome: "success",
      severity: "info",
      resourceType: "secret",
      resourceId: MEDIA_STORAGE_SECRET,
      metadata: { secrets: [MEDIA_STORAGE_SECRET, MEDIA_R2_SECRET] },
    });
  }

  /**
   * Upsert one secret: create on first provision, update on a re-run (create rejects an existing
   * secret) — so the write is idempotent. If create fails for a real reason the update almost always
   * fails too; surface BOTH causes so the true failure isn't masked by the fallback's error.
   */
  async #upsertSecret(env: ManagedEnvironment, name: string, value: unknown): Promise<void> {
    const write = { name, ...SECRET_FACTS, value: JSON.stringify(value), requested: env };
    try {
      await dispatchSecretWrite(this.#dispatcher, { mode: "create", ...write });
    } catch (createError) {
      try {
        await dispatchSecretWrite(this.#dispatcher, { mode: "update", ...write });
      } catch (updateError) {
        throw new InternalError(
          {
            message: `Could not write the media storage credentials to ${env}.`,
            action: "Check that `pithy secrets provision` has run for this environment, then re-run.",
            detail: `${name}: create failed: ${errorMessage(createError)}; update failed: ${errorMessage(updateError)}`,
          },
          { cause: createError },
        );
      }
    }
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment, resources: MediaResources): Promise<void> {
    const { mediaWorkerName, resolveMediaConfig } = await loadMedia();
    const { appDatabaseId, secretsDatabaseId } = await this.#resolveEnv(env);
    const dir = await mediaWorkerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolveMediaConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      secretsDatabaseId,
      storeId: this.#storeId,
      resources,
      mediaConfig: this.#mediaConfig,
    });
    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#accountId },
      });
      await this.#audit({
        environment: env,
        action: "media/worker_deployed",
        outcome: "success",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: mediaWorkerName(this.#project, env),
      });
    } catch (error) {
      await this.#audit({
        environment: env,
        action: "media/worker_deployed",
        outcome: "failure",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: mediaWorkerName(this.#project, env),
      });
      throw error;
    } finally {
      await unlink(configPath).catch(() => {});
    }
  }
}

/** The directory of the prebuilt media worker inside the installed `@pithy-sh/media` package (holds wrangler.jsonc). */
async function mediaWorkerDir(): Promise<string> {
  try {
    return dirname(fileURLToPath(import.meta.resolve("@pithy-sh/media/src/workflows/worker")));
  } catch (error) {
    throw capabilityLoadError("media", "@pithy-sh/media/src/workflows/worker", error);
  }
}

export interface CloudflareMediaDeprovisionerOptions {
  cf: CloudflareClients;
  /** The project name, from `requireProjectName` — teardown finds resources by no other key. */
  project: string;
  /**
   * The R2 S3 key pair, needed only when the bucket comes down. Emptying a bucket is an S3-protocol
   * operation and R2 refuses to delete a non-empty one, so a bucket teardown cannot run on the API token
   * alone. Omitted when `deleteStorage` is off and no bucket is touched.
   */
  r2Credentials?: R2Credentials;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * The live {@link MediaDeprovisioner} — removes each environment's media worker and, when asked, the R2
 * bucket with every object in it plus the `MEDIA` KV namespace. Every step is guarded so a missing
 * resource is a no-op: teardown is idempotent.
 */
export class CloudflareMediaDeprovisioner implements MediaDeprovisioner {
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #r2Credentials: R2Credentials | undefined;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareMediaDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#r2Credentials = options.r2Credentials;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Delete the env's media worker if it is deployed. */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const { mediaWorkerName } = await loadMedia();
    const name = mediaWorkerName(this.#project, env);
    if (await this.#cf.workers().getWorker(name)) {
      await this.#cf.workers().deleteWorker(name);
      await this.#audit({
        environment: env,
        action: "media/worker_deleted",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_worker",
        resourceId: name,
      });
    }
  }

  /**
   * Delete this environment's R2 bucket and every object in it, if it exists — destructive, and called
   * only on an explicit storage teardown. The drain is not optional: R2 refuses to delete a bucket that
   * still holds an object or a dangling multipart upload. What went is audited, not just that it went.
   */
  async deleteBucket(env: ManagedEnvironment): Promise<void> {
    const { mediaBucketName } = await loadMedia();
    const name = mediaBucketName(this.#project, env);
    const teardown = await deleteR2BucketWithContents({
      cf: this.#cf,
      credentials: this.#r2Credentials,
      bucketName: name,
    });
    if (!teardown.deleted) return;
    await this.#audit({
      environment: env,
      action: "media/bucket_deleted",
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

  /** Delete this environment's `MEDIA` KV namespace if it exists — destructive, only on an explicit storage teardown. */
  async deleteKvNamespace(env: ManagedEnvironment): Promise<void> {
    const { mediaKvTitle } = await loadMedia();
    const title = mediaKvTitle(this.#project, env);
    const existing = await this.#cf.kvProvisioner().findNamespaceByTitle(title);
    if (!existing) return;
    await this.#cf.kvProvisioner().deleteNamespace(existing.id);
    await this.#audit({
      environment: env,
      action: "media/kv_namespace_deleted",
      outcome: "success",
      severity: "warning",
      resourceType: "cf_kv_namespace",
      resourceId: existing.id,
      metadata: { title },
    });
  }
}
