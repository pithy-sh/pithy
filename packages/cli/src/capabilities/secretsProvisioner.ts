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
  managerCfApiTokenName,
  managerCfApiTokenSecretName,
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
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
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
   * The project name (root `pithy.config.ts` `name`, via `requireProjectName`). **Every** name this
   * provisioner creates leads with it: the manager Worker, its D1, both of its Workflows, each Secrets
   * Store entry, and the minted CF API token. All five namespaces are flat and account-wide, so this
   * segment is the only thing stopping a second project from provisioning over this one — and a Worker
   * deploy does not collide, it overwrites.
   */
  project: string;
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
  readonly #account: ConfirmedAccount;
  readonly #project: string;
  readonly #storeId: string;
  readonly #deploy: DeployManager;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSecretsProvisionerOptions) {
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
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
    const entry = managerCfApiTokenSecretName(this.#project);
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(entry)) return;
    const minted = await this.#cf
      .accountTokens()
      .rollToken(managerCfApiTokenName(this.#project), managerTokenPermissions(this.#account.accountId));
    await writeManagerCfApiToken(this.#cf, { storeId: this.#storeId, project: this.#project }, minted.value);
    // Never the minted value — just that the manager's own runtime credential was (re)written.
    await this.#audit({
      environment: "global",
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: entry,
      metadata: { name: entry, kind: "manager_token" },
    });
  }

  /**
   * Reuse the env's secrets D1 if it exists, otherwise create it.
   *
   * "Exists" means *this project's* database: the name is `<project>-<env>-secrets`. Unscoped, the
   * second project in an account would find the first's database by name and adopt it — two projects
   * sharing one secrets store, each able to read and overwrite the other's rows.
   *
   * And "exists" also means *an account this project claims* (#378). An empty listing from an account
   * nothing vouches for is not the absence this reads it as, and creating on it stands a live secrets
   * database up in somebody else's account.
   */
  async ensureDatabase(env: ManagedEnvironment): Promise<{ databaseId: string }> {
    const name = managerWorkerName(this.#project, env);
    const existing = await findOnConfirmedAccount({
      ...this.#account,
      what: `the ${name} database`,
      find: () => this.#cf.d1Provisioner().findDatabaseByName(name),
    });
    const db = existing ?? (await this.#cf.d1Provisioner().createDatabase(name));
    return { databaseId: db.uuid };
  }

  /**
   * Mint the env's master key only if absent — replacing it would orphan every stored secret.
   *
   * The entry name is project-scoped, and that is what makes "absent" mean *this project's* key is
   * absent. Under the old flat name, a second project provisioning into the same account would find
   * the first project's key already there, skip the mint, and encrypt its own rows under a key it does
   * not own — silently coupling two projects until one of them tears down and orphans both.
   */
  async ensureMasterKey(env: ManagedEnvironment): Promise<{ storeId: string }> {
    const name = masterKeySecretName(this.#project, env);
    const store = this.#cf.secrets(this.#storeId);
    if (!(await store.exists(name))) {
      await store.putSecret(name, JSON.stringify(await initialMasterKeyConfig()));
      await this.#audit({
        environment: env,
        action: "secrets/set",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: name,
        metadata: { name, kind: "master_key" },
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
 * one entry per project, written once and bound the same way by every one of that project's managers —
 * so this is idempotent and re-runnable: `putSecret` upserts, and a re-deploy rewrites the same entry.
 */
export async function writeManagerCfApiToken(
  cf: CloudflareClients,
  target: { storeId: string; project: string },
  apiToken: string,
): Promise<void> {
  await cf
    .secrets(target.storeId)
    .putSecret(managerCfApiTokenSecretName(target.project), encodeVersionedValue(initialVersionedValue(apiToken)));
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
export function buildManagerDeploy(options: { accountId: string; apiToken: string; project: string }): DeployManager {
  const { accountId, apiToken, project } = options;
  return async (env, resolved) => {
    const dir = managerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as ManagerWranglerTemplate;
    const config = resolveManagerConfig(template, { env, accountId, project, ...resolved });
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
  /**
   * The project name (root `pithy.config.ts` `name`, via `requireProjectName`). Teardown recomputes
   * every name it deletes, so this must be the same value provisioning used — a guessed one would
   * either match nothing (a silent leak) or, worse, match another project's entries.
   */
  project: string;
  /** The CF Secrets Store id holding the per-env master keys. */
  storeId: string;
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
 * The live {@link SecretsDeprovisioner} — removes each environment's manager worker, (optionally) its
 * master key, and its secrets D1, all through `@pithy-sh/cloudflare`. Every step is guarded so a
 * missing resource is a no-op: teardown is idempotent and safe to re-run. The integration suite
 * exercises the full provision → teardown round trip.
 */
export class CloudflareSecretsDeprovisioner implements SecretsDeprovisioner {
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #storeId: string;
  readonly #account: ConfirmedAccount;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSecretsDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#storeId = options.storeId;
    this.#account = options.account;
    this.#audit = options.audit ?? (async () => {});
  }

  /**
   * Delete the env's manager worker if it is deployed. Guarded, so teardown is idempotent — which is
   * also why `project` must be the value provisioning used: a mismatch finds nothing, deletes nothing,
   * and exits 0 while the real manager keeps running.
   *
   * A wrong *account* has the same three consequences and had no guard at all, so the lookup goes
   * through `findOnConfirmedAccount` (#378): an empty listing is only an absence once something says
   * whose account answered.
   */
  async deleteManager(env: ManagedEnvironment): Promise<void> {
    const name = managerWorkerName(this.#project, env);
    if (
      await findOnConfirmedAccount({
        ...this.#account,
        what: `the ${name} Worker`,
        find: () => this.#cf.workers().getWorker(name),
      })
    ) {
      await this.#cf.workers().deleteWorker(name);
    }
  }

  /**
   * Delete the env's master key if it is present — destructive, called only on a full destroy. The
   * name is project-scoped, so this can only ever reach this project's key: another project's key in
   * the same account-wide store is a different entry and is left readable.
   */
  async deleteMasterKey(env: ManagedEnvironment): Promise<void> {
    const name = masterKeySecretName(this.#project, env);
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(name)) {
      await store.deleteSecret(name);
      // Deleting a master key orphans every secret it encrypted — this is the destructive step.
      await this.#audit({
        environment: env,
        action: "secrets/removed",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: name,
        metadata: { name, kind: "master_key" },
      });
    }
  }

  /** Delete the env's secrets D1 if it exists. Project-scoped by name, like the manager above. */
  async deleteDatabase(env: ManagedEnvironment): Promise<void> {
    const db = await this.#cf.d1Provisioner().findDatabaseByName(managerWorkerName(this.#project, env));
    if (db) {
      await this.#cf.d1Provisioner().deleteDatabase(db.uuid);
    }
  }

  /**
   * Remove this project's manager token entirely — the inverse of `ensureManagerToken`. Delete the
   * minted account token from Cloudflare (every same-named token, so a re-minted duplicate is swept
   * too), then its Secrets Store entry. Both guarded: a missing token or entry is a no-op, so teardown
   * is idempotent.
   *
   * `deleteTokensByName` is a name sweep over the whole account, so the project scope on the name is
   * the containment: unscoped, one project's `pithy secrets deprovision` would revoke every other
   * project's manager credential in the account and break all of their rotations at once.
   */
  async deleteManagerToken(): Promise<void> {
    await this.#cf.accountTokens().deleteTokensByName(managerCfApiTokenName(this.#project));
    const entry = managerCfApiTokenSecretName(this.#project);
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(entry)) {
      await store.deleteSecret(entry);
      await this.#audit({
        environment: "global",
        action: "secrets/removed",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: entry,
        metadata: { name: entry, kind: "manager_token" },
      });
    }
  }
}
