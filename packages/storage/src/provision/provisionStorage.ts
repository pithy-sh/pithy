// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { STORAGE_CAPABILITY } from "../workflows/specs";

/**
 * The provisioning orchestration for the storage capability — the live counterpart to
 * `pithy add storage`'s config wiring.
 *
 * The split is deliberate and worth stating, because the two commands look like one. `pithy add`
 * writes *bindings*: it installs the package, adds `storage()` to `pithy.config.ts`, and puts a
 * `STORAGE_BUCKET` entry in `wrangler.jsonc`. It touches no Cloudflare account and provisions
 * nothing — an `add` that reached out to an account would make adding a capability an operation you
 * could not do offline, or in CI, or without credentials. This command stands up what those bindings
 * point at: the R2 bucket, the per-environment credential secret, and the sweep worker.
 *
 * The `STORAGE_SWEEP` Workflow binding is the exception, and it belongs to this side of the split.
 * Wrangler requires a `name` and a `class_name` on every `workflows` entry, and the deployed name is
 * per environment — so `add` writes none (a partial entry stops wrangler loading the config) and the
 * CLI writes the complete entry here, once the host worker exists.
 *
 * The live Cloudflare/wrangler steps sit behind the {@link StorageProvisioner} seam, so the
 * orchestration — order, idempotency, per-environment fan-out — is unit-tested with a fake that
 * records its call order, and no account. **Every step is idempotent**: find-then-create for the
 * bucket, create-then-update for the secret, and a deploy that overwrites. Re-running is a no-op.
 *
 * **What it does not do.** Cloudflare exposes no API for minting an R2 S3 access-key pair, so nothing
 * here mints one. The pair is supplied by the operator — flags, or `R2_CREDENTIALS` in `.dev.vars` —
 * and written into the secret as given. That is a real limitation, and the manifest says so rather
 * than promising a mint that does not happen.
 */

/**
 * The bucket objects live in, **per project and per environment** — `acme-staging-storage`,
 * `acme-prod-storage`.
 *
 * One bucket per account would mean staging writes objects into the bucket prod reads, and a staging
 * teardown deletes prod's files. Buckets are free — the cost is bytes and operations — so a shared one
 * buys nothing and risks everything. The same posture `@pithy-sh/media` takes, and the opposite of
 * `@pithy-sh/email`'s deliberately project-shared suppression database.
 *
 * The project segment is what makes provisioning's find-then-create safe. R2's namespace is flat and
 * account-wide, so an unprefixed `pithy-storage-prod` would be *found* by a second Pithy project in the
 * same account and silently adopted — two apps writing objects into one bucket, and either teardown
 * deleting both. The name is the only partition R2 offers, so the name carries the owner.
 *
 * Named as an **R2 bucket** through core's naming facade, which is the one namespace whose rule is
 * genuinely 3–63 lowercase characters, starting and ending alphanumeric. Every other namespace Pithy
 * writes into was once held to that same 63 for no reason; asking for a bucket by name is how this one
 * keeps it on purpose.
 */
export function storageBucketName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).r2(STORAGE_CAPABILITY);
}

/**
 * The deployed sweep-worker name for a project's environment — also its resolved config's basename.
 *
 * A **Worker script**, so 63 rather than the Workflow's 64, and refused rather than truncated: a script
 * cannot be renamed once a deploy or a `service` binding points at it.
 */
export function storageWorkerName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).worker(STORAGE_CAPABILITY);
}

/** The provisioned resources an environment's worker and secret are wired to. */
export interface StorageResources {
  /** The R2 bucket objects live in. */
  bucketName: string;
}

/** The live Cloudflare/wrangler seam. Each step must be idempotent. */
export interface StorageProvisioner {
  /**
   * Verify account prerequisites before any resource is created — most importantly a registered
   * `workers.dev` subdomain, which Cloudflare requires to deploy a Workflow-hosting worker. Failing
   * here means failing before a bucket exists, rather than half way through a fan-out.
   */
  preflight(): Promise<void>;
  /** Create (or reuse) this environment's R2 bucket; returns its name. Idempotent. */
  ensureBucket(env: ManagedEnvironment): Promise<{ bucketName: string }>;
  /**
   * Write this environment's `storage-r2-credentials` secret — the account id, S3 key pair, scoped
   * token, and bucket name the object store presigns with. Idempotent (create, else update). Runs
   * before the worker is deployed: a worker that boots without its credentials fails on its first
   * multipart abort.
   */
  writeCredentials(env: ManagedEnvironment, resources: StorageResources): Promise<void>;
  /** Deploy the prebuilt sweep worker for this environment, wired to the provisioned bucket. */
  deployWorker(env: ManagedEnvironment, resources: StorageResources): Promise<void>;
}

/** What provisioning produced, per environment. */
export interface StorageProvisionResult {
  /** Each environment provisioned, with the resources its worker and secret were wired to. */
  environments: Array<{ env: ManagedEnvironment } & StorageResources>;
}

/**
 * Provision the storage infrastructure: check the account, create every environment's bucket, write
 * every environment's credentials, then deploy every environment's sweep worker.
 *
 * The phase order is the contract. A secret must not name a bucket that does not exist, and a worker
 * must not boot before the secret it reads. Fanning each phase across all environments — rather than
 * completing one environment end to end before starting the next — means a failure creating prod's
 * bucket stops the run before staging's worker is deployed against a half-provisioned account.
 */
export async function provisionStorage(provisioner: StorageProvisioner): Promise<StorageProvisionResult> {
  await provisioner.preflight();

  const resources = new Map<ManagedEnvironment, StorageResources>();
  for (const env of managedEnvironments()) {
    const { bucketName } = await provisioner.ensureBucket(env);
    resources.set(env, { bucketName });
  }

  for (const env of managedEnvironments()) {
    await provisioner.writeCredentials(env, resourcesFor(resources, env));
  }
  for (const env of managedEnvironments()) {
    await provisioner.deployWorker(env, resourcesFor(resources, env));
  }

  return { environments: managedEnvironments().map((env) => ({ env, ...resourcesFor(resources, env) })) };
}

/** Read back an environment's resources. Absent is impossible by construction, so the throw is a bug check. */
function resourcesFor(resources: Map<ManagedEnvironment, StorageResources>, env: ManagedEnvironment): StorageResources {
  const found = resources.get(env);
  if (!found) throw new InternalError({ message: `No provisioned resources for the ${env} environment.` });
  return found;
}

/** The teardown seam — the inverse of {@link StorageProvisioner}. Every step idempotent. */
export interface StorageDeprovisioner {
  /** Delete this environment's sweep worker. Idempotent (a missing worker is a no-op). */
  deleteWorker(env: ManagedEnvironment): Promise<void>;
  /**
   * Delete this environment's R2 bucket **and every file in it**. **Destructive** — nothing here is
   * recoverable. Idempotent (a missing bucket is a no-op).
   *
   * Emptying the bucket is part of the contract, not a nicety: R2 refuses to delete a bucket that still
   * holds an object, or the parts of a multipart upload that was never completed. An implementation that
   * only called the control-plane delete would work on an untouched bucket and fail on every bucket
   * anyone had used.
   */
  deleteBucket(env: ManagedEnvironment): Promise<void>;
}

/** Teardown options. By default the stored files are **kept** — only the sweep workers come down. */
export interface StorageDeprovisionOptions {
  /**
   * Also delete the R2 buckets, with every file in them. Off by default, because those files are the
   * adopter's data and no deploy can restore them — the flag is the confirmation.
   */
  deleteStorage?: boolean;
}

/**
 * Tear down the storage infrastructure, reversing {@link provisionStorage}: delete every environment's
 * sweep worker first (they bind the bucket), then — only when `deleteStorage` is set — the buckets and
 * everything in them. Idempotent end to end.
 */
export async function deprovisionStorage(
  deprovisioner: StorageDeprovisioner,
  options: StorageDeprovisionOptions = {},
): Promise<void> {
  for (const env of managedEnvironments()) {
    await deprovisioner.deleteWorker(env);
  }
  if (options.deleteStorage) {
    for (const env of managedEnvironments()) {
      await deprovisioner.deleteBucket(env);
    }
  }
}
