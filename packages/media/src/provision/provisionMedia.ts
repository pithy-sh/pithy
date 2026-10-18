// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { resourceNames, type ScopedNames } from "@pithy-sh/core/src/naming/resourceNames";
import {
  type DeprovisionTarget,
  deprovisionTarget,
  type ManagedEnvironment,
  managedEnvironments,
} from "@pithy-sh/secrets/src/scope";
import { MediaConfig } from "../config/config";
import { MEDIA_CAPABILITY } from "../workflows/specs";

/**
 * The provisioning orchestration for the media capability — the live counterpart to `pithy add media`'s
 * config wiring. `pithy add` writes bindings; this stands up what those bindings point at: the R2 bucket
 * media objects live in, the per-environment secrets, and the prebuilt media worker that hosts the four
 * enrichment Workflows.
 *
 * **Two credentials, because media reads only one of them.** `media-storage-credentials` carries the
 * account media's Images and Stream assets live in, and nothing else: media mints their uploads with the
 * application's one `runtime` token (#728), which this asks for nowhere. `media-r2-credentials` carries the
 * R2 key pair and bucket, and is read by `@pithy-sh/storage`'s `ObjectStore` — media declares the name and
 * never touches the values. Both are per environment, because the bucket is (see {@link mediaBucketName}).
 *
 * **Two signing keys, because private media is delivered signed.** A non-public Images or Stream asset
 * is uploaded with `requireSignedURLs`, and the Worker signs a short-lived URL for a reader with
 * `media-images-signing-key` or `media-stream-signing-key`. Both are read off the account here, and
 * written only where some record could be anything but public.
 *
 * **A variant that serves unsigned is refused.** An Images variant set to `neverRequireSignedURLs` serves
 * a private image to anyone holding its URL, so provisioning names each one and stops before anything is
 * created, while a project's images could be private.
 *
 * The live Cloudflare/wrangler steps are behind the {@link MediaProvisioner} seam, so the orchestration
 * (order, idempotency contract, per-env fan-out) is unit-tested without touching Cloudflare. **Every step
 * is idempotent** — find-then-create for resources, create-then-update for the secret, and a deploy that
 * overwrites — so re-running provisioning is a no-op on an already-provisioned account.
 *
 * **What it does not do.** Cloudflare exposes no API for minting an R2 S3 access-key pair, so the pair is
 * supplied by the operator (flags, or `R2_CREDENTIALS` in `.dev.vars`) and written into the secret as given.
 * Nothing here mints a Cloudflare API token: the runtime token is `pithy secrets provision`'s and
 * `pithy token mint runtime`'s, and every Worker of the environment reads that one.
 */

/**
 * Every name media provisions under, for one project in one environment.
 *
 * One call to the facade, so the project is validated once and the environment once — the R2 bucket and
 * the host Worker then each ask for their own kind of resource and get that namespace's own limit. Going
 * through the facade is what stops one number standing in for both, and what refuses `production` here
 * rather than quietly provisioning a fourth environment.
 */
function mediaNames(project: string, env: ManagedEnvironment): ScopedNames {
  return resourceNames(project).env(env);
}

/**
 * The R2 bucket media objects are stored in, **per project and per environment** —
 * `acme-staging-media`, `acme-prod-media`.
 *
 * One bucket per account would mean staging writes objects into the bucket prod reads, and a
 * staging teardown deletes prod's media. Buckets are free — the cost is bytes and operations —
 * so a shared one buys nothing and risks everything. This is the same per-environment posture the
 * media worker itself takes, and the opposite of `@pithy-sh/email`'s deliberately project-shared
 * suppression database, which is shared precisely *because* an unsubscribe must apply everywhere.
 *
 * The project segment carries ownership. R2's namespace is flat and account-wide, and provisioning
 * reuses a bucket it finds by name — so without it, a second Pithy project in the same account adopts
 * this one's bucket instead of creating its own, and either teardown takes both projects' media.
 *
 * Named through the facade's `r2` getter, which carries R2's own rule — 3 to 63 characters, starting
 * and ending alphanumeric — rather than a number this file picked.
 *
 * **The `<thing>` segment is `media`, and `packages/media/pithy.manifest.json` now says so too**, with
 * `"resource": "media"` on the `MEDIA_BUCKET` binding (#519). Until it did, `pithy add` and `pithy
 * provision` composed `<project>-<env>-media-bucket` from the binding name while this composed
 * `<project>-<env>-media`: two names for one bucket, which is #513's defect in the two capabilities that
 * issue left out. The binding keeps `_BUCKET` — it is read as `env.MEDIA_BUCKET` in a Worker and should
 * say what kind of thing it is — and the resource drops it, because `r2` is already the composed name's
 * own kind. `cli/src/ci/bindingResourceNames.test.ts` holds this function and that manifest line to one
 * string, at a four-character project name and at the longest one a config may declare.
 */
export function mediaBucketName(project: string, env: ManagedEnvironment): string {
  return mediaNames(project, env).r2(MEDIA_CAPABILITY);
}

/**
 * The deployed Worker name for a project's environment — also its resolved config basename. Held to
 * the Worker rule (63, refused rather than truncated: a script cannot be renamed after a deploy
 * without orphaning it and every `service` binding pointing at it).
 */
export function mediaWorkerName(project: string, env: ManagedEnvironment): string {
  return mediaNames(project, env).worker(MEDIA_CAPABILITY);
}

/** The provisioned resources every environment's worker and secret are wired to. */
export interface MediaResources {
  /** The R2 bucket media objects live in. */
  bucketName: string;
}

/** The live Cloudflare/wrangler seam. Each step must be idempotent. */
export interface MediaProvisioner {
  /**
   * Verify account prerequisites before any resource is created — most importantly a registered
   * `workers.dev` subdomain, which Cloudflare requires to deploy the Workflow-hosting media worker.
   * Throws a clear, actionable error so provisioning fails fast and clean rather than mid-deploy.
   *
   * Told every environment the run will write, because a refusal that needs one — an environment with no
   * runtime token while the host binds one (#728) — must land before {@link writeCredentials} rewrites any
   * bundle. A still-deployed Worker on the old kit cannot read a bundle rewritten without its token.
   */
  preflight(environments: readonly ManagedEnvironment[]): Promise<void>;
  /** Create (or reuse) this environment's R2 bucket; returns its name. Idempotent. */
  ensureBucket(env: ManagedEnvironment): Promise<{ bucketName: string }>;
  /** The names of every Cloudflare Images variant set to `neverRequireSignedURLs`. */
  unsignedVariants(): Promise<string[]>;
  /**
   * Write this environment's two secrets: `media-storage-credentials` (the account id) and
   * `media-r2-credentials` (the R2 key pair and this environment's bucket). Idempotent
   * (create, else update). Runs before any worker is deployed: a worker that boots without its
   * credentials fails on its first enrichment.
   */
  writeCredentials(env: ManagedEnvironment, resources: MediaResources): Promise<void>;
  /**
   * Write this environment's signing keys — `media-images-signing-key` when images live in Cloudflare
   * Images, `media-stream-signing-key` when video lives in Stream. Idempotent: the Images key is the
   * account's own and rewritten as found; a Stream key's private half is returned only at creation, so one
   * is created only when the environment holds none.
   */
  writeSigningKeys(env: ManagedEnvironment): Promise<void>;
  /** Deploy the prebuilt media worker for this environment, wired to the provisioned resources. */
  deployWorker(env: ManagedEnvironment, resources: MediaResources): Promise<void>;
}

/** What {@link provisionMedia} is told about the project, beyond the environments. */
export interface MediaProvisionOptions {
  /** The app's resolved media config — decides which signing keys exist and whether variants matter. */
  readonly config?: MediaConfig;
}

/** Whether any record this config admits could be anything but public. */
export function admitsPrivateMedia(config: MediaConfig): boolean {
  return config.visibility.allowed.some((level) => level !== "public");
}

/**
 * Refuse, naming each, the Images variants that would serve a private image unsigned — but only while
 * images live in Cloudflare Images and could be private. A project whose every record is public, or whose
 * images are in R2, has nothing a variant could leak.
 */
export async function refuseUnsignedVariants(provisioner: MediaProvisioner, config: MediaConfig): Promise<void> {
  if (config.images.store !== "cf-images" || !admitsPrivateMedia(config)) return;
  const unsigned = await provisioner.unsignedVariants();
  if (unsigned.length === 0) return;
  throw new ValidationError({
    message: `Cloudflare Images variant${unsigned.length === 1 ? "" : "s"} ${unsigned.map((name) => `\`${name}\``).join(", ")} serve${unsigned.length === 1 ? "s" : ""} every image unsigned, so a private image would be public through ${unsigned.length === 1 ? "it" : "them"}.`,
    action:
      'Turn off neverRequireSignedURLs on each in Images → Variants, or narrow visibility.allowed to ["public"] in media({ … }), then re-run.',
    detail: `variants with neverRequireSignedURLs: ${unsigned.join(", ")}; visibility.allowed is ${config.visibility.allowed.join(", ")}`,
  });
}

/** What provisioning produced, per environment. */
export interface MediaProvisionResult {
  /** Each environment provisioned, with the resources its worker and secret were wired to. */
  environments: Array<{ env: ManagedEnvironment } & MediaResources>;
}

/**
 * Provision the media infrastructure: check the account and its variants, create every environment's
 * bucket, write every environment's credentials and signing keys, then deploy every environment's worker.
 * The order is the contract — the resources exist before a secret names them, and the secrets exist
 * before a worker that reads them boots. Idempotent end to end (each step is).
 *
 * `environments` is **what the caller determined it can act on**, which the CLI narrows from the project's
 * declaration (#241) to the environments whose app database exists (pithy-sh/pithy#512). Nothing is
 * skipped here and nothing decides here: an environment reaching this list is provisioned, and one that
 * did not was already reported to the operator by name, with why and with the command that fixes it.
 */
export async function provisionMedia(
  provisioner: MediaProvisioner,
  environments: DeclaredEnvironments | readonly string[],
  options: MediaProvisionOptions = {},
): Promise<MediaProvisionResult> {
  await provisioner.preflight(managedEnvironments(environments));
  // Before anything is created: a variant that would serve a private image unsigned is a refusal, not a
  // warning to read later.
  await refuseUnsignedVariants(provisioner, options.config ?? MediaConfig.parse({}));

  // Resources first for every environment, then credentials, then workers — the ordering is the
  // contract. A secret must not name a bucket that does not exist, and a worker must not boot before
  // the secret it reads. Fanning each phase across all environments (rather than completing one
  // environment at a time) means a failure in prod's bucket stops the run before staging's
  // worker is deployed against a half-provisioned account.
  const resources = new Map<ManagedEnvironment, MediaResources>();
  for (const env of managedEnvironments(environments)) {
    const { bucketName } = await provisioner.ensureBucket(env);
    resources.set(env, { bucketName });
  }

  for (const env of managedEnvironments(environments)) {
    await provisioner.writeCredentials(env, resourcesFor(resources, env));
    await provisioner.writeSigningKeys(env);
  }
  for (const env of managedEnvironments(environments)) {
    await provisioner.deployWorker(env, resourcesFor(resources, env));
  }

  return {
    environments: managedEnvironments(environments).map((env) => ({ env, ...resourcesFor(resources, env) })),
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
}

/** Teardown options. By default the stored media is **kept** — only the workers come down. */
export interface MediaDeprovisionOptions {
  /**
   * Also delete the R2 bucket — with every object in it. Off by default, because the objects are the
   * adopter's data and no deploy can restore them; the flag is the confirmation.
   */
  deleteStorage?: boolean;
}

/**
 * Tear down **one named environment's** media infrastructure, reversing {@link provisionMedia} for it: its
 * worker first (it binds the bucket), then — only when `deleteStorage` is set — its bucket, objects and
 * all. Stored media is preserved unless explicitly requested.
 * Idempotent end to end.
 *
 * The environment is resolved by `@pithy-sh/secrets`' {@link deprovisionTarget}, before anything is deleted:
 * absent, or undeclared, it refuses and lists the project's set. This used to walk every declared environment,
 * so `pithy media deprovision --storage`, run to clear staging's media, deleted production's bucket with it
 * (#591).
 */
export async function deprovisionMedia(
  deprovisioner: MediaDeprovisioner,
  target: DeprovisionTarget,
  options: MediaDeprovisionOptions = {},
): Promise<{ env: ManagedEnvironment }> {
  const env = deprovisionTarget(target);
  await deprovisioner.deleteWorker(env);
  if (options.deleteStorage) {
    await deprovisioner.deleteBucket(env);
  }
  return { env };
}
