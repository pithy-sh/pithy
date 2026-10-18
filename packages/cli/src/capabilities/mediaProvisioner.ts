// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import { RUNTIME_PROFILE } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { dispatchSecretWrite, type SecretDispatcher, type SecretProbe } from "@pithy-sh/secrets/src/cli/dispatch";
import { runtimeTokenSecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { kitImport } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import { deployHostWorker, kitPackageVersion } from "./hostDeploy";
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
export async function loadMedia(projectDir: string): Promise<MediaModule> {
  try {
    const [provision, resolve, registry, capability] = await Promise.all([
      kitImport<MediaProvisionModule>(projectDir, "@pithy-sh/media/src/provision/provisionMedia"),
      kitImport<MediaResolveModule>(projectDir, "@pithy-sh/media/src/provision/resolveMediaConfig"),
      kitImport<MediaRegistryModule>(projectDir, "@pithy-sh/media/src/secret/registry"),
      kitImport<MediaCapabilityModule>(projectDir, "@pithy-sh/media/src/capability"),
    ]);
    return { ...provision, ...resolve, ...registry, ...capability };
  } catch (error) {
    throw await capabilityLoadError("media", "@pithy-sh/media", error, projectDir);
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
  // Not a `bootstrap` secret: its value is an envelope every reader decodes, not something read straight
  // off a binding before the store is open. Stated because a request states it (#517).
  bootstrap: false,
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
  /**
   * The project root — the directory `pithy.config.ts` was read from, and the base every
   * `@pithy-sh/media` module is resolved against. Not derivable from `project`, which is a *name*;
   * see `project/kitResolve.ts` for why a resolution may not fall back to the CLI's own copy.
   */
  readonly projectDir: string;
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
   * guessed value would stand up a second set of resources beside the real ones and tear down neither.
   */
  project: string;
  /** The broad bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /** The CF Secrets Store id holding the per-env master keys (the media worker decrypts its credentials). */
  storeId: string;
  /**
   * The R2 S3 access-key pair the Worker presigns R2 uploads and downloads with. Supplied, not minted:
   * Cloudflare exposes no API for creating one.
   */
  r2Credentials: { accessKeyId: string; secretAccessKey: string };
  /** The app's resolved media config — decides which signing keys are written, and fills `MEDIA_CONFIG`. */
  mediaConfig: MediaConfig;
  /** The secrets manager dispatcher — writes the credentials into a deployed env's managed store. */
  dispatcher: SecretDispatcher;
  /**
   * Whether a deployed environment already holds a secret — asked before a Stream signing key is created,
   * because Cloudflare hands its private half back once and a re-run must not mint a second key nobody
   * stored. Absent, every run creates one.
   */
  probe?: SecretProbe;
  /** Resolve the per-env app DB id and secrets DB id — injected so it is testable + decoupled. */
  resolveEnv: ResolveMediaEnv;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /** Every environment this project declares, from the root `pithy.config.ts` — the fan-out set for a `global` secret. */
  environments: DeclaredEnvironments | readonly string[];
}

/** The live {@link MediaProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareMediaProvisioner implements MediaProvisioner {
  readonly #projectDir: string;
  readonly #cf: CloudflareClients;
  readonly #account: ConfirmedAccount;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #storeId: string;
  readonly #r2Credentials: { accessKeyId: string; secretAccessKey: string };
  readonly #mediaConfig: MediaConfig;
  readonly #dispatcher: SecretDispatcher;
  readonly #probe: SecretProbe | undefined;
  /**
   * The project's declared environments (#241) — what a `global` secret write fans out across. Carried
   * rather than assumed, so a shared secret reaches every environment the project deploys to.
   */
  readonly #environments: DeclaredEnvironments | readonly string[];
  readonly #resolveEnv: ResolveMediaEnv;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareMediaProvisionerOptions) {
    this.#projectDir = options.projectDir;
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#storeId = options.storeId;
    this.#r2Credentials = options.r2Credentials;
    this.#mediaConfig = options.mediaConfig;
    this.#dispatcher = options.dispatcher;
    this.#probe = options.probe;
    this.#environments = options.environments;
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
    const { mediaBucketName } = await loadMedia(this.#projectDir);
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

  /** Every Images variant set to `neverRequireSignedURLs` — what would serve a private image unsigned. */
  async unsignedVariants(): Promise<string[]> {
    const variants = await this.#cf.images().listVariants();
    return variants.filter((variant) => variant.neverRequireSignedURLs).map((variant) => variant.id);
  }

  /**
   * Write this environment's signing keys, where some record could be private.
   *
   * **Images**: the account keeps URL-signing keys, `default` among them, so the key is read and written
   * as found — the same value on every run. One is created only for an account that has none.
   *
   * **Stream**: Cloudflare returns a signing key's private half once, at creation. So a key is created only
   * when the environment holds none, and a re-run leaves the stored one in place rather than minting a
   * second key that nothing would sign with.
   */
  async writeSigningKeys(env: ManagedEnvironment): Promise<void> {
    const {
      admitsPrivateMedia,
      MEDIA_IMAGES_SIGNING_SECRET,
      MEDIA_STREAM_SIGNING_SECRET,
      MediaImagesSigningKey,
      MediaStreamSigningKey,
    } = await loadMedia(this.#projectDir);
    if (!admitsPrivateMedia(this.#mediaConfig)) return;
    const written: string[] = [];

    if (this.#mediaConfig.images.store === "cf-images") {
      const existing = await this.#cf.images().signingKeys();
      const keys = existing.length > 0 ? existing : await this.#cf.images().createSigningKey("pithy");
      const key = keys.find((candidate) => candidate.name === "default") ?? keys[0];
      if (!key) {
        throw new InternalError({
          message: "Cloudflare Images returned no URL-signing key.",
          action: "Create one under Images → Keys in the dashboard, then re-run.",
          detail: `images signing keys listing and creation both returned none for ${env}`,
        });
      }
      await this.#upsertSecret(env, MEDIA_IMAGES_SIGNING_SECRET, MediaImagesSigningKey.parse({ key: key.value }));
      written.push(MEDIA_IMAGES_SIGNING_SECRET);
    }

    if (this.#mediaConfig.video.store === "cf-stream") {
      const held = (await this.#probe?.probe({ env, name: MEDIA_STREAM_SIGNING_SECRET })) ?? false;
      if (!held) {
        const created = await this.#cf.stream().createSigningKey();
        await this.#upsertSecret(
          env,
          MEDIA_STREAM_SIGNING_SECRET,
          MediaStreamSigningKey.parse({ keyId: created.id, jwk: created.jwk }),
        );
        written.push(MEDIA_STREAM_SIGNING_SECRET);
      }
    }

    if (written.length === 0) return;
    await this.#audit({
      environment: env,
      action: "media/signing_keys_written",
      outcome: "success",
      severity: "info",
      resourceType: "secret",
      resourceId: written[0] as string,
      metadata: { secrets: written },
    });
  }

  /**
   * Write the environment's two secrets. Upserts, so a re-run heals rather than fails.
   *
   * `media-storage-credentials` is media's own — the account id, and nothing else since #728: media mints
   * Images and Stream uploads with the application's `runtime` token, so no token is asked for here.
   * `media-r2-credentials` is `@pithy-sh/storage`'s R2 bundle, which media declares and never reads; it
   * is validated against the schema the registry entry itself carries, so the value written here and the
   * value the `ObjectStore` re-validates on read come from one declaration and cannot drift.
   */
  async writeCredentials(env: ManagedEnvironment, resources: MediaResources): Promise<void> {
    const { MEDIA_STORAGE_SECRET, MEDIA_R2_SECRET, MediaStorageCredentials, mediaR2Registry } = await loadMedia(
      this.#projectDir,
    );
    // Validate before dispatching: a malformed secret is only discovered at the Worker's first read
    // otherwise, long after the operator has walked away from the terminal.
    // Rewritten whole on every run, which is how a bundle written before #728 loses the token an operator
    // supplied: the upgrade path is mint `runtime`, re-run this, then revoke the old token.
    const storage = MediaStorageCredentials.parse({ accountId: this.#account.accountId });
    const r2 = mediaR2Registry[MEDIA_R2_SECRET].schema.parse({
      accountId: this.#account.accountId,
      accessKeyId: this.#r2Credentials.accessKeyId,
      secretAccessKey: this.#r2Credentials.secretAccessKey,
      bucket: resources.bucketName,
    });
    // The R2 secret goes first. It names the bucket, so a half-finished run leaves the object plane
    // wired and the account missing — the failure an operator can read off the error.
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
      await dispatchSecretWrite(this.#dispatcher, { mode: "create", ...write }, this.#environments);
    } catch (createError) {
      try {
        await dispatchSecretWrite(this.#dispatcher, { mode: "update", ...write }, this.#environments);
      } catch (updateError) {
        throw new InternalError(
          {
            message: `Could not write the media storage credentials to ${env}.`,
            action: `Check that \`${commandName("secrets provision")}\` has run for this environment, then re-run.`,
            detail: `${name}: create failed: ${errorMessage(createError)}; update failed: ${errorMessage(updateError)}`,
          },
          { cause: createError },
        );
      }
    }
  }

  /**
   * Refuse, before anything deploys, an environment whose Secrets Store holds no runtime token (#728). The
   * enrichment worker binds that entry, and a project upgraded from the secrets manager's own token has
   * none until it mints one — which wrangler would answer with a refused binding and no word of why.
   */
  async #requireRuntimeToken(env: ManagedEnvironment): Promise<void> {
    const entry = runtimeTokenSecretName(this.#project, env);
    if (await this.#cf.secrets(this.#storeId).exists(entry)) return;
    throw new ValidationError({
      message: `${env} has no runtime token in the Secrets Store (${entry}), and the media worker reads one.`,
      action: `Run ${pithyCommand("token mint", { args: [RUNTIME_PROFILE], flags: { "--env": env } })}, then re-run.`,
      detail: `media provision ${env}: secrets store ${this.#storeId} has no entry ${entry}`,
    });
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment, resources: MediaResources): Promise<void> {
    await this.#requireRuntimeToken(env);
    const { mediaWorkerName, resolveMediaConfig } = await loadMedia(this.#projectDir);
    const { appDatabaseId, secretsDatabaseId } = await this.#resolveEnv(env);
    const dir = await mediaWorkerDir(this.#projectDir);
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

    // **The gate, inherited rather than opted into (#537).** `deployHostWorker` stamps the resolved
    // config with this package's version and a hash of the config itself, compares that against what
    // the deployed Worker carries, and ships only when they differ. A first provision has no stamp, so
    // it deploys. Anything it cannot establish — no Worker, no stamp, an unreachable account — deploys
    // too: a false redeploy costs seconds, a false skip is silent.
    try {
      const { outcome } = await deployHostWorker({
        capability: "media",
        pkg: "@pithy-sh/media",
        version: await kitPackageVersion(this.#projectDir, "@pithy-sh/media"),
        config,
        dir,
        env,
        readVars: (script) => this.#cf.workers().getWorkerVars(script),
        account: { accountId: this.#account.accountId, apiToken: this.#apiToken },
      });
      // A skipped deploy shipped nothing, so it records nothing. An audit row saying a Worker was
      // deployed on a run where wrangler never ran is worse than a gap in the trail.
      if (outcome === "deployed") {
        await this.#audit({
          environment: env,
          action: "media/worker_deployed",
          outcome: "success",
          severity: "info",
          resourceType: "cf_worker",
          resourceId: mediaWorkerName(this.#project, env),
        });
      }
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
    }
  }
}

/** The directory of the prebuilt media worker inside the installed `@pithy-sh/media` package (holds wrangler.jsonc). */
async function mediaWorkerDir(projectDir: string): Promise<string> {
  try {
    return dirname(kitSource(projectDir, "@pithy-sh/media/src/workflows/worker"));
  } catch (error) {
    throw await capabilityLoadError("media", "@pithy-sh/media/src/workflows/worker", error, projectDir);
  }
}

export interface CloudflareMediaDeprovisionerOptions {
  /**
   * The project root — the directory `pithy.config.ts` was read from, and the base every
   * `@pithy-sh/media` module is resolved against. Not derivable from `project`, which is a *name*;
   * see `project/kitResolve.ts` for why a resolution may not fall back to the CLI's own copy.
   */
  readonly projectDir: string;
  cf: CloudflareClients;
  /** The project name, from `requireProjectName` — teardown finds resources by no other key. */
  project: string;
  /**
   * The R2 S3 key pair, needed only when the bucket comes down. Emptying a bucket is an S3-protocol
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
 * The live {@link MediaDeprovisioner} — removes each environment's media worker and, when asked, the R2
 * bucket with every object in it. Every step is guarded so a missing resource is a no-op: teardown is
 * idempotent.
 */
export class CloudflareMediaDeprovisioner implements MediaDeprovisioner {
  readonly #projectDir: string;
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #r2Credentials: R2Credentials | undefined;
  readonly #account: ConfirmedAccount;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareMediaDeprovisionerOptions) {
    this.#projectDir = options.projectDir;
    this.#cf = options.cf;
    this.#project = options.project;
    this.#r2Credentials = options.r2Credentials;
    this.#account = options.account;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Delete the env's media worker if it is deployed. */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const { mediaWorkerName } = await loadMedia(this.#projectDir);
    const name = mediaWorkerName(this.#project, env);
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
    const { mediaBucketName } = await loadMedia(this.#projectDir);
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
}
