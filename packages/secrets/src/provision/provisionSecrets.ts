// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { EncryptionConfig } from "../crypto/envelope";
import { generateKeyB64 } from "../rotation/keyRotation";
import { type ManagedEnvironment, managedEnvironments } from "../scope";

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
export function masterKeySecretName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).secretEntry("secrets-encryption-keys");
}

/**
 * The profile/`.dev.vars` **secret name** the manager's CF API token is known by — the registry join
 * key, not a Secrets Store entry name. Deliberately unscoped: it is a variable key, and scoping it
 * would rename an environment variable rather than partition an account-wide namespace.
 */
export const MANAGER_CF_API_TOKEN_SECRET = "SECRETS_MANAGER_CF_API_TOKEN";

/**
 * The CF Secrets Store entry name holding the scoped CF API token, bound into each manager as
 * `CLOUDFLARE_API_TOKEN` — `<project>-global-secrets-manager-cf-api-token`.
 *
 * The token is `global` (one value, written once canonically and bound the same way by every manager
 * of this project), so the literal `global` fills the environment slot rather than being omitted — the
 * naming rule has no exception to remember. The facade makes that a property rather than a string:
 * `names.global` is the same interface an environment gets, so no call site can typo the scope into a
 * near-miss of a real environment. Provisioning owns this store-entry-name → binding-var mapping out of
 * band; the manager registry stays keyed by the binding var (see `manager/managerRegistry`).
 */
export function managerCfApiTokenSecretName(project: string): string {
  return resourceNames(project).global.secretEntry(MANAGER_CF_API_TOKEN_SECRET);
}

/**
 * The Cloudflare account-token **name** under which provisioning mints the manager's runtime
 * credential — `<project>-global-secrets-manager`. Distinct from
 * {@link managerCfApiTokenSecretName}, the Secrets Store entry name that holds the token's value:
 * this is the token's identity in the account's API-token list, the key idempotent re-mint and
 * teardown match on.
 *
 * The account's token list is flat too, and teardown deletes **every** token of this name. An
 * unscoped name would therefore make one project's `pithy secrets deprovision` revoke every other
 * project's manager credential in the same account — every one of their rotations failing at once.
 *
 * Named as an **API token** through the facade, which is the only reason the two functions can differ
 * in budget as well as in suffix: a token label is a free-text field Cloudflare puts no cap on.
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
   * Ensure the manager's least-privilege CF API token (Secrets Store Read + Write) and write it into
   * the Secrets Store as the manager's runtime credential — once, before any per-env work, since the
   * token is `global`. Runs first so a bootstrap token that **cannot** mint account tokens fails the
   * whole provision fast and clean, before any resource is created. Idempotent: reuse the stored token
   * if present, otherwise roll the existing manager token's value in place (or mint one if none exists).
   */
  ensureManagerToken(): Promise<void>;
  /** Create (or reuse) the per-env secrets D1; returns its id. Idempotent. */
  ensureDatabase(env: ManagedEnvironment): Promise<{ databaseId: string }>;
  /**
   * Mint the initial master key and store it as `SECRETS_ENCRYPTION_KEYS` for this environment;
   * returns the Secrets Store id. Idempotent — if the key already exists, it is left untouched (a
   * fresh key would orphan every stored secret).
   */
  ensureMasterKey(env: ManagedEnvironment): Promise<{ storeId: string }>;
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
 * Provision every managed environment in order: mint the global manager token, then per env create
 * the D1, mint the master key, migrate, deploy the manager. The order matters — the manager token is
 * minted first (one global credential, and a bootstrap token that cannot mint fails fast before
 * anything is created), the database and key exist before migrations run, and the manager is deployed
 * last, once its resources are in place. Idempotent end to end (each step is).
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
  await provisioner.ensureManagerToken();
  const perEnv: ProvisionResult["perEnv"] = [];
  for (const env of managedEnvironments(environments)) {
    const { databaseId } = await provisioner.ensureDatabase(env);
    const { storeId } = await provisioner.ensureMasterKey(env);
    await provisioner.migrate(env, databaseId);
    await provisioner.deployManager(env, { databaseId, storeId });
    perEnv.push({ env, databaseId, storeId });
  }
  return { perEnv };
}

/**
 * The teardown seam — the inverse of {@link SecretsProvisioner}, removing each environment's secrets
 * infrastructure. Behind the seam so the orchestration (order, the key-deletion guard, idempotency)
 * is unit-tested without Cloudflare; the live implementation is verified by the integration suite.
 * Every step is idempotent — a missing resource is a no-op, so re-running teardown is safe.
 */
export interface SecretsDeprovisioner {
  /** Delete the env's manager worker. Idempotent (a missing worker is a no-op). */
  deleteManager(env: ManagedEnvironment): Promise<void>;
  /**
   * Delete the env's master key from the Secrets Store. Destructive — every stored secret becomes
   * undecryptable — so the orchestration only calls it when explicitly asked. Idempotent.
   */
  deleteMasterKey(env: ManagedEnvironment): Promise<void>;
  /** Delete the env's secrets D1. Idempotent (a missing database is a no-op). */
  deleteDatabase(env: ManagedEnvironment): Promise<void>;
  /**
   * Remove the manager's CF API token entirely: delete the minted account token from Cloudflare
   * **and** its `<project>-global-secrets-manager-cf-api-token` entry from the Secrets Store. Both
   * names are project-scoped, so this never reaches another project's credential. It is `global` —
   * one token shared by both managers — so it is removed once, after every manager is gone. Safe and
   * ungated: the token is a re-mintable access credential, not a key, so removing it orphans no
   * secrets. Idempotent (a missing token or entry is a no-op).
   */
  deleteManagerToken(): Promise<void>;
}

/** Teardown options. By default the master keys are **kept** — deleting them is irreversible. */
export interface DeprovisionOptions {
  /** Also delete each environment's master key. Off by default; only a full destroy sets it. */
  deleteKeys?: boolean;
}

/**
 * Tear down every managed environment, reversing {@link provisionSecrets}: delete the manager worker
 * first (it binds the other resources), then — only when `deleteKeys` is set — the master key, then
 * the D1. The master key is preserved unless explicitly requested: losing it orphans every secret,
 * and a re-provision can reuse the existing key. The shared manager CF API token is deleted once at
 * the end, after every manager that binds it is gone. Idempotent end to end.
 */
export async function deprovisionSecrets(
  deprovisioner: SecretsDeprovisioner,
  environments: DeclaredEnvironments | readonly string[],
  options: DeprovisionOptions = {},
): Promise<void> {
  for (const env of managedEnvironments(environments)) {
    await deprovisioner.deleteManager(env);
    if (options.deleteKeys) await deprovisioner.deleteMasterKey(env);
    await deprovisioner.deleteDatabase(env);
  }
  await deprovisioner.deleteManagerToken();
}
