// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import {
  MANAGER_CF_API_TOKEN_NAME,
  MANAGER_CF_API_TOKEN_SECRET_NAME,
  masterKeySecretName,
} from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import {
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
  type CloudflareSecretsProvisionerOptions,
  managerTokenPermissions,
  writeManagerCfApiToken,
} from "./secretsProvisioner";

/** A fake CloudflareClients exposing only the methods the (de)provisioner touches, with spies. */
function fakeCf() {
  const findDatabaseByName = vi.fn();
  const createDatabase = vi.fn();
  const deleteDatabase = vi.fn();
  const exists = vi.fn();
  const putSecret = vi.fn();
  const deleteSecret = vi.fn();
  const getWorker = vi.fn();
  const deleteWorker = vi.fn();
  const accountSubdomain = vi.fn();
  const rollToken = vi.fn();
  const deleteTokensByName = vi.fn();
  const cf = {
    d1Provisioner: () => ({ findDatabaseByName, createDatabase, deleteDatabase }),
    secrets: () => ({ exists, putSecret, deleteSecret }),
    workers: () => ({ getWorker, deleteWorker, accountSubdomain }),
    accountTokens: () => ({ rollToken, deleteTokensByName }),
    d1: () => ({}),
  } as unknown as CloudflareClients;
  return {
    cf,
    findDatabaseByName,
    createDatabase,
    deleteDatabase,
    exists,
    putSecret,
    deleteSecret,
    getWorker,
    deleteWorker,
    accountSubdomain,
    rollToken,
    deleteTokensByName,
  };
}

/** Standard provisioner options for a fake `cf`; override `deploy` where a test needs to spy on it. */
function provisionerOptions(
  cf: CloudflareClients,
  deploy: CloudflareSecretsProvisionerOptions["deploy"] = async () => {},
): CloudflareSecretsProvisionerOptions {
  return { cf, accountId: "acct-1", storeId: "store-1", deploy };
}

describe("masterKeySecretName", () => {
  test("env-prefixes the master-key entry name", () => {
    expect(masterKeySecretName("staging")).toBe("STAGING_SECRETS_ENCRYPTION_KEYS");
    expect(masterKeySecretName("production")).toBe("PRODUCTION_SECRETS_ENCRYPTION_KEYS");
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
    createDatabase.mockResolvedValue({ uuid: "new-id", name: "pithy-secrets-staging" });
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    expect(await provisioner.ensureDatabase("staging")).toEqual({ databaseId: "new-id" });
    expect(createDatabase).toHaveBeenCalledWith("pithy-secrets-staging");
  });

  test("ensureDatabase reuses an existing database (idempotent)", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue({ uuid: "existing-id", name: "pithy-secrets-staging" });
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    expect(await provisioner.ensureDatabase("staging")).toEqual({ databaseId: "existing-id" });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  test("ensureMasterKey mints the env key only when absent", async () => {
    const { cf, exists, putSecret } = fakeCf();
    exists.mockResolvedValue(false);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    expect(await provisioner.ensureMasterKey("production")).toEqual({ storeId: "store-1" });
    expect(putSecret).toHaveBeenCalledWith(
      "PRODUCTION_SECRETS_ENCRYPTION_KEYS",
      expect.stringContaining("currentVersion"),
    );
  });

  test("ensureMasterKey leaves an existing key untouched", async () => {
    const { cf, exists, putSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await provisioner.ensureMasterKey("staging");
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
    const { cf, exists, rollToken, putSecret } = fakeCf();
    exists.mockResolvedValue(false);
    rollToken.mockResolvedValue({ id: "tk-1", value: "minted-token" });
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await provisioner.ensureManagerToken();

    expect(rollToken).toHaveBeenCalledWith(MANAGER_CF_API_TOKEN_NAME, managerTokenPermissions("acct-1"));
    const [name, value] = putSecret.mock.calls[0] ?? [];
    expect(name).toBe(MANAGER_CF_API_TOKEN_SECRET_NAME);
    expect(JSON.parse(value)).toEqual({ currentVersion: "1", versions: { "1": "minted-token" } });
  });

  test("ensureManagerToken reuses the stored token (no mint) when the entry already exists", async () => {
    const { cf, exists, rollToken, putSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const provisioner = new CloudflareSecretsProvisioner(provisionerOptions(cf));

    await provisioner.ensureManagerToken();

    expect(rollToken).not.toHaveBeenCalled();
    expect(putSecret).not.toHaveBeenCalled();
  });

  test("ensureManagerToken audits secrets/set without the token value when it mints one", async () => {
    const { cf, exists, rollToken } = fakeCf();
    exists.mockResolvedValue(false);
    rollToken.mockResolvedValue({ id: "tk-1", value: "minted-token" });
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
        metadata: { name: MANAGER_CF_API_TOKEN_SECRET_NAME, kind: "manager_token" },
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

    await provisioner.ensureMasterKey("production");
    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/set",
        severity: "warning",
        metadata: { name: "PRODUCTION_SECRETS_ENCRYPTION_KEYS", kind: "master_key", env: "production" },
      }),
    ]);

    events.length = 0;
    exists.mockResolvedValue(true);
    await provisioner.ensureMasterKey("production");
    expect(events).toEqual([]);
  });
});

describe("managerTokenPermissions", () => {
  test("scopes a Secrets Store Read + Write token to the account", () => {
    expect(managerTokenPermissions("acct-9")).toEqual([
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

    await writeManagerCfApiToken(cf, "store-1", "scoped-cf-token");

    expect(putSecret).toHaveBeenCalledTimes(1);
    const [name, value] = putSecret.mock.calls[0] ?? [];
    expect(name).toBe(MANAGER_CF_API_TOKEN_SECRET_NAME);
    // The stored value is the uniform envelope, not the bare token.
    expect(JSON.parse(value)).toEqual({ currentVersion: "1", versions: { "1": "scoped-cf-token" } });
  });
});

describe("CloudflareSecretsDeprovisioner", () => {
  test("deleteManager removes the worker only when it is deployed", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue({ id: "pithy-secrets-staging" });
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteManager("staging");
    expect(deleteWorker).toHaveBeenCalledWith("pithy-secrets-staging");
  });

  test("deleteManager is a no-op when the worker is absent (idempotent)", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue(null);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteManager("production");
    expect(deleteWorker).not.toHaveBeenCalled();
  });

  test("deleteMasterKey removes the env-prefixed entry only when present", async () => {
    const { cf, exists, deleteSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteMasterKey("production");
    expect(deleteSecret).toHaveBeenCalledWith("PRODUCTION_SECRETS_ENCRYPTION_KEYS");
  });

  test("deleteMasterKey is a no-op when the key is absent", async () => {
    const { cf, exists, deleteSecret } = fakeCf();
    exists.mockResolvedValue(false);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteMasterKey("staging");
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  test("deleteMasterKey audits secrets/removed as a warning, only when a key was actually deleted", async () => {
    const { cf, exists } = fakeCf();
    exists.mockResolvedValue(true);
    const events: CliAuditEvent[] = [];
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      cf,
      storeId: "store-1",
      audit: async (event) => void events.push(event),
    });

    await deprovisioner.deleteMasterKey("production");
    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/removed",
        outcome: "success",
        severity: "warning",
        metadata: { name: "PRODUCTION_SECRETS_ENCRYPTION_KEYS", kind: "master_key", env: "production" },
      }),
    ]);

    events.length = 0;
    exists.mockResolvedValue(false);
    await deprovisioner.deleteMasterKey("production");
    expect(events).toEqual([]);
  });

  test("deleteDatabase deletes the env's database by id when found", async () => {
    const { cf, findDatabaseByName, deleteDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue({ uuid: "db-7", name: "pithy-secrets-staging" });
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteDatabase("staging");
    expect(findDatabaseByName).toHaveBeenCalledWith("pithy-secrets-staging");
    expect(deleteDatabase).toHaveBeenCalledWith("db-7");
  });

  test("deleteDatabase is a no-op when no database matches", async () => {
    const { cf, findDatabaseByName, deleteDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue(null);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteDatabase("production");
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  test("deleteManagerToken deletes the minted CF token and the store entry when present", async () => {
    const { cf, exists, deleteSecret, deleteTokensByName } = fakeCf();
    exists.mockResolvedValue(true);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteManagerToken();
    expect(deleteTokensByName).toHaveBeenCalledWith(MANAGER_CF_API_TOKEN_NAME);
    expect(deleteSecret).toHaveBeenCalledWith(MANAGER_CF_API_TOKEN_SECRET_NAME);
  });

  test("deleteManagerToken still sweeps the CF token but skips the entry when absent (idempotent)", async () => {
    const { cf, exists, deleteSecret, deleteTokensByName } = fakeCf();
    exists.mockResolvedValue(false);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteManagerToken();
    expect(deleteTokensByName).toHaveBeenCalledWith(MANAGER_CF_API_TOKEN_NAME);
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  test("deleteManagerToken audits secrets/removed only when the store entry existed", async () => {
    const { cf, exists } = fakeCf();
    exists.mockResolvedValue(true);
    const events: CliAuditEvent[] = [];
    const deprovisioner = new CloudflareSecretsDeprovisioner({
      cf,
      storeId: "store-1",
      audit: async (event) => void events.push(event),
    });

    await deprovisioner.deleteManagerToken();
    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/removed",
        metadata: { name: MANAGER_CF_API_TOKEN_SECRET_NAME, kind: "manager_token" },
      }),
    ]);

    events.length = 0;
    exists.mockResolvedValue(false);
    await deprovisioner.deleteManagerToken();
    expect(events).toEqual([]);
  });
});
