import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { secrets_0001_init } from "@pithy-sh/secrets/src/migrations/0001_init";
import {
  initialMasterKeyConfig,
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
  /** The CF Secrets Store id holding the per-env master keys. */
  storeId: string;
  /** Deploys the manager worker. Injected so the control-plane steps are testable without wrangler. */
  deploy: DeployManager;
}

/**
 * The live {@link SecretsProvisioner} — the CF + wrangler implementation of `pithy add secrets`.
 * The control-plane steps go through `@pithy-sh/cloudflare` (CLAUDE.md: CF API only via that client)
 * and are each idempotent; the manager deploy is the injected wrangler step. Every step here is
 * exercised against live Cloudflare by the integration suite.
 */
export class CloudflareSecretsProvisioner implements SecretsProvisioner {
  readonly #cf: CloudflareClients;
  readonly #storeId: string;
  readonly #deploy: DeployManager;

  constructor(options: CloudflareSecretsProvisionerOptions) {
    this.#cf = options.cf;
    this.#storeId = options.storeId;
    this.#deploy = options.deploy;
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
 * Build the live deploy step. It resolves the manager's `wrangler.jsonc` template into a per-env
 * standalone config (filling the placeholder ids), writes it beside the worker so wrangler's relative
 * `main` resolves, runs `wrangler deploy --config <resolved>`, then sets the deploy-only
 * `CLOUDFLARE_API_TOKEN` secret (kept out of the config — it is sensitive). The temp config is removed after.
 *
 * Auth flows through env vars, not `wrangler login`: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
 * come from the `.dev.vars` bootstrap token (CLAUDE.md §CF token bootstrap), so `.dev.vars` stays the
 * single credential source.
 */
export function buildManagerDeploy(options: {
  cf: CloudflareClients;
  accountId: string;
  apiToken: string;
}): DeployManager {
  const { cf, accountId, apiToken } = options;
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
      // The manager reads CLOUDFLARE_API_TOKEN at runtime (the rotation Workflow writes back to the
      // store). It is sensitive, so it is a deployment secret, never a config var.
      await cf.workers().addSecret(managerWorkerName(env), "CLOUDFLARE_API_TOKEN", apiToken);
    } finally {
      await unlink(configPath).catch(() => {});
    }
  };
}

export interface CloudflareSecretsDeprovisionerOptions {
  cf: CloudflareClients;
  /** The CF Secrets Store id holding the per-env master keys. */
  storeId: string;
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

  constructor(options: CloudflareSecretsDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#storeId = options.storeId;
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
    }
  }

  /** Delete the env's secrets D1 if it exists. */
  async deleteDatabase(env: ManagedEnvironment): Promise<void> {
    const db = await this.#cf.d1Provisioner().findDatabaseByName(managerWorkerName(env));
    if (db) {
      await this.#cf.d1Provisioner().deleteDatabase(db.uuid);
    }
  }
}
