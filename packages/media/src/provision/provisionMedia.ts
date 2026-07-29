import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { MEDIA_CAPABILITY } from "../workflows/specs";

/**
 * The provisioning orchestration for the media capability — the live counterpart to `pithy add media`'s
 * config wiring. `pithy add` writes bindings; this stands up what those bindings point at: the R2 bucket
 * media objects live in, the `MEDIA` KV namespace when records live in KV, two per-environment secrets,
 * and the prebuilt media worker that hosts the four enrichment Workflows.
 *
 * **Two secrets, because media reads only one of them.** `media-storage-credentials` carries the Images
 * and Stream token media mints direct-upload URLs with. `media-r2-credentials` carries the R2 key pair
 * and bucket, and is read by `@pithy-sh/storage`'s `ObjectStore` — media declares the name and never
 * touches the values. Both are per environment, because the bucket is (see {@link mediaBucketName}).
 *
 * The live Cloudflare/wrangler steps are behind the {@link MediaProvisioner} seam, so the orchestration
 * (order, idempotency contract, per-env fan-out) is unit-tested without touching Cloudflare. **Every step
 * is idempotent** — find-then-create for resources, create-then-update for the secret, and a deploy that
 * overwrites — so re-running provisioning is a no-op on an already-provisioned account.
 *
 * **What it does not do.** Cloudflare exposes no API for minting an R2 S3 access-key pair, and the
 * permission catalog carries no Images or Stream keys, so nothing here mints a credential. The scoped API
 * token and the R2 key pair are supplied by the operator (flags, or `R2_CREDENTIALS` in `.dev.vars`) and
 * written into the secrets as given. Minting them is a follow-up, not a promise this command keeps today.
 */

/**
 * The R2 bucket media objects are stored in, **per environment** — `pithy-media-staging`,
 * `pithy-media-production`.
 *
 * One bucket per account would mean staging writes objects into the bucket production reads, and a
 * staging teardown deletes production's media. Buckets are free — the cost is bytes and operations —
 * so a shared one buys nothing and risks everything. This is the same per-environment posture the
 * media worker itself takes, and the opposite of `@pithy-sh/email`'s deliberately shared suppression
 * database, which is shared precisely *because* an unsubscribe must apply everywhere.
 */
export function mediaBucketName(env: ManagedEnvironment): string {
  return `pithy-${MEDIA_CAPABILITY}-${env}`;
}

/** The title of the KV namespace media records live in when `recordStore: 'kv'`. Per environment, for the same reason. */
export function mediaKvTitle(env: ManagedEnvironment): string {
  return `pithy-${MEDIA_CAPABILITY}-${env}`;
}

/** The deployed Worker name for an environment — also its resolved config basename. */
export function mediaWorkerName(env: ManagedEnvironment): string {
  return workflowHostName(MEDIA_CAPABILITY, env);
}

/** The provisioned resources every environment's worker and secret are wired to. */
export interface MediaResources {
  /** The R2 bucket media objects live in. */
  bucketName: string;
  /** The `MEDIA` KV namespace id, or `null` when records live in D1 and the binding is dropped. */
  kvNamespaceId: string | null;
}

/** The live Cloudflare/wrangler seam. Each step must be idempotent. */
export interface MediaProvisioner {
  /**
   * Verify account prerequisites before any resource is created — most importantly a registered
   * `workers.dev` subdomain, which Cloudflare requires to deploy the Workflow-hosting media worker.
   * Throws a clear, actionable error so provisioning fails fast and clean rather than mid-deploy.
   */
  preflight(): Promise<void>;
  /** Create (or reuse) this environment's R2 bucket; returns its name. Idempotent. */
  ensureBucket(env: ManagedEnvironment): Promise<{ bucketName: string }>;
  /**
   * Create (or reuse) this environment's `MEDIA` KV namespace, but only when records live in KV;
   * returns `null` otherwise so the resolver drops the binding rather than pointing it at a namespace
   * that was never created. Idempotent.
   */
  ensureKvNamespace(env: ManagedEnvironment): Promise<{ namespaceId: string } | null>;
  /**
   * Write this environment's two secrets: `media-storage-credentials` (the Images + Stream token and the
   * account id) and `media-r2-credentials` (the R2 key pair and this environment's bucket). Idempotent
   * (create, else update). Runs before any worker is deployed: a worker that boots without its
   * credentials fails on its first enrichment.
   */
  writeCredentials(env: ManagedEnvironment, resources: MediaResources): Promise<void>;
  /** Deploy the prebuilt media worker for this environment, wired to the provisioned resources. */
  deployWorker(env: ManagedEnvironment, resources: MediaResources): Promise<void>;
}

/** What provisioning produced, per environment. */
export interface MediaProvisionResult {
  /** Each environment provisioned, with the resources its worker and secret were wired to. */
  environments: Array<{ env: ManagedEnvironment } & MediaResources>;
}

/**
 * Provision the media infrastructure: check the account, create the bucket and (in KV mode) the
 * namespace once, write every environment's credentials, then deploy every environment's worker. The
 * order is the contract — the resources exist before a secret names them, and the secrets exist before a
 * worker that reads them boots. Idempotent end to end (each step is).
 */
export async function provisionMedia(provisioner: MediaProvisioner): Promise<MediaProvisionResult> {
  await provisioner.preflight();

  // Resources first for every environment, then credentials, then workers — the ordering is the
  // contract. A secret must not name a bucket that does not exist, and a worker must not boot before
  // the secret it reads. Fanning each phase across all environments (rather than completing one
  // environment at a time) means a failure in production's bucket stops the run before staging's
  // worker is deployed against a half-provisioned account.
  const resources = new Map<ManagedEnvironment, MediaResources>();
  for (const env of managedEnvironments()) {
    const { bucketName } = await provisioner.ensureBucket(env);
    const namespace = await provisioner.ensureKvNamespace(env);
    resources.set(env, { bucketName, kvNamespaceId: namespace?.namespaceId ?? null });
  }

  for (const env of managedEnvironments()) {
    await provisioner.writeCredentials(env, resourcesFor(resources, env));
  }
  for (const env of managedEnvironments()) {
    await provisioner.deployWorker(env, resourcesFor(resources, env));
  }

  return {
    environments: managedEnvironments().map((env) => ({ env, ...resourcesFor(resources, env) })),
  };
}

/** Read back an environment's resources. Absent is impossible by construction, so the throw is a bug check. */
function resourcesFor(resources: Map<ManagedEnvironment, MediaResources>, env: ManagedEnvironment): MediaResources {
  const found = resources.get(env);
  if (!found) throw new InternalError({ message: `No provisioned resources for the ${env} environment.` });
  return found;
}

/** The teardown seam — the inverse of {@link MediaProvisioner}. Every step idempotent (a missing resource is a no-op). */
export interface MediaDeprovisioner {
  /** Delete the env's media worker. Idempotent (a missing worker is a no-op). */
  deleteWorker(env: ManagedEnvironment): Promise<void>;
  /**
   * Delete this environment's R2 bucket **and every object in it**. **Destructive** — nothing here is
   * recoverable. Idempotent (a missing bucket is a no-op).
   *
   * Emptying the bucket is part of the contract, not a nicety: R2 refuses to delete a bucket that still
   * holds an object, or the parts of a multipart upload that was never completed. An implementation that
   * only called the control-plane delete would work on an untouched bucket and fail on every bucket
   * anyone had used.
   */
  deleteBucket(env: ManagedEnvironment): Promise<void>;
  /** Delete this environment's `MEDIA` KV namespace. **Destructive** — every KV-mode record is lost. Idempotent. */
  deleteKvNamespace(env: ManagedEnvironment): Promise<void>;
}

/** Teardown options. By default the stored media is **kept** — only the workers come down. */
export interface MediaDeprovisionOptions {
  /**
   * Also delete the R2 bucket — with every object in it — and the `MEDIA` KV namespace. Off by default,
   * because the objects and records they hold are the adopter's data and no deploy can restore them; the
   * flag is the confirmation.
   */
  deleteStorage?: boolean;
}

/**
 * Tear down the media infrastructure, reversing {@link provisionMedia}: delete every environment's worker
 * first (they bind the bucket and namespace), then — only when `deleteStorage` is set — the storage
 * itself, objects and all. Stored media is preserved unless explicitly requested. Idempotent end to end.
 */
export async function deprovisionMedia(
  deprovisioner: MediaDeprovisioner,
  options: MediaDeprovisionOptions = {},
): Promise<void> {
  for (const env of managedEnvironments()) {
    await deprovisioner.deleteWorker(env);
  }
  if (options.deleteStorage) {
    for (const env of managedEnvironments()) {
      await deprovisioner.deleteBucket(env);
      await deprovisioner.deleteKvNamespace(env);
    }
  }
}
