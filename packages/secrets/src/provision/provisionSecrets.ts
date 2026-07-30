// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EncryptionConfig } from "../crypto/envelope";
import { generateKeyB64 } from "../rotation/keyRotation";
import { type ManagedEnvironment, managedEnvironments } from "../scope";

/**
 * The CF Secrets Store entry name holding an environment's master key. Staging and production share
 * one Secrets Store, so each env's key is a distinct, env-prefixed entry; the worker still binds it
 * under the fixed `SECRETS_ENCRYPTION_KEYS` name (see the manager's resolved `wrangler.jsonc`).
 */
export function masterKeySecretName(env: ManagedEnvironment): string {
  return `${env.toUpperCase()}_SECRETS_ENCRYPTION_KEYS`;
}

/**
 * The CF Secrets Store entry name holding the scoped CF API token, bound into each manager as
 * `CLOUDFLARE_API_TOKEN`. The token is `global` — one value, written once canonically and bound the
 * same way by both managers — so the entry name is fixed (no env prefix). Provisioning owns this
 * store-entry-name → binding-var mapping out of band; the manager registry stays keyed by the
 * binding var (see `manager/managerRegistry`).
 */
export const MANAGER_CF_API_TOKEN_SECRET_NAME = "GLOBAL_SECRETS_MANAGER_CF_API_TOKEN";

/**
 * The Cloudflare account-token **name** under which provisioning mints the manager's runtime
 * credential. Distinct from {@link MANAGER_CF_API_TOKEN_SECRET_NAME}, the Secrets Store entry name
 * that holds the token's value: this is the token's identity in the account's API-token list, the
 * key idempotent re-mint and teardown match on. One global token, so one fixed name (no env prefix).
 */
export const MANAGER_CF_API_TOKEN_NAME = "pithy-secrets-manager";

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
 */
export async function provisionSecrets(provisioner: SecretsProvisioner): Promise<ProvisionResult> {
  await provisioner.preflight();
  await provisioner.ensureManagerToken();
  const perEnv: ProvisionResult["perEnv"] = [];
  for (const env of managedEnvironments()) {
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
   * **and** its `GLOBAL_SECRETS_MANAGER_CF_API_TOKEN` entry from the Secrets Store. It is `global` —
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
  options: DeprovisionOptions = {},
): Promise<void> {
  for (const env of managedEnvironments()) {
    await deprovisioner.deleteManager(env);
    if (options.deleteKeys) await deprovisioner.deleteMasterKey(env);
    await deprovisioner.deleteDatabase(env);
  }
  await deprovisioner.deleteManagerToken();
}
