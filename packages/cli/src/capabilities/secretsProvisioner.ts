// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { TokenPermission } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import type { PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import { permissionsForKeys } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { secretsTokenProfile } from "@pithy-sh/secrets/src/capability";
import { encodeVersionedValue, initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { secrets_0001_init } from "@pithy-sh/secrets/src/migrations/0001_init";
import {
  initialMasterKeyConfig,
  MANAGER_CF_API_TOKEN_NAME,
  MANAGER_CF_API_TOKEN_SECRET_NAME,
  masterKeySecretName,
  type SecretsDeprovisioner,
  type SecretsProvisioner,
} from "@pithy-sh/secrets/src/provision/provisionSecrets";
import {
  type ManagerWranglerTemplate,
  managerWorkerName,
  resolveManagerConfig,
} from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { MigrationProvider } from "kysely/migration";
import type { CliAuditEmit } from "../audit/cliAudit";
import { runWrangler } from "../project/wrangler";

/** The secrets migration set, as provisioning runs it against each environment's D1. */
function secretsMigrationProvider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "secrets", namespace: "secrets", order: 100, migrations: { "0001_init": secrets_0001_init } },
  ]);
  const provider = registry.secrets;
  if (!provider) throw new Error("missing secrets migration provider");
  return provider;
}

/** The injected deploy step — resolve the manager's wrangler config and shell out to wrangler. */
export type DeployManager = (
  env: ManagedEnvironment,
  resolved: { databaseId: string; storeId: string },
) => Promise<void>;

export interface CloudflareSecretsProvisionerOptions {
  cf: CloudflareClients;
  /** The CF account id, used to scope the minted manager token to this account's resources. */
  accountId: string;
  /** The CF Secrets Store id holding the per-env master keys and the manager token. */
  storeId: string;
  /** Deploys the manager worker. Injected so the control-plane steps are testable without wrangler. */
  deploy: DeployManager;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * The least-privilege permissions the manager's minted token carries: Secrets Store Read + Write,
 * scoped to this account. Derived from the predefined `secrets` token profile — the one source of the
 * standard defaults each package needs (`pithy token`) — so the manager's scope and the profile never
 * drift. The manager's only live-CF use is the rotation config write-back; its D1 work runs through
 * the `SECRETS` binding, not this token — so nothing wider is granted.
 */
export function managerTokenPermissions(accountId: string): TokenPermission[] {
  return permissionsForKeys([...secretsTokenProfile.permissions] as PermissionKey[], accountId);
}

/**
 * The live {@link SecretsProvisioner} — the CF + wrangler implementation of `pithy add secrets`.
 * The control-plane steps go through `@pithy-sh/cloudflare` (CLAUDE.md: CF API only via that client)
 * and are each idempotent; the manager deploy is the injected wrangler step. Every step here is
 * exercised against live Cloudflare by the integration suite.
 */
export class CloudflareSecretsProvisioner implements SecretsProvisioner {
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #storeId: string;
  readonly #deploy: DeployManager;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSecretsProvisionerOptions) {
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#storeId = options.storeId;
    this.#deploy = options.deploy;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Require a registered `workers.dev` subdomain — Cloudflare needs one to deploy the managers. */
  async preflight(): Promise<void> {
    if (!(await this.#cf.workers().accountSubdomain())) {
      throw new ValidationError({
        message: "This Cloudflare account has no workers.dev subdomain, which Workflows require.",
        action: "Open Workers & Pages in the dashboard once to create one, then re-run.",
      });
    }
  }

  /**
   * Ensure the manager's runtime CF API token. Reuse the value already in the Secrets Store if present
   * (Cloudflare never returns a token's secret twice, so a stored token is trusted as-is); otherwise
   * get a fresh secret via `rollToken` — roll the existing manager token's value in place if one exists,
   * else mint a new least-privilege token — and write it into the store. A bootstrap token that cannot
   * mint fails here, before any resource is created, with an actionable error.
   */
  async ensureManagerToken(): Promise<void> {
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(MANAGER_CF_API_TOKEN_SECRET_NAME)) return;
    const minted = await this.#cf
      .accountTokens()
      .rollToken(MANAGER_CF_API_TOKEN_NAME, managerTokenPermissions(this.#accountId));
    await writeManagerCfApiToken(this.#cf, this.#storeId, minted.value);
    // Never the minted value — just that the manager's own runtime credential was (re)written.
    await this.#audit({
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: MANAGER_CF_API_TOKEN_SECRET_NAME,
      metadata: { name: MANAGER_CF_API_TOKEN_SECRET_NAME, kind: "manager_token" },
    });
  }

  /** Reuse the env's secrets D1 if it exists, otherwise create it. */
  async ensureDatabase(env: ManagedEnvironment): Promise<{ databaseId: string }> {
    const name = managerWorkerName(env);
    const existing = await this.#cf.d1Provisioner().findDatabaseByName(name);
    const db = existing ?? (await this.#cf.d1Provisioner().createDatabase(name));
    return { databaseId: db.uuid };
  }

  /** Mint the env's master key only if absent — replacing it would orphan every stored secret. */
  async ensureMasterKey(env: ManagedEnvironment): Promise<{ storeId: string }> {
    const name = masterKeySecretName(env);
    const store = this.#cf.secrets(this.#storeId);
    if (!(await store.exists(name))) {
      await store.putSecret(name, JSON.stringify(await initialMasterKeyConfig()));
      await this.#audit({
        action: "secrets/set",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: name,
        metadata: { name, kind: "master_key", env },
      });
    }
    return { storeId: this.#storeId };
  }

  /** Run the secrets migrations against the env's D1 over REST (idempotent — applied ones are skipped). */
  async migrate(_env: ManagedEnvironment, databaseId: string): Promise<void> {
    await runMigrations(this.#cf.d1(databaseId), secretsMigrationProvider());
  }

  /** Deploy the prebuilt manager worker for the environment. */
  async deployManager(env: ManagedEnvironment, resolved: { databaseId: string; storeId: string }): Promise<void> {
    await this.#deploy(env, resolved);
  }
}

/** The directory of the prebuilt manager worker inside the installed `@pithy-sh/secrets` package. */
function managerDir(): string {
  // Resolve through the package so it works installed (node_modules) or in the workspace; the
  // `./src/*` export maps `worker` → `src/manager/worker.ts`, whose directory holds wrangler.jsonc.
  return dirname(fileURLToPath(import.meta.resolve("@pithy-sh/secrets/src/manager/worker")));
}

/**
 * Write the scoped CF API token into the Secrets Store as the entry the manager binds at runtime.
 * The value is the uniform versioned-value envelope (a one-entry envelope on first write), so the
 * manager's `secretsStore` read decodes it exactly like every other secret. The token is `global` —
 * one fixed entry written once, bound the same way by every manager — so this is idempotent and
 * re-runnable: `putSecret` upserts, and a re-deploy rewrites the same entry with the same value.
 */
export async function writeManagerCfApiToken(cf: CloudflareClients, storeId: string, apiToken: string): Promise<void> {
  await cf
    .secrets(storeId)
    .putSecret(MANAGER_CF_API_TOKEN_SECRET_NAME, encodeVersionedValue(initialVersionedValue(apiToken)));
}

/**
 * Build the live deploy step. It resolves the manager's `wrangler.jsonc` template into a per-env
 * standalone config (filling the placeholder ids), writes it beside the worker so wrangler's relative
 * `main` resolves, then runs `wrangler deploy --config <resolved>`. The temp config is removed after.
 *
 * **Two distinct tokens, by design.** `apiToken` is the broad bootstrap token (`.dev.vars`
 * `CLOUDFLARE_API_TOKEN`) that authenticates the deploy itself — it can create Workers, D1, and so on.
 * The manager's **least-privilege** runtime token (scoped to Secrets Store Read + Write) is minted and
 * written into the Secrets Store earlier, by `ensureManagerToken`, so the worker's `CLOUDFLARE_API_TOKEN`
 * binding already resolves by deploy time. The broad token never reaches the worker; the minted token
 * never deploys. Auth flows through env vars, not `wrangler login` (CLAUDE.md §CF token bootstrap).
 */
export function buildManagerDeploy(options: { accountId: string; apiToken: string }): DeployManager {
  const { accountId, apiToken } = options;
  return async (env, resolved) => {
    const dir = managerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as ManagerWranglerTemplate;
    const config = resolveManagerConfig(template, { env, accountId, ...resolved });
    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId },
      });
    } finally {
      await unlink(configPath).catch(() => {});
    }
  };
}

export interface CloudflareSecretsDeprovisionerOptions {
  cf: CloudflareClients;
  /** The CF Secrets Store id holding the per-env master keys. */
  storeId: string;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * The live {@link SecretsDeprovisioner} — removes each environment's manager worker, (optionally) its
 * master key, and its secrets D1, all through `@pithy-sh/cloudflare`. Every step is guarded so a
 * missing resource is a no-op: teardown is idempotent and safe to re-run. The integration suite
 * exercises the full provision → teardown round trip.
 */
export class CloudflareSecretsDeprovisioner implements SecretsDeprovisioner {
  readonly #cf: CloudflareClients;
  readonly #storeId: string;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSecretsDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#storeId = options.storeId;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Delete the env's manager worker if it is deployed. */
  async deleteManager(env: ManagedEnvironment): Promise<void> {
    const name = managerWorkerName(env);
    if (await this.#cf.workers().getWorker(name)) {
      await this.#cf.workers().deleteWorker(name);
    }
  }

  /** Delete the env's master key if it is present — destructive, called only on a full destroy. */
  async deleteMasterKey(env: ManagedEnvironment): Promise<void> {
    const name = masterKeySecretName(env);
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(name)) {
      await store.deleteSecret(name);
      // Deleting a master key orphans every secret it encrypted — this is the destructive step.
      await this.#audit({
        action: "secrets/removed",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: name,
        metadata: { name, kind: "master_key", env },
      });
    }
  }

  /** Delete the env's secrets D1 if it exists. */
  async deleteDatabase(env: ManagedEnvironment): Promise<void> {
    const db = await this.#cf.d1Provisioner().findDatabaseByName(managerWorkerName(env));
    if (db) {
      await this.#cf.d1Provisioner().deleteDatabase(db.uuid);
    }
  }

  /**
   * Remove the shared manager token entirely — the inverse of `ensureManagerToken`. Delete the minted
   * account token from Cloudflare (every same-named token, so a re-minted duplicate is swept too), then
   * its Secrets Store entry. Both guarded: a missing token or entry is a no-op, so teardown is idempotent.
   */
  async deleteManagerToken(): Promise<void> {
    await this.#cf.accountTokens().deleteTokensByName(MANAGER_CF_API_TOKEN_NAME);
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(MANAGER_CF_API_TOKEN_SECRET_NAME)) {
      await store.deleteSecret(MANAGER_CF_API_TOKEN_SECRET_NAME);
      await this.#audit({
        action: "secrets/removed",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: MANAGER_CF_API_TOKEN_SECRET_NAME,
        metadata: { name: MANAGER_CF_API_TOKEN_SECRET_NAME, kind: "manager_token" },
      });
    }
  }
}
