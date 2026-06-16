import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import {
  MANAGER_CF_API_TOKEN_SECRET_NAME,
  masterKeySecretName,
} from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { describe, expect, test, vi } from "vitest";
import {
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
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
  const cf = {
    d1Provisioner: () => ({ findDatabaseByName, createDatabase, deleteDatabase }),
    secrets: () => ({ exists, putSecret, deleteSecret }),
    workers: () => ({ getWorker, deleteWorker, accountSubdomain }),
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
  };
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
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy: async () => {} });

    await expect(provisioner.preflight()).resolves.toBeUndefined();
  });

  test("preflight throws a clear error when no subdomain is registered", async () => {
    const { cf, accountSubdomain } = fakeCf();
    accountSubdomain.mockResolvedValue(null);
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy: async () => {} });

    await expect(provisioner.preflight()).rejects.toThrow(/workers\.dev subdomain/);
  });

  test("ensureDatabase creates the env's database when it doesn't exist", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue(null);
    createDatabase.mockResolvedValue({ uuid: "new-id", name: "pithy-secrets-staging" });
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy: async () => {} });

    expect(await provisioner.ensureDatabase("staging")).toEqual({ databaseId: "new-id" });
    expect(createDatabase).toHaveBeenCalledWith("pithy-secrets-staging");
  });

  test("ensureDatabase reuses an existing database (idempotent)", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    findDatabaseByName.mockResolvedValue({ uuid: "existing-id", name: "pithy-secrets-staging" });
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy: async () => {} });

    expect(await provisioner.ensureDatabase("staging")).toEqual({ databaseId: "existing-id" });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  test("ensureMasterKey mints the env key only when absent", async () => {
    const { cf, exists, putSecret } = fakeCf();
    exists.mockResolvedValue(false);
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy: async () => {} });

    expect(await provisioner.ensureMasterKey("production")).toEqual({ storeId: "store-1" });
    expect(putSecret).toHaveBeenCalledWith(
      "PRODUCTION_SECRETS_ENCRYPTION_KEYS",
      expect.stringContaining("currentVersion"),
    );
  });

  test("ensureMasterKey leaves an existing key untouched", async () => {
    const { cf, exists, putSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy: async () => {} });

    await provisioner.ensureMasterKey("staging");
    expect(putSecret).not.toHaveBeenCalled();
  });

  test("deployManager delegates to the injected deploy step", async () => {
    const { cf } = fakeCf();
    const deploy = vi.fn();
    const provisioner = new CloudflareSecretsProvisioner({ cf, storeId: "store-1", deploy });

    await provisioner.deployManager("staging", { databaseId: "d1", storeId: "store-1" });
    expect(deploy).toHaveBeenCalledWith("staging", { databaseId: "d1", storeId: "store-1" });
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

  test("deleteManagerToken removes the shared token entry when present", async () => {
    const { cf, exists, deleteSecret } = fakeCf();
    exists.mockResolvedValue(true);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteManagerToken();
    expect(deleteSecret).toHaveBeenCalledWith(MANAGER_CF_API_TOKEN_SECRET_NAME);
  });

  test("deleteManagerToken is a no-op when the token is absent (idempotent)", async () => {
    const { cf, exists, deleteSecret } = fakeCf();
    exists.mockResolvedValue(false);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId: "store-1" });

    await deprovisioner.deleteManagerToken();
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
