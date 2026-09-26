// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { decodeVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { secretsRotateWorkflowName, secretsWriteWorkflowName } from "@pithy-sh/secrets/src/manager/dispatcher";
import {
  managerCfApiTokenName,
  managerCfApiTokenSecretName,
  masterKeySecretName,
} from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import {
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
  type CloudflareSecretsProvisionerOptions,
  managerTokenPermissions,
  writeManagerCfApiToken,
} from "./secretsProvisioner";

/**
 * A D1 with no tables — what a never-migrated database answers. The teardown counts retained rows before it
 * deletes (#591); these fakes are about names and audits, so there is nothing to count.
 */
const EMPTY_D1 = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

/** A fake CloudflareClients exposing only the methods the (de)provisioner touches, with spies. */
function fakeCf() {
  const findDatabaseByName = vi.fn();
  const createDatabase = vi.fn();
  const deleteDatabase = vi.fn();
  const exists = vi.fn();
  const putSecret = vi.fn();
  const createSecretIfAbsent = vi.fn(async () => "created");
  const deleteSecret = vi.fn();
  const getWorker = vi.fn();
  const deleteWorker = vi.fn();
  const accountSubdomain = vi.fn();
  const rollTokenKeepingPolicies = vi.fn();
  const deleteTokensByName = vi.fn();
  const cf = {
    d1Provisioner: () => ({ findDatabaseByName, createDatabase, deleteDatabase }),
    secrets: () => ({ exists, putSecret, createSecretIfAbsent, deleteSecret }),
    workers: () => ({ getWorker, deleteWorker, accountSubdomain }),
    accountTokens: () => ({ rollTokenKeepingPolicies, deleteTokensByName }),
    d1: () => EMPTY_D1,
  } as unknown as CloudflareClients;
  return {
    cf,
    findDatabaseByName,
    createDatabase,
    deleteDatabase,
    exists,
    putSecret,
    createSecretIfAbsent,
    deleteSecret,
    getWorker,
    deleteWorker,
    accountSubdomain,
    rollTokenKeepingPolicies,
    deleteTokensByName,
  };
}

/** The project every provisioner in this suite is scoped to, unless a test names another. */
const PROJECT = "acme";

/** Standard provisioner options for a fake `cf`; override `deploy` where a test needs to spy on it. */
function provisionerOptions(
  cf: CloudflareClients,
  deploy: CloudflareSecretsProvisionerOptions["deploy"] = async () => {},
  project: string = PROJECT,
): CloudflareSecretsProvisionerOptions {
  return {
    cf,
    account: { accountId: "acct-1", confirmation: "pinned" },
    project,
    storeId: "store-1",
    deploy,
    // Every value a test mints is live unless the test says otherwise: never a call to the real verify endpoint.
    honors: async () => true,
  };
}

describe("masterKeySecretName", () => {
  test("scopes the master-key entry to the project and the environment", () => {
    expect(masterKeySecretName(PROJECT, "staging")).toBe("acme-staging-secrets-encryption-keys");
    expect(masterKeySecretName(PROJECT, "prod")).toBe("acme-prod-secrets-encryption-keys");
  });
});

describe("CloudflareSecretsProvisioner", () => {
  test("preflight passes when the account has a workers.dev subdomain", async () => {
    const { cf, accountSubdomain } = fakeCf();
    accountSubdomain.mockResolvedValue("acme");
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await expect(provisioner.preflight()).resolves.toBeUndefined();
  });

  test("preflight throws a clear error when no subdomain is registered", async () => {
    const { cf, accountSubdomain } = fakeCf();
    accountSubdomain.mockResolvedValue(null);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await expect(provisioner.preflight()).rejects.toThrow(/workers\.dev subdomain/);
  });

  test("ensureDatabase creates the env's database when it doesn't exist", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue(null);
    createDatabase.mockResolvedValue({ uuid: "new-id", name: "acme-staging-secrets" });
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    expect(await provisioner.ensureDatabase("staging")).toEqual({ databaseId: "new-id" });
    expect(createDatabase).toHaveBeenCalledWith("acme-staging-secrets");
  });

  test("ensureDatabase reuses an existing database (idempotent)", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue({ uuid: "existing-id", name: "acme-staging-secrets" });
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    expect(await provisioner.ensureDatabase("staging")).toEqual({ databaseId: "existing-id" });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  test("ensureMasterKey mints the env key only when absent, and never by overwriting", async () => {
    const { cf, exists, putSecret, createSecretIfAbsent } = fakeCf();
    exists.mockResolvedValue(false);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    expect(await provisioner.ensureMasterKey("prod")).toEqual({ storeId: "store-1" });
    expect(createSecretIfAbsent).toHaveBeenCalledWith(
      masterKeySecretName(PROJECT, "prod"),
      expect.stringContaining("currentVersion"),
    );
    expect(putSecret).not.toHaveBeenCalled();
  });

  test("ensureMasterKey leaves an existing key untouched", async () => {
    const { cf, exists, putSecret, createSecretIfAbsent } = fakeCf();
    exists.mockResolvedValue(true);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await provisioner.ensureMasterKey("staging");
    expect(putSecret).not.toHaveBeenCalled();
    expect(createSecretIfAbsent).not.toHaveBeenCalled();
  });

  /**
   * **A feature's own key, and no token (#643).** The same provisioner, handed a feature, names the feature's own
   * master-key entry — and refuses to mint a manager token at all, because a feature's manager holds none: the
   * token can write every entry in the account's one Secrets Store, production's key included.
   */
  test("for a feature, creates the feature's own master key and refuses to mint a token", async () => {
    const feature = { project: PROJECT, issue: "643", slug: "feature-address" };
    const { cf, exists, putSecret, createSecretIfAbsent, rollTokenKeepingPolicies } = fakeCf();
    exists.mockResolvedValue(false);
    const provisioner = new CloudflareSecretsProvisioner({ ...provisionerOptions(cf), feature });

    await provisioner.ensureMasterKey("feature");
    await expect(provisioner.ensureManagerToken()).rejects.toThrow(/holds no Cloudflare API token/);

    expect(createSecretIfAbsent).toHaveBeenCalledWith(
      `${PROJECT}-f643-feature-address--secrets-encryption-keys`,
      expect.stringContaining("currentVersion"),
    );
    expect(rollTokenKeepingPolicies).not.toHaveBeenCalled();
    expect(putSecret).not.toHaveBeenCalled();
  });

  test("deployManager delegates to the injected deploy step", async () => {
    const { cf } = fakeCf();
    const deploy = vi.fn();
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf, deploy));

    await provisioner.deployManager("staging", { databaseId: "d1", storeId: "store-1" });
    expect(deploy).toHaveBeenCalledWith("staging", { databaseId: "d1", storeId: "store-1" });
  });

  test("ensureManagerToken mints a scoped token and writes it when the store entry is absent", async () => {
    const { cf, exists, rollTokenKeepingPolicies, putSecret } = fakeCf();
    exists.mockResolvedValue(false);
    rollTokenKeepingPolicies.mockResolvedValue({ id: "tk-1", value: "minted-token" });
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await provisioner.ensureManagerToken();

    expect(rollTokenKeepingPolicies).toHaveBeenCalledWith(
      managerCfApiTokenName(PROJECT),
      await managerTokenPermissions("acct-1"),
    );
    const [name, value] = putSecret.mock.calls[0] ?? [];
    expect(name).toBe(managerCfApiTokenSecretName(PROJECT));
    expect(JSON.parse(value)).toEqual({ currentVersion: "1", versions: { "1": "minted-token" } });
  });

  test("ensureManagerToken reuses the stored token (no mint) when the entry already exists", async () => {
    const { cf, exists, rollTokenKeepingPolicies, putSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await provisioner.ensureManagerToken();

    expect(rollTokenKeepingPolicies).not.toHaveBeenCalled();
    expect(putSecret).not.toHaveBeenCalled();
  });

  test("ensureManagerToken audits secrets/set without the token value when it mints one", async () => {
    const { cf, exists, rollTokenKeepingPolicies } = fakeCf();
    exists.mockResolvedValue(false);
    rollTokenKeepingPolicies.mockResolvedValue({ id: "tk-1", value: "minted-token" });
    const events: CliAuditEvent[] = [];
    const provisioner = new CloudflareSecretsProvisioner({
      ...provisionerOptions(cf),
      audit: async (event) => void events.push(event),
    });

    await provisioner.ensureManagerToken();

    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/set",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        metadata: { name: managerCfApiTokenSecretName(PROJECT), kind: "manager_token" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("minted-token");
  });

  test("ensureManagerToken records nothing when the token is reused", async () => {
    const { cf, exists } = fakeCf();
    exists.mockResolvedValue(true);
    const events: CliAuditEvent[] = [];
    const provisioner = new CloudflareSecretsProvisioner({
      ...provisionerOptions(cf),
      audit: async (event) => void events.push(event),
    });

    await provisioner.ensureManagerToken();
    expect(events).toEqual([]);
  });

  test("ensureMasterKey audits secrets/set only when it actually mints a new key", async () => {
    const { cf, exists } = fakeCf();
    exists.mockResolvedValue(false);
    const events: CliAuditEvent[] = [];
    const provisioner = new CloudflareSecretsProvisioner({
      ...provisionerOptions(cf),
      audit: async (event) => void events.push(event),
    });

    await provisioner.ensureMasterKey("prod");
    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/set",
        severity: "warning",
        environment: "prod",
        metadata: { name: masterKeySecretName(PROJECT, "prod"), kind: "master_key" },
      }),
    ]);

    events.length = 0;
    exists.mockResolvedValue(true);
    await provisioner.ensureMasterKey("prod");
    expect(events).toEqual([]);
  });
});

describe("two projects sharing one Cloudflare account", () => {
  /**
   * A fake `cf` over one Cloudflare account: a single Secrets Store, a single D1 namespace, and a
   * single Worker namespace, each one flat map keyed by name — exactly the real thing. There is one of
   * each per account, so this is the arrangement the naming has to survive.
   */
  function sharedAccount() {
    const store = new Map<string, string>();
    const deletedTokenNames: string[] = [];
    /** name → uuid, the account's one D1 namespace. */
    const databases = new Map<string, string>();
    /** script name → owning project. `wrangler deploy` upserts, so a repeated name is a replacement. */
    const deployedWorkers = new Map<string, string>();
    const cf = {
      secrets: () => ({
        exists: async (name: string) => store.has(name),
        putSecret: async (name: string, value: string) => void store.set(name, value),
        createSecretIfAbsent: async (name: string, value: string) => {
          if (store.has(name)) return "present";
          store.set(name, value);
          return "created";
        },
        deleteSecret: async (name: string) => void store.delete(name),
      }),
      accountTokens: () => ({
        rollTokenKeepingPolicies: async (name: string) => ({ id: `tk-${name}`, value: `value-${name}` }),
        deleteTokensByName: async (name: string) => {
          deletedTokenNames.push(name);
          return 1;
        },
      }),
      d1Provisioner: () => ({
        findDatabaseByName: async (name: string) => {
          const uuid = databases.get(name);
          return uuid ? { uuid, name } : null;
        },
        createDatabase: async (name: string) => {
          const uuid = `db-${databases.size + 1}`;
          databases.set(name, uuid);
          return { uuid, name };
        },
        deleteDatabase: async (uuid: string) => {
          for (const [name, id] of databases) if (id === uuid) databases.delete(name);
        },
      }),
      workers: () => ({
        getWorker: async (name: string) => (deployedWorkers.has(name) ? { id: name } : null),
        deleteWorker: async (name: string) => void deployedWorkers.delete(name),
      }),
      d1: () => EMPTY_D1,
    } as unknown as CloudflareClients;
    return { cf, store, deletedTokenNames, databases, deployedWorkers };
  }

  test("each project gets its own manager Worker, D1, and Workflows — no name either could overwrite", async () => {
    // The failure this whole rename exists to kill. A Worker script name is account-scoped and
    // `wrangler deploy` upserts, so when the manager was `pithy-secrets-<env>` the second project's
    // `pithy secrets provision` did not collide with the first — it *replaced* the first project's
    // running manager, repointed it at the second project's D1, and left the first project's writes
    // and rotations operating on resources it does not own. The D1 was the same one string.
    const { cf, databases, deployedWorkers } = sharedAccount();

    for (const project of ["acme", "globex"]) {
      // The deploy step is injected (wrangler is not in a unit test), so it stands in for the real one:
      // it registers the script under the same name `resolveManagerConfig` writes into the config.
      const deploy = async (env: ManagedEnvironment) =>
        void deployedWorkers.set(managerWorkerName(project, env), project);
      const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf, deploy, project));
      const { databaseId } = await provisioner.ensureDatabase("prod");
      await provisioner.deployManager("prod", { databaseId, storeId: "store-1" });
    }

    // Two databases and two managers, not one of each adopted twice.
    expect([...databases.keys()]).toEqual(["acme-prod-secrets", "globex-prod-secrets"]);
    expect([...deployedWorkers.keys()]).toEqual(["acme-prod-secrets", "globex-prod-secrets"]);
    // And the Workflows each manager hosts — the write one is what that project's CLI dispatches to.
    expect(secretsWriteWorkflowName("acme", "prod")).toBe("acme-prod-secrets-write");
    expect(secretsWriteWorkflowName("globex", "prod")).toBe("globex-prod-secrets-write");
    expect(secretsRotateWorkflowName("acme", "prod")).not.toBe(secretsRotateWorkflowName("globex", "prod"));
  });

  test("one project's teardown leaves the other's manager and database running", async () => {
    const { cf, databases, deployedWorkers } = sharedAccount();
    for (const project of ["acme", "globex"]) {
      await new CloudflareSecretsProvisioner(provisionerOptions(cf, async () => {}, project)).ensureDatabase("prod");
      deployedWorkers.set(managerWorkerName(project, "prod"), project);
    }

    // Every delete is `if exists`-guarded, so the name is the whole containment: acme's teardown must
    // recompute acme's names and no others, or it silently exits 0 having deleted globex's manager.
    const teardown = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: "acme",
      storeId: "store-1",
    });
    await teardown.deleteManager("prod");
    await teardown.deleteDatabase("prod");

    expect([...deployedWorkers.keys()]).toEqual(["globex-prod-secrets"]);
    expect([...databases.keys()]).toEqual(["globex-prod-secrets"]);
  });

  test("each project mints its own master key — neither adopts the other's", async () => {
    const { cf, store } = sharedAccount();
    await new CloudflareSecretsProvisioner(provisionerOptions(cf, async () => {}, "acme")).ensureMasterKey("prod");
    await new CloudflareSecretsProvisioner(provisionerOptions(cf, async () => {}, "globex")).ensureMasterKey("prod");

    const acmeKey = store.get(masterKeySecretName("acme", "prod"));
    const globexKey = store.get(masterKeySecretName("globex", "prod"));
    expect(acmeKey).toBeDefined();
    expect(globexKey).toBeDefined();
    // Distinct keys, not one adopted twice. Sharing a key would couple two projects' ciphertexts and
    // make either project's teardown orphan both stores.
    expect(acmeKey).not.toBe(globexKey);
    expect(store.size).toBe(2);
  });

  test("one project's teardown leaves the other's key readable and its token alive", async () => {
    const { cf, store, deletedTokenNames } = sharedAccount();
    for (const project of ["acme", "globex"]) {
      const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf, async () => {}, project));
      await provisioner.ensureMasterKey("prod");
      await provisioner.ensureManagerToken();
    }
    const globexKey = store.get(masterKeySecretName("globex", "prod"));

    const teardown = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: "acme",
      storeId: "store-1",
    });
    await teardown.deleteMasterKey("prod");
    await teardown.deleteManagerToken();

    expect(store.has(masterKeySecretName("acme", "prod"))).toBe(false);
    expect(store.get(masterKeySecretName("globex", "prod"))).toBe(globexKey);
    expect(store.has(managerCfApiTokenSecretName("globex"))).toBe(true);
    // `deleteTokensByName` sweeps every account token of a name; only acme's name was ever swept.
    expect(deletedTokenNames).toEqual([managerCfApiTokenName("acme")]);
    expect(deletedTokenNames).not.toContain(managerCfApiTokenName("globex"));
  });
});

describe("managerTokenPermissions", () => {
  test("scopes a Secrets Store Read + Write token to the account", async () => {
    expect(await managerTokenPermissions("acct-9")).toEqual([
      {
        permissionGroupNames: ["Secrets Store Read", "Secrets Store Write"],
        resources: { "com.cloudflare.api.account.acct-9": "*" },
      },
    ]);
  });
});

describe("writeManagerCfApiToken", () => {
  test("writes the global token entry as a one-entry uniform envelope", async () => {
    const { cf, putSecret } = fakeCf();

    await writeManagerCfApiToken(cf, { storeId: "store-1", project: PROJECT }, "scoped-cf-token");

    expect(putSecret).toHaveBeenCalledTimes(1);
    const [name, value] = putSecret.mock.calls[0] ?? [];
    expect(name).toBe(managerCfApiTokenSecretName(PROJECT));
    // The stored value is the uniform envelope, not the bare token.
    expect(JSON.parse(value)).toEqual({ currentVersion: "1", versions: { "1": "scoped-cf-token" } });
  });
});

describe("CloudflareSecretsDeprovisioner", () => {
  test("deleteManager removes the worker only when it is deployed", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue({ id: "acme-staging-secrets" });
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteManager("staging");
    expect(deleteWorker).toHaveBeenCalledWith("acme-staging-secrets");
  });

  test("deleteManager is a no-op when the worker is absent (idempotent)", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue(null);
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteManager("prod");
    expect(deleteWorker).not.toHaveBeenCalled();
  });

  test("deleteMasterKey removes the env-prefixed entry only when present", async () => {
    const { cf, exists, deleteSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteMasterKey("prod");
    expect(deleteSecret).toHaveBeenCalledWith(masterKeySecretName(PROJECT, "prod"));
  });

  test("deleteMasterKey is a no-op when the key is absent", async () => {
    const { cf, exists, deleteSecret } = fakeCf();
    exists.mockResolvedValue(false);
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteMasterKey("staging");
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  test("deleteMasterKey audits secrets/removed as a warning, only when a key was actually deleted", async () => {
    const { cf, exists } = fakeCf();
    exists.mockResolvedValue(true);
    const events: CliAuditEvent[] = [];
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
      audit: async (event) => void events.push(event),
    });

    await deprovisioner.deleteMasterKey("prod");
    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/removed",
        outcome: "success",
        severity: "warning",
        environment: "prod",
        metadata: { name: masterKeySecretName(PROJECT, "prod"), kind: "master_key" },
      }),
    ]);

    events.length = 0;
    exists.mockResolvedValue(false);
    await deprovisioner.deleteMasterKey("prod");
    expect(events).toEqual([]);
  });

  test("deleteDatabase deletes the env's database by id when found", async () => {
    const { cf, findDatabaseByName, deleteDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue({ uuid: "db-7", name: "acme-staging-secrets" });
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteDatabase("staging");
    expect(findDatabaseByName).toHaveBeenCalledWith("acme-staging-secrets");
    expect(deleteDatabase).toHaveBeenCalledWith("db-7");
  });

  test("deleteDatabase is a no-op when no database matches", async () => {
    const { cf, findDatabaseByName, deleteDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue(null);
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteDatabase("prod");
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  test("deleteManagerToken deletes the minted CF token and the store entry when present", async () => {
    const { cf, exists, deleteSecret, deleteTokensByName } = fakeCf();
    exists.mockResolvedValue(true);
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteManagerToken();
    expect(deleteTokensByName).toHaveBeenCalledWith(managerCfApiTokenName(PROJECT));
    expect(deleteSecret).toHaveBeenCalledWith(managerCfApiTokenSecretName(PROJECT));
  });

  test("deleteManagerToken still sweeps the CF token but skips the entry when absent (idempotent)", async () => {
    const { cf, exists, deleteSecret, deleteTokensByName } = fakeCf();
    exists.mockResolvedValue(false);
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
    });

    await deprovisioner.deleteManagerToken();
    expect(deleteTokensByName).toHaveBeenCalledWith(managerCfApiTokenName(PROJECT));
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  test("deleteManagerToken audits secrets/removed only when the store entry existed", async () => {
    const { cf, exists } = fakeCf();
    exists.mockResolvedValue(true);
    const events: CliAuditEvent[] = [];
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      storeId: "store-1",
      audit: async (event) => void events.push(event),
    });

    await deprovisioner.deleteManagerToken();
    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/removed",
        metadata: { name: managerCfApiTokenSecretName(PROJECT), kind: "manager_token" },
      }),
    ]);

    events.length = 0;
    exists.mockResolvedValue(false);
    await deprovisioner.deleteManagerToken();
    expect(events).toEqual([]);
  });
});

/**
 * The account a teardown deletes from must be one something claims (#378).
 *
 * `getWorker` answers "this account has no such script" and "you asked an account that is not yours"
 * with the same `null`, so a teardown pointed at a stranger's account used to delete nothing, audit
 * nothing, and exit 0 — a success message printed over a production Worker that is still running.
 *
 * The account id below is a literal, written here and nowhere else, and the plant that proves this gate
 * can fail is one word: turn `confirmation` back into something the guard ignores.
 */
describe("teardown refuses an unconfirmed account", () => {
  test("refuses instead of reading a miss as `already gone`", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue(null);
    const stranger = new CloudflareSecretsDeprovisioner({
      cf,
      project: PROJECT,
      storeId: "store-1",
      account: { accountId: "acct-stranger", confirmation: "ambient" },
    });

    await expect(stranger.deleteManager("prod")).rejects.toThrow(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(deleteWorker).not.toHaveBeenCalled();
    expect(getWorker).not.toHaveBeenCalled();
  });

  test("and the find-or-create refuses too — an empty listing would mint a real secrets D1", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue(null);
    const stranger = new CloudflareSecretsProvisioner({
      cf,
      account: { accountId: "acct-stranger", confirmation: "ambient" },
      project: PROJECT,
      storeId: "store-1",
      deploy: async () => {},
    });

    await expect(stranger.ensureDatabase("prod")).rejects.toThrow(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(createDatabase).not.toHaveBeenCalled();
  });
});

/**
 * **The manager-token race (#643, finding 2 of the review of 8858558c).** Two `pithy secrets provision` runs both
 * find the token entry absent and both roll the token, and each roll revokes the value before it. Before the fix
 * the write that landed last won, so the store could keep a value Cloudflare had already revoked, and a re-run,
 * seeing the entry, never repaired it. Now a run finishes only once the value it stored is still honored.
 */
describe("ensureManagerToken under a race", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Cloudflare as `rollTokenKeepingPolicies` sees it: mint when absent, roll the value in place when present. */
  function racingAccount() {
    const entries = new Map<string, string>();
    const tokens: { id: string; name: string; value: string }[] = [];
    let seq = 0;
    let puts = 0;
    const cf = {
      secrets: () => ({
        exists: async (name: string) => entries.has(name),
        // The first write is slow (a slow network leg), so the second run's write lands first.
        putSecret: async (name: string, value: string) => {
          puts += 1;
          if (puts === 1) await sleep(30);
          entries.set(name, value);
        },
      }),
      accountTokens: () => ({
        rollTokenKeepingPolicies: async (name: string) => {
          const existing = tokens.find((token) => token.name === name);
          seq += 1;
          if (!existing) {
            const token = { id: `tk${seq}`, name, value: `v${seq}` };
            tokens.push(token);
            return { ...token, status: "active" };
          }
          existing.value = `v${seq}`; // rolled in place: the old value stops working
          return { ...existing, status: "active" };
        },
      }),
    } as unknown as CloudflareClients;
    const honors = async (value: string) => tokens.some((token) => token.value === value);
    return { cf, entries, tokens, honors };
  }

  test("two concurrent runs leave the store holding the value Cloudflare honors", async () => {
    const account = racingAccount();
    const make = () => new CloudflareSecretsProvisioner({ ...provisionerOptions(account.cf), honors: account.honors });
    await Promise.all([make().ensureManagerToken(), make().ensureManagerToken()]);

    const stored = decodeVersionedValue(account.entries.get(managerCfApiTokenSecretName(PROJECT)) as string);
    expect(account.tokens).toHaveLength(1);
    expect(stored).toEqual({ currentVersion: "1", versions: { "1": account.tokens[0]?.value } });
  });

  test("a run that cannot keep a live value stops and says so, rather than rolling forever", async () => {
    const account = racingAccount();
    const provisioner = new CloudflareSecretsProvisioner({
      ...provisionerOptions(account.cf),
      honors: async () => false,
    });
    await expect(provisioner.ensureManagerToken()).rejects.toThrow(/kept being rolled by another run/);
  });
});
