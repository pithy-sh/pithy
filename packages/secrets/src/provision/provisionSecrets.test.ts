// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { RetainedRows } from "@pithy-sh/core/src/migrations/retained";
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

  /**
   * **The exclusion, pinned.** Six capability provisioning commands stopped spanning every declared
   * environment: one whose app `DB` binding has no `database_id` is skipped and reported so a project can
   * stand staging up and prove it before production exists (pithy-sh/pithy#512). This command looks like
   * the seventh and is not, and the difference is worth stating rather than remembering.
   *
   * There is nothing here for a readiness check to consult and nothing an unready environment could mean.
   * This command **creates** each environment's D1 rather than reading one; it takes no `resolveEnv`, opens
   * no app `wrangler.jsonc`, and reads no `DB` binding. An environment with no secrets database is exactly
   * the environment this exists to make one for — and it is step 1 of any bring-up, which four of those six
   * refuse without ("Run `pithy secrets provision` first").
   *
   * So: the fan-out is **unconditional**, the seam has no readiness input, and the result has no `skipped`
   * field. A sweeping refactor that gave this the same treatment would break all three, and the tests above
   * would still pass, because they only ever assert a happy path.
   */
  test("spans every declared environment unconditionally — no filter, no readiness input, no skip", async () => {
    const provisioner = new StubProvisioner();

    const result = await provisionSecrets(provisioner, ["staging", "prod"]);

    expect(result.perEnv.map((entry) => entry.env)).toEqual(["staging", "prod"]);
    // Two arguments and no third: nothing may be passed that narrows the set or reports what was left out.
    expect(provisionSecrets.length).toBe(2);
    // The seam is what a readiness check would have to arrive through, and it has no such member.
    expect(Object.keys(provisioner)).not.toContain("resolveEnv");
    // A `skipped` or `status` key here is the tell that this was swept into the shared abstraction.
    expect(Object.keys(result)).toEqual(["perEnv"]);
    for (const entry of result.perEnv) expect(Object.keys(entry)).toEqual(["env", "databaseId", "storeId"]);
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
  /** A secrets database's retained rows, as the live seam counts them. */
  function vaultRows(env: ManagedEnvironment, rows: number): RetainedRows[] {
    return rows === 0 ? [] : [{ binding: `acme-${env}-secrets`, table: "pithy_secrets_system_secrets", rows }];
  }

  /**
   * Records every destructive call. `rows` is what each environment's secrets database holds; `managers` is
   * which environments still run a manager Worker once the run's own deletions have landed.
   */
  function recordingDeprovisioner(
    calls: string[],
    state: { rows?: Partial<Record<string, number>>; managers?: string[] } = {},
  ): SecretsDeprovisioner {
    const managers = new Set(state.managers ?? []);
    return {
      countRetained: vi.fn(async (env: ManagedEnvironment) => vaultRows(env, state.rows?.[env] ?? 0)),
      hasManager: vi.fn(async (env: ManagedEnvironment) => managers.has(env)),
      deleteManager: vi.fn(async (env: ManagedEnvironment) => {
        managers.delete(env);
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

  /**
   * **#591, the whole defect.** One `pithy secrets deprovision`, typed to clean up staging, walked every
   * declared environment and deleted production's vault with it. The target is now named, never defaulted,
   * and the refusal says what could have been named — so the old loop, planted back, fails here.
   */
  test("with no target refuses, lists the environments it could act on, and deletes nothing", async () => {
    const calls: string[] = [];
    const run = deprovisionSecrets(recordingDeprovisioner(calls), {
      environment: undefined,
      declared: DEFAULT_ENVIRONMENTS,
    });

    await expect(run).rejects.toThrow(ValidationError);
    await expect(run).rejects.toMatchObject({
      message: "Name the environment to deprovision. Nothing was deleted.",
      payload: { action: "Pass --env with one of: staging, prod." },
    });
    expect(calls).toEqual([]);
  });

  test("deletes the named environment and no other — production is not reached by naming staging", async () => {
    const calls: string[] = [];
    const deprovisioner = recordingDeprovisioner(calls, { managers: ["staging", "prod"] });

    const result = await deprovisionSecrets(deprovisioner, { environment: "staging", declared: DEFAULT_ENVIRONMENTS });

    expect(calls).toEqual(["manager:staging", "db:staging"]);
    expect(result).toEqual({ environment: "staging", managerTokenDeleted: false });
  });

  test("an environment the project does not declare is refused by name, with nothing deleted", async () => {
    const calls: string[] = [];
    await expect(
      deprovisionSecrets(recordingDeprovisioner(calls), { environment: "live", declared: DEFAULT_ENVIRONMENTS }),
    ).rejects.toMatchObject({ payload: { action: "Pass --env with one of: staging, prod." } });
    expect(calls).toEqual([]);
  });

  test("keeps the shared manager token while any declared environment still runs a manager", async () => {
    // The token is `global`: prod's manager rotates with it. Deleting it for staging's teardown would break
    // every rotation in production at once.
    const calls: string[] = [];
    await deprovisionSecrets(recordingDeprovisioner(calls, { managers: ["staging", "prod"] }), {
      environment: "staging",
      declared: DEFAULT_ENVIRONMENTS,
    });
    expect(calls).not.toContain("token");
  });

  test("removes the shared manager token once the last manager is gone", async () => {
    const calls: string[] = [];
    const result = await deprovisionSecrets(recordingDeprovisioner(calls, { managers: ["prod"] }), {
      environment: "prod",
      declared: DEFAULT_ENVIRONMENTS,
    });
    expect(calls).toEqual(["manager:prod", "db:prod", "token"]);
    expect(result.managerTokenDeleted).toBe(true);
  });

  test("keeps the master key by default, and deletes it only when asked", async () => {
    const calls: string[] = [];
    const options: DeprovisionOptions = { deleteKeys: true };
    await deprovisionSecrets(
      recordingDeprovisioner(calls),
      { environment: "staging", declared: DEFAULT_ENVIRONMENTS },
      options,
    );
    expect(calls).toEqual(["manager:staging", "key:staging", "db:staging", "token"]);
  });

  test("an environment whose vault holds rows refuses without a count, naming the environment and the count", async () => {
    const calls: string[] = [];
    const run = deprovisionSecrets(recordingDeprovisioner(calls, { rows: { prod: 3 } }), {
      environment: "prod",
      declared: DEFAULT_ENVIRONMENTS,
    });

    await expect(run).rejects.toMatchObject({
      message:
        "Retained 3 rows would be dropped: pithy_secrets_system_secrets on acme-prod-secrets (3 rows). Refused before anything was deleted.",
      payload: { action: "They exist nowhere else. Back them up, or pass --destroy-retained 3 to drop them." },
    });
    // Refused before the manager went: a refusal after it would leave prod with a vault and nothing to run it.
    expect(calls).toEqual([]);
  });

  test("a count that is not the count refuses too", async () => {
    const calls: string[] = [];
    await expect(
      deprovisionSecrets(
        recordingDeprovisioner(calls, { rows: { prod: 3 } }),
        { environment: "prod", declared: DEFAULT_ENVIRONMENTS },
        { destroyRetained: 2 },
      ),
    ).rejects.toThrow("--destroy-retained 2 does not match the 3 rows at risk.");
    expect(calls).toEqual([]);
  });

  test("the exact count deletes", async () => {
    const calls: string[] = [];
    await deprovisionSecrets(
      recordingDeprovisioner(calls, { rows: { prod: 3 } }),
      { environment: "prod", declared: DEFAULT_ENVIRONMENTS },
      { destroyRetained: 3 },
    );
    expect(calls).toEqual(["manager:prod", "db:prod", "token"]);
  });
});
