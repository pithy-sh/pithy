// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_PROFILE, RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import type { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import { FIELD_KEYS_BINDING } from "@pithy-sh/core/src/crypto/fieldKeys";
import { assertRetainedAgreed, type RetainedRows } from "@pithy-sh/core/src/migrations/retained";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { MASTER_KEY_BINDING } from "../env/masterKeyBinding";
import { generateKeyB64 } from "../rotation/keyRotation";
import { type DeprovisionTarget, deprovisionTarget, type ManagedEnvironment, managedEnvironments } from "../scope";

/**
 * The CF Secrets Store entry name holding an environment's master key — `<project>-<env>-secrets-encryption-keys`.
 *
 * A Cloudflare account has **one** Secrets Store, flat and unpartitionable, so the entry name is the
 * only partition there is. Without the project segment, two Pithy projects in one account would both
 * resolve to the same entry: the second `pithy secrets provision` would find the first's key already
 * there, adopt it, and encrypt its rows under another project's key — and either project's teardown
 * would then orphan both. The environment segment keeps staging and prod distinct within a project.
 *
 * Composed through core's naming facade as a **Secrets Store entry**, not through the generic composer.
 * The kind is what carries the limit: a store entry has no documented Cloudflare cap, so it is held to
 * Pithy's own ceiling rather than to R2's 63 — which is why this reads `…-secrets-encryption-keys`
 * rather than the hashed `…-secrets-encryp-91c2e9` a 63-character budget once produced. The facade also
 * validates the environment, so a stale spelling fails here rather than naming an entry nothing binds.
 *
 * The worker still binds this entry under the fixed `SECRETS_ENCRYPTION_KEYS` **binding** name; only the
 * store entry is scoped (see the manager's resolved `wrangler.jsonc`).
 */
export function masterKeySecretName(project: string, env: ManagedEnvironment, feature?: FeatureIdentity): string {
  // A feature's own key, named for the feature (#643): `<project>-feature-…` would be one key every open branch
  // shared. The scope composes it, the same call that names the entry the feature's app Worker binds.
  if (feature) return featureScope(feature).secretEntry(MASTER_KEY_BINDING, "environment");
  return resourceNames(project).env(env).secretEntry("secrets-encryption-keys");
}

/**
 * The CF Secrets Store entry holding an environment's field key — `<project>-<env>-pithy-field-keys` (#390), bound into
 * every app Worker that holds an encrypted field and into that environment's manager as `PITHY_FIELD_KEYS`.
 *
 * **A different entry from the master key, on purpose.** App Workers seal and open fields with it, so they hold it.
 * This feature never adds the master key to a Worker: a Worker that holds an encrypted field and composes no `secrets`
 * is bound this key alone. A feature gets its own, named for the feature, as its master key is.
 */
export function fieldKeysSecretName(project: string, env: ManagedEnvironment, feature?: FeatureIdentity): string {
  if (feature) return featureScope(feature).secretEntry(FIELD_KEYS_BINDING, "environment");
  // Composed from the binding, exactly as the binding pass composes every store secret an app Worker reads, so the
  // entry this mints and the entry an app Worker binds cannot be two names.
  return resourceNames(project).env(env).secretEntry(FIELD_KEYS_BINDING);
}

/**
 * **The application's one Cloudflare API token, in this environment's Secrets Store (#728)** —
 * `<project>-<env>-runtime-cf-api-token`, bound into the manager as `RUNTIME_CF_API_TOKEN` and into every
 * other Worker of the environment that calls Cloudflare. The same entry `pithy token mint runtime --env
 * <env>` writes, composed by the same facade call, so a mint and a provision cannot land on two entries.
 *
 * Per environment: revoking staging's token leaves production's manager rotating. A feature's manager
 * holds none (#643).
 */
export function runtimeTokenSecretName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).secretEntry(RUNTIME_TOKEN_SECRET);
}

/**
 * The account-token **name** the runtime token is minted, rolled and revoked under —
 * `<project>-<env>-runtime`, the identity `pithy token` keys the `runtime` profile on. Distinct from
 * {@link runtimeTokenSecretName}, the entry holding its value.
 */
export function runtimeTokenName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).apiToken(RUNTIME_PROFILE);
}

/**
 * The secret name the manager's own CF API token was known by, before `runtime` superseded it (#728).
 * Kept so an upgraded project's leftover can be found and named; nothing binds or mints it now.
 */
export const MANAGER_CF_API_TOKEN_SECRET = "SECRETS_MANAGER_CF_API_TOKEN";

/**
 * The Secrets Store entry the superseded manager token was written to —
 * `<project>-global-secrets-manager-cf-api-token`. **Superseded by {@link runtimeTokenSecretName}**, and
 * kept only so `pithy doctor` and `pithy token list` can say an upgraded project still holds it.
 */
export function managerCfApiTokenSecretName(project: string): string {
  return resourceNames(project).global.secretEntry(MANAGER_CF_API_TOKEN_SECRET);
}

/**
 * The account-token name the superseded manager token was minted under — `<project>-global-secrets-manager`.
 * **Superseded by {@link runtimeTokenName}.** Provisioning no longer mints it and teardown no longer
 * deletes it: the upgrade path is mint `runtime`, deploy, then revoke this, and nothing is revoked
 * automatically. Kept so the leftover can be named, by its exact identity, and revoked by the operator.
 */
export function managerCfApiTokenName(project: string): string {
  return resourceNames(project).global.apiToken("secrets-manager");
}

/**
 * Mint a fresh master key and build the initial encryption config to store as the env's
 * `SECRETS_ENCRYPTION_KEYS` at provision time: version 1, one key, current. A real
 * `ensureMasterKey` JSON-stringifies this and writes it to CF Secrets Store — but only when no key
 * exists yet, since replacing it would orphan every stored secret.
 */
export async function initialMasterKeyConfig(now: Date = new Date()): Promise<EncryptionConfig> {
  return { currentVersion: "1", versions: { "1": await generateKeyB64() }, lastRotatedAt: now.toISOString() };
}

/**
 * The provisioning orchestration for `pithy add secrets`. It stands up the durable, per-environment
 * secrets infrastructure that the rest of the capability assumes: a dedicated D1, a minted master
 * key, the migrated schema, and the deployed manager worker — once per managed environment.
 *
 * The live Cloudflare/wrangler operations are behind the {@link SecretsProvisioner} seam so the
 * orchestration is unit-tested (the sequence, the per-env fan-out, idempotency contract) without
 * touching Cloudflare; the real seam implementation is the live-CF glue, verified by the integration
 * suite. Each `ensure*` step must be **idempotent** — re-running `pithy add secrets` is a no-op.
 */
export interface SecretsProvisioner {
  /**
   * Verify the account prerequisites before any resource is created — most importantly that a
   * `workers.dev` subdomain is registered, which Cloudflare requires to deploy the Workflow-hosting
   * managers. Throws a clear error if a prerequisite is missing, so provisioning fails fast and clean
   * (nothing half-created) rather than partway through a deploy.
   */
  preflight(): Promise<void>;
  /**
   * Ensure this environment's runtime token — the application's one Cloudflare API token, which the
   * manager's rotation write-back runs on (#728) — and write it into the Secrets Store entry the manager
   * binds. Runs for every environment before any other resource, so a bootstrap credential that **cannot**
   * mint account tokens fails the whole provision fast and clean. Idempotent: reuse the stored token if
   * present, otherwise roll the existing runtime token's value in place (or mint one if none exists).
   */
  ensureRuntimeToken(env: ManagedEnvironment): Promise<void>;
  /** Create (or reuse) the per-env secrets D1; returns its id. Idempotent. */
  ensureDatabase(env: ManagedEnvironment): Promise<{ databaseId: string }>;
  /**
   * Mint the initial master key and store it as `SECRETS_ENCRYPTION_KEYS` for this environment;
   * returns the Secrets Store id. Idempotent — if the key already exists, it is left untouched (a
   * fresh key would orphan every stored secret).
   */
  ensureMasterKey(env: ManagedEnvironment): Promise<{ storeId: string }>;
  /**
   * Mint this environment's field key and store it as `PITHY_FIELD_KEYS` (#390): the key app Workers seal encrypted
   * fields with, in the master key's own format and never the master key. Idempotent, and for the master key's
   * reason — a fresh key over an existing one would orphan every sealed field.
   */
  ensureFieldKeys(env: ManagedEnvironment): Promise<void>;
  /** Run the `secrets_*` migrations against this environment's D1. Idempotent (already-applied are skipped). */
  migrate(env: ManagedEnvironment, databaseId: string): Promise<void>;
  /** Deploy the prebuilt manager worker for this environment, wired to the resolved resource ids. */
  deployManager(env: ManagedEnvironment, resolved: { databaseId: string; storeId: string }): Promise<void>;
}

/** What provisioning produced, per environment — the resource ids the manager's `wrangler.jsonc` needs. */
export interface ProvisionResult {
  perEnv: Array<{ env: ManagedEnvironment; databaseId: string; storeId: string }>;
}

/**
 * Provision every managed environment in order: ensure each environment's runtime token, then per env
 * create the D1, mint the master key and the field key, migrate, deploy the manager. The order matters — the tokens come
 * first (a bootstrap credential that cannot mint fails fast, before anything else is created), the
 * database and key exist before migrations run, and the manager is deployed last, once its resources and
 * the token it binds are in place. Idempotent end to end (each step is).
 *
 * `environments` is the project's declaration, and **the loop is over all of it**: an environment the
 * project deploys to and this skips is one whose secrets have no master key — the exact silence #241
 * found. One manager per declared environment is the price of declaring it (see `scope.ts`).
 */
export async function provisionSecrets(
  provisioner: SecretsProvisioner,
  environments: DeclaredEnvironments | readonly string[],
): Promise<ProvisionResult> {
  await provisioner.preflight();
  for (const env of managedEnvironments(environments)) await provisioner.ensureRuntimeToken(env);
  const perEnv: ProvisionResult["perEnv"] = [];
  for (const env of managedEnvironments(environments)) {
    const { databaseId } = await provisioner.ensureDatabase(env);
    const { storeId } = await provisioner.ensureMasterKey(env);
    await provisioner.ensureFieldKeys(env);
    await provisioner.migrate(env, databaseId);
    await provisioner.deployManager(env, { databaseId, storeId });
    perEnv.push({ env, databaseId, storeId });
  }
  return { perEnv };
}

/**
 * The teardown seam — the inverse of {@link SecretsProvisioner}, removing one environment's secrets
 * infrastructure. Behind the seam so the orchestration (the target, the retained-row refusal, order, the
 * key-deletion guard, which environment's runtime token goes) is unit-tested without Cloudflare; the live implementation
 * is verified by the integration suite. Every deletion is idempotent — a missing resource is a no-op.
 */
export interface SecretsDeprovisioner {
  /**
   * The rows in the retained tables of the env's secrets database — the vault — named by that database.
   * Read-only, and empty when the database is absent or holds nothing retained.
   */
  countRetained(env: ManagedEnvironment): Promise<RetainedRows[]>;
  /**
   * Delete the env's manager Workflows, by `managerWorkflowNames`. Idempotent (a Workflow already gone is a
   * no-op). Deleting the manager leaves them registered, so they go first (#789).
   */
  deleteWorkflows(env: ManagedEnvironment): Promise<void>;
  /** Delete the env's manager worker. Idempotent (a missing worker is a no-op). */
  deleteManager(env: ManagedEnvironment): Promise<void>;
  /**
   * Delete the env's master key from the Secrets Store. Destructive — every stored secret becomes
   * undecryptable — so the orchestration only calls it when explicitly asked. Idempotent.
   */
  deleteMasterKey(env: ManagedEnvironment): Promise<void>;
  /**
   * Delete the env's secrets D1. Idempotent (a missing database is a no-op). A live implementation refuses
   * while the vault holds more rows than the operator agreed to destroy — the floor under the orchestration's
   * exact count.
   */
  deleteDatabase(env: ManagedEnvironment): Promise<void>;
  /**
   * Remove this environment's runtime token entirely: delete the minted account token from Cloudflare
   * **and** its `<project>-<env>-runtime-cf-api-token` entry from the Secrets Store. Both names are
   * project- and environment-scoped, so this never reaches another environment's token or another
   * project's. Safe and ungated: the token is a re-mintable access credential, not a key, so removing it
   * orphans no secrets. Resolves whether either existed. Idempotent (a missing token or entry is a no-op).
   */
  deleteRuntimeToken(env: ManagedEnvironment): Promise<boolean>;
}

/** Teardown options. By default the master key is **kept** — deleting it is irreversible. */
export interface DeprovisionOptions {
  /** Also delete the environment's master key. Off by default. */
  deleteKeys?: boolean;
  /**
   * The operator's count of the retained rows to destroy — `--destroy-retained <n>`. Must equal the rows the
   * vault holds; absent, only an empty vault is deleted.
   */
  destroyRetained?: number;
}

/** What a teardown did. */
export interface DeprovisionResult {
  /** The one environment torn down. */
  environment: ManagedEnvironment;
  /** Whether this run removed the environment's runtime token — `false` when it was already gone. */
  runtimeTokenDeleted: boolean;
}

/**
 * Tear down **one named environment**, reversing {@link provisionSecrets} for it.
 *
 * In order, and the order is the contract:
 *
 * 1. Resolve the target ({@link deprovisionTarget}) — refused with nothing read when none was named.
 * 2. Count the vault and refuse unless the operator counted the same (`@pithy-sh/core`'s
 *    `assertRetainedAgreed`, #588's guard spent here). Before the manager goes: a refusal after it would leave
 *    an environment holding a vault and nothing to rotate it.
 * 3. Delete the manager's Workflows (#789), then the manager Worker (it binds the other resources), then — only
 *    when `deleteKeys` is set — the master key, then the D1.
 * 4. Delete this environment's runtime token. It is per environment, so another environment's manager keeps
 *    rotating on its own.
 */
export async function deprovisionSecrets(
  deprovisioner: SecretsDeprovisioner,
  target: DeprovisionTarget,
  options: DeprovisionOptions = {},
): Promise<DeprovisionResult> {
  const env = deprovisionTarget(target);
  assertRetainedAgreed(await deprovisioner.countRetained(env), options.destroyRetained, "anything was deleted");

  await deprovisioner.deleteWorkflows(env);
  await deprovisioner.deleteManager(env);
  if (options.deleteKeys) await deprovisioner.deleteMasterKey(env);
  await deprovisioner.deleteDatabase(env);

  return { environment: env, runtimeTokenDeleted: await deprovisioner.deleteRuntimeToken(env) };
}
