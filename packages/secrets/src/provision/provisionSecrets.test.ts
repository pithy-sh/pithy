import { describe, expect, test, vi } from "vitest";
import { EncryptionConfig } from "../crypto/envelope";
import type { ManagedEnvironment } from "../scope";
import {
  type DeprovisionOptions,
  deprovisionSecrets,
  initialMasterKeyConfig,
  masterKeySecretName,
  provisionSecrets,
  type SecretsDeprovisioner,
  type SecretsProvisioner,
} from "./provisionSecrets";

/** Records the call order so the test can assert the provisioning sequence. */
class StubProvisioner implements SecretsProvisioner {
  readonly calls: string[] = [];
  async preflight() {
    this.calls.push("preflight");
  }
  async ensureDatabase(env: ManagedEnvironment) {
    this.calls.push(`db:${env}`);
    return { databaseId: `d1-${env}` };
  }
  async ensureMasterKey(env: ManagedEnvironment) {
    this.calls.push(`key:${env}`);
    return { storeId: `store-${env}` };
  }
  async migrate(env: ManagedEnvironment, databaseId: string) {
    this.calls.push(`migrate:${env}:${databaseId}`);
  }
  async deployManager(env: ManagedEnvironment, resolved: { databaseId: string; storeId: string }) {
    this.calls.push(`deploy:${env}:${resolved.databaseId}:${resolved.storeId}`);
  }
}

describe("provisionSecrets", () => {
  test("provisions both environments in order: db → key → migrate → deploy", async () => {
    const provisioner = new StubProvisioner();

    const result = await provisionSecrets(provisioner);

    expect(provisioner.calls).toEqual([
      "preflight",
      "db:staging",
      "key:staging",
      "migrate:staging:d1-staging",
      "deploy:staging:d1-staging:store-staging",
      "db:production",
      "key:production",
      "migrate:production:d1-production",
      "deploy:production:d1-production:store-production",
    ]);
    expect(result.perEnv).toEqual([
      { env: "staging", databaseId: "d1-staging", storeId: "store-staging" },
      { env: "production", databaseId: "d1-production", storeId: "store-production" },
    ]);
  });

  test("a failing preflight aborts before any resource is created", async () => {
    const provisioner = new StubProvisioner();
    provisioner.preflight = async () => {
      provisioner.calls.push("preflight");
      throw new Error("no workers.dev subdomain");
    };

    await expect(provisionSecrets(provisioner)).rejects.toThrow("no workers.dev subdomain");
    expect(provisioner.calls).toEqual(["preflight"]);
  });
});

describe("initialMasterKeyConfig", () => {
  test("mints a valid one-version config with a 32-byte key", async () => {
    const config = await initialMasterKeyConfig(new Date("2026-01-01T00:00:00.000Z"));
    expect(EncryptionConfig.parse(config)).toMatchObject({
      currentVersion: 1,
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.keys(config.keys)).toEqual(["1"]);
    expect(atob(config.keys["1"] ?? "").length).toBe(32);
  });
});

describe("masterKeySecretName", () => {
  test("env-prefixes the shared-store entry name", () => {
    expect(masterKeySecretName("staging")).toBe("STAGING_SECRETS_ENCRYPTION_KEYS");
    expect(masterKeySecretName("production")).toBe("PRODUCTION_SECRETS_ENCRYPTION_KEYS");
  });
});

describe("deprovisionSecrets", () => {
  function recordingDeprovisioner(calls: string[]): SecretsDeprovisioner {
    return {
      deleteManager: vi.fn(async (env: ManagedEnvironment) => {
        calls.push(`manager:${env}`);
      }),
      deleteMasterKey: vi.fn(async (env: ManagedEnvironment) => {
        calls.push(`key:${env}`);
      }),
      deleteDatabase: vi.fn(async (env: ManagedEnvironment) => {
        calls.push(`db:${env}`);
      }),
    };
  }

  test("keeps master keys by default — manager then database, per env", async () => {
    const calls: string[] = [];
    await deprovisionSecrets(recordingDeprovisioner(calls));
    expect(calls).toEqual(["manager:staging", "db:staging", "manager:production", "db:production"]);
  });

  test("deletes master keys only when asked", async () => {
    const calls: string[] = [];
    const options: DeprovisionOptions = { deleteKeys: true };
    await deprovisionSecrets(recordingDeprovisioner(calls), options);
    expect(calls).toEqual([
      "manager:staging",
      "key:staging",
      "db:staging",
      "manager:production",
      "key:production",
      "db:production",
    ]);
  });
});
