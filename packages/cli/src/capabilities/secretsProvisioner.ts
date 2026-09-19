// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { TokenPermission } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import type { PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import { InternalError, UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { RetainedBudget, type RetainedRows } from "@pithy-sh/core/src/migrations/retained";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { secretsTokenProfile } from "@pithy-sh/secrets/src/capability";
import { encodeVersionedValue, initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { secretsRetainedTables } from "@pithy-sh/secrets/src/data/tables";
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
import { kitSource } from "../project/kitSource";
import { deployHostWorker, kitPackageVersion } from "./hostDeploy";
import { countDatabaseRetained, deleteRetainedDatabase } from "./retainedDatabase";

/**
 * The secrets migration set, as provisioning runs it against each environment's D1 — and as teardown counts
 * it. It carries the capability's own `retained` declaration, because this process never constructs the
 * capability: without it the vault's tables are undeclared here, a count finds nothing, and a deletion
 * goes through (#591).
 */
export function secretsMigrationProvider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "secrets",
      namespace: "secrets",
      order: 100,
      migrations: { "0001_init": secrets_0001_init },
      retained: secretsRetainedTables,
    },
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
  /**
   * **The feature this provisions for, when it provisions for one (#643).** It creates the feature's own
   * master-key entry, and nothing else: a feature's manager holds no Cloudflare API token, so
   * {@link CloudflareSecretsProvisioner.ensureManagerToken} refuses a feature outright. Absent, the project's
   * declared environments are what it provisions, as it always was.
   */
  feature?: FeatureIdentity;
  /**
   * **Does Cloudflare honor this token value now?** — `GET /accounts/{id}/tokens/verify` made *with* the value,
   * in a real run. The seam `ensureManagerToken` settles a race with (#643): a run is finished only once the value
   * it stored is still the live one. Resolves `false` for a revoked value, and throws for anything else, since an
   * outage is not an answer.
   */
  honors?: (value: string) => Promise<boolean>;
}

/**
 * The default {@link CloudflareSecretsProvisionerOptions.honors}: verify the value as its own bearer. A 401 or
 * 403 is Cloudflare saying the value is not live; every other failure is thrown, never read as either answer.
 *
 * **Asked more than once before it is believed.** A value minted or rolled a moment ago may not verify yet, and
 * reading that as "revoked" would roll the token again, revoking the value that was about to work. So a `false`
 * is asked again, after a second, two and four; only a value still refused after all of them is revoked.
 */
async function tokenIsHonored(accountId: string, value: string): Promise<boolean> {
  const { CloudflareAccountTokensManager } = await import("@pithy-sh/cloudflare/src/tokens/accountTokensManager");
  const { statusOf } = await import("@pithy-sh/cloudflare/src/client/errors");
  const manager = new CloudflareAccountTokensManager({ accountId, apiToken: value });
  for (const wait of [0, 1_000, 2_000, 4_000]) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      if ((await manager.verifyToken()).status === "active") return true;
    } catch (error) {
      const status = statusOf((error as { cause?: unknown }).cause ?? error);
      if (status !== 401 && status !== 403) throw error;
    }
  }
  return false;
}

/** How many times one run rolls the manager token before it stops: each extra one means another run rolled too. */
const MAX_TOKEN_ROLLS = 5;

/**
 * The least-privilege permissions the manager's minted token carries: Secrets Store Read + Write,
 * scoped to this account. Derived from the predefined `secrets` token profile — the one source of the
 * standard defaults each package needs (`pithy token`) — so the manager's scope and the profile never
 * drift. The manager's only live-CF use is the rotation config write-back; its D1 work runs through
 * the `SECRETS` binding, not this token — so nothing wider is granted.
 */
export async function managerTokenPermissions(accountId: string): Promise<TokenPermission[]> {
  // Loaded here rather than at module scope. `tokens/profiles` is a pure policy module, but it reaches
  // the Cloudflare SDK through one value import of `accountResource`, which puts ~355 ms on the static
  // graph of `pithy add`, `pithy provision` and `pithy secrets` — to print their flag lists (#482).
  // The CLI's copy. `@pithy-sh/cloudflare` is not a capability an adopter installs, and this computes
  // the permission list for a token **the CLI mints** — that policy is the CLI's, not the project's (#533).
  const { permissionsForKeys } = await import("@pithy-sh/cloudflare/src/tokens/profiles");
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
  readonly #feature: FeatureIdentity | undefined;
  readonly #honors: (value: string) => Promise<boolean>;

  constructor(options: CloudflareSecretsProvisionerOptions) {
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
    this.#storeId = options.storeId;
    this.#deploy = options.deploy;
    this.#audit = options.audit ?? (async () => {});
    this.#feature = options.feature;
    this.#honors = options.honors ?? ((value) => tokenIsHonored(options.account.accountId, value));
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
   *
   * **Never check-then-overwrite (#643).** Two runs that both find the entry absent both roll, and each roll
   * revokes the value before it. Whichever write landed last used to win, so the store could keep a value
   * Cloudflare had already revoked, and nothing repaired it. Now a run is finished only when the value it stored
   * is still honored *after* its write: if another run rolled since, this one rolls and writes again. The last
   * write is then always by a run that rolled last, so every run that returns leaves the live value stored.
   *
   * **Never for a feature.** A feature's manager holds no token (#643), so this refuses one rather than mint it.
   */
  async ensureManagerToken(): Promise<void> {
    if (this.#feature) {
      throw new InternalError({
        message: "A feature's secrets manager holds no Cloudflare API token.",
        detail: `ensureManagerToken called for feature ${this.#feature.project}-f${this.#feature.issue}-${this.#feature.slug}`,
      });
    }
    const entry = managerCfApiTokenSecretName(this.#project);
    const store = this.#cf.secrets(this.#storeId);
    if (await store.exists(entry)) return;
    for (let roll = 1; ; roll += 1) {
      const minted = await this.#cf
        .accountTokens()
        .rollToken(managerCfApiTokenName(this.#project), await managerTokenPermissions(this.#account.accountId));
      await writeManagerCfApiToken(this.#cf, { storeId: this.#storeId, project: this.#project }, minted.value);
      if (await this.#honors(minted.value)) break;
      if (roll >= MAX_TOKEN_ROLLS) {
        throw new UpstreamError({
          message: "The secrets manager's token kept being rolled by another run.",
          action: "Wait for the other pithy secrets provision to finish, then run this again.",
          detail: `${managerCfApiTokenName(this.#project)}: rolled ${roll} times, and each value was revoked before this run could keep it`,
        });
      }
    }
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
    const name = masterKeySecretName(this.#project, env, this.#feature);
    const store = this.#cf.secrets(this.#storeId);
    // Asked before any key material is generated, so a re-run makes none; created only if still absent, so two
    // runs racing never write one key over the other (#643). Which run created it is never what anything below
    // depends on: the manager seals every row, under whatever key the store holds.
    if (
      !(await store.exists(name)) &&
      (await store.createSecretIfAbsent(name, JSON.stringify(await initialMasterKeyConfig()))) !== "present"
    ) {
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
function managerDir(projectDir: string): string {
  // Resolve through the package so it works installed (node_modules) or in the workspace; the
  // `./src/*` export maps `worker` → `src/manager/worker.ts`, whose directory holds wrangler.jsonc.
  return dirname(kitSource(projectDir, "@pithy-sh/secrets/src/manager/worker"));
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
export function buildManagerDeploy(options: {
  accountId: string;
  apiToken: string;
  project: string;
  /** The project root the manager worker is resolved from — the adopter's copy, not the CLI's (#533). */
  projectDir: string;
  /** How the deploy gate reads the manager Worker's stamp back off the account (#537). */
  cf: CloudflareClients;
}): DeployManager {
  const { accountId, apiToken, cf, project, projectDir } = options;
  return async (env, resolved) => {
    const dir = managerDir(projectDir);
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as ManagerWranglerTemplate;
    const config = resolveManagerConfig(template, { env, accountId, project, ...resolved });

    // **The gate, inherited rather than opted into (#537).** `deployHostWorker` stamps the resolved
    // config with this package's version and a hash of the config itself, compares that against what
    // the deployed Worker carries, and ships only when they differ. A first provision has no stamp, so
    // it deploys. Anything it cannot establish — no Worker, no stamp, an unreachable account — deploys
    // too: a false redeploy costs seconds, a false skip is silent.
    await deployHostWorker({
      capability: "secrets",
      pkg: "@pithy-sh/secrets",
      version: await kitPackageVersion(projectDir, "@pithy-sh/secrets"),
      config,
      dir,
      env,
      readVars: (script) => cf.workers().getWorkerVars(script),
      account: { accountId, apiToken },
    });
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
  /**
   * How many vault rows this run may destroy — the operator's `--destroy-retained` number, spent as each
   * database is deleted (#591). Defaults to agreeing to nothing, so a caller that never asked destroys no
   * stored secret: an empty vault deletes, a full one refuses.
   */
  budget?: RetainedBudget;
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
  readonly #budget: RetainedBudget;

  constructor(options: CloudflareSecretsDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#storeId = options.storeId;
    this.#account = options.account;
    this.#audit = options.audit ?? (async () => {});
    this.#budget = options.budget ?? new RetainedBudget(undefined);
  }

  /** The env's secrets D1, when it exists, with the migration set that declares its retained tables. */
  async #database(env: ManagedEnvironment) {
    const name = managerWorkerName(this.#project, env);
    const db = await findOnConfirmedAccount({
      ...this.#account,
      what: `the ${name} database`,
      find: () => this.#cf.d1Provisioner().findDatabaseByName(name),
    });
    return db ? { cf: this.#cf, databaseId: db.uuid, name, provider: secretsMigrationProvider() } : null;
  }

  /** The vault's retained rows, named by the database — empty when the database is absent. Read-only. */
  async countRetained(env: ManagedEnvironment): Promise<RetainedRows[]> {
    const database = await this.#database(env);
    return database ? countDatabaseRetained(database) : [];
  }

  /** Whether the env's manager Worker is deployed — settled on a confirmed account, like every lookup here. */
  async hasManager(env: ManagedEnvironment): Promise<boolean> {
    const name = managerWorkerName(this.#project, env);
    return Boolean(
      await findOnConfirmedAccount({
        ...this.#account,
        what: `the ${name} Worker`,
        find: () => this.#cf.workers().getWorker(name),
      }),
    );
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

  /**
   * Delete the env's secrets D1 if it exists. Project-scoped by name, like the manager above — and refused
   * while the vault holds more rows than this run's budget agreed to destroy (#591), counted at the delete.
   */
  async deleteDatabase(env: ManagedEnvironment): Promise<void> {
    const database = await this.#database(env);
    if (database) await deleteRetainedDatabase(database, this.#budget);
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
