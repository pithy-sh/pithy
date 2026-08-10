// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { describe, expect, test, vi } from "vitest";
import { EncryptionConfig } from "../crypto/envelope";
import type { ManagedEnvironment } from "../scope";
import {
  type DeprovisionOptions,
  deprovisionSecrets,
  initialMasterKeyConfig,
  managerCfApiTokenName,
  managerCfApiTokenSecretName,
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
  async ensureManagerToken() {
    this.calls.push("token");
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
  test("mints the manager token first, then provisions both environments in order: db → key → migrate → deploy", async () => {
    const provisioner = new StubProvisioner();

    const result = await provisionSecrets(provisioner, DEFAULT_ENVIRONMENTS);

    expect(provisioner.calls).toEqual([
      "preflight",
      "token",
      "db:staging",
      "key:staging",
      "migrate:staging:d1-staging",
      "deploy:staging:d1-staging:store-staging",
      "db:prod",
      "key:prod",
      "migrate:prod:d1-prod",
      "deploy:prod:d1-prod:store-prod",
    ]);
    expect(result.perEnv).toEqual([
      { env: "staging", databaseId: "d1-staging", storeId: "store-staging" },
      { env: "prod", databaseId: "d1-prod", storeId: "store-prod" },
    ]);
  });

  test("gives every declared environment a master key, including one core never heard of", async () => {
    // #241's whole cost: `pithy migrate --env live` ran, `<project>-live-db` would have been created,
    // and this loop — over a closed enum — skipped `live`, so it got no master key and no manager.
    const provisioner = new StubProvisioner();

    const result = await provisionSecrets(provisioner, ["staging", "live"]);

    expect(provisioner.calls).toContain("key:live");
    expect(provisioner.calls).toContain("deploy:live:d1-live:store-live");
    expect(result.perEnv.map((entry) => entry.env)).toEqual(["staging", "live"]);
  });

  test("a failing preflight aborts before any resource is created", async () => {
    const provisioner = new StubProvisioner();
    provisioner.preflight = async () => {
      provisioner.calls.push("preflight");
      throw new Error("no workers.dev subdomain");
    };

    await expect(provisionSecrets(provisioner, DEFAULT_ENVIRONMENTS)).rejects.toThrow("no workers.dev subdomain");
    expect(provisioner.calls).toEqual(["preflight"]);
  });

  test("a manager-token mint failure aborts before any resource is created", async () => {
    const provisioner = new StubProvisioner();
    provisioner.ensureManagerToken = async () => {
      provisioner.calls.push("token");
      throw new Error("cannot mint account tokens");
    };

    await expect(provisionSecrets(provisioner, DEFAULT_ENVIRONMENTS)).rejects.toThrow("cannot mint account tokens");
    expect(provisioner.calls).toEqual(["preflight", "token"]);
  });
});

describe("initialMasterKeyConfig", () => {
  test("mints a valid one-version config with a 32-byte key", async () => {
    const config = await initialMasterKeyConfig(new Date("2026-01-01T00:00:00.000Z"));
    expect(EncryptionConfig.parse(config)).toMatchObject({
      currentVersion: "1",
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.keys(config.versions)).toEqual(["1"]);
    expect(atob(config.versions["1"] ?? "").length).toBe(32);
  });
});

describe("masterKeySecretName", () => {
  test("is <project>-<env>-secrets-encryption-keys", () => {
    expect(masterKeySecretName("acme", "staging")).toBe("acme-staging-secrets-encryption-keys");
    expect(masterKeySecretName("acme", "prod")).toBe("acme-prod-secrets-encryption-keys");
  });

  test("two projects in one account never resolve to the same entry", () => {
    // The account has one flat Secrets Store. If these collided, the second project to provision would
    // adopt the first's master key — and either project's teardown would orphan both stores.
    expect(masterKeySecretName("acme", "prod")).not.toBe(masterKeySecretName("globex", "prod"));
  });

  test("stays verbatim at the longest legal project name — a Secrets Store entry is not truncated at 63", () => {
    // Held to the Secrets Store's own ceiling through the naming facade, not to R2's 63. Truncation here
    // would hash the tail (`…-secrets-encryp-91c2e9`) and the manager's binding would name an entry the
    // rotation never writes back to.
    const longest = "a".repeat(MAX_PROJECT_NAME);
    expect(masterKeySecretName(longest, "staging")).toBe(`${longest}-staging-secrets-encryption-keys`);
  });

  test("refuses an environment this project scheme does not accept", () => {
    // The old spelling is the live hazard of the rename: a stale `production` composes a perfectly legal
    // name for an entry nothing binds, so it must fail loudly rather than resolve.
    expect(() => masterKeySecretName("acme", "production" as ManagedEnvironment)).toThrow(/prod/);
  });
});

describe("managerCfApiTokenSecretName", () => {
  test("puts the literal global in the environment slot — one entry per project, not per env", () => {
    expect(managerCfApiTokenSecretName("acme")).toBe("acme-global-secrets-manager-cf-api-token");
    expect(managerCfApiTokenSecretName("acme")).not.toBe(managerCfApiTokenSecretName("globex"));
  });

  test("stays verbatim at the longest legal project name", () => {
    const longest = "a".repeat(MAX_PROJECT_NAME);
    expect(managerCfApiTokenSecretName(longest)).toBe(`${longest}-global-secrets-manager-cf-api-token`);
  });
});

describe("managerCfApiTokenName", () => {
  test("is <project>-global-secrets-manager, distinct from the entry holding its value", () => {
    expect(managerCfApiTokenName("acme")).toBe("acme-global-secrets-manager");
    expect(managerCfApiTokenName("acme")).not.toBe(managerCfApiTokenSecretName("acme"));
  });

  test("two projects mint distinctly named tokens — teardown deletes by name, account-wide", () => {
    expect(managerCfApiTokenName("acme")).not.toBe(managerCfApiTokenName("globex"));
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
      deleteManagerToken: vi.fn(async () => {
        calls.push("token");
      }),
    };
  }

  test("keeps master keys by default — manager then database per env, then the shared token", async () => {
    const calls: string[] = [];
    await deprovisionSecrets(recordingDeprovisioner(calls), DEFAULT_ENVIRONMENTS);
    expect(calls).toEqual(["manager:staging", "db:staging", "manager:prod", "db:prod", "token"]);
  });

  test("deletes master keys only when asked", async () => {
    const calls: string[] = [];
    const options: DeprovisionOptions = { deleteKeys: true };
    await deprovisionSecrets(recordingDeprovisioner(calls), DEFAULT_ENVIRONMENTS, options);
    expect(calls).toEqual([
      "manager:staging",
      "key:staging",
      "db:staging",
      "manager:prod",
      "key:prod",
      "db:prod",
      "token",
    ]);
  });
});
