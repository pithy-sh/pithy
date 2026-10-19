// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkSecretRotations, describeSecretRotations, type SecretRotationsOptions } from "./secretRotations";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-doctor-rotations-"));
  await mkdir(join(root, "apps", "api"), { recursive: true });
  await writeFile(
    join(root, "apps", "api", "wrangler.jsonc"),
    JSON.stringify({
      name: "api",
      d1_databases: [{ binding: "SECRETS", database_name: "x", database_id: "local" }],
      env: {
        staging: {
          d1_databases: [{ binding: "SECRETS", database_name: "acme-staging-secrets", database_id: "db-staging" }],
        },
        prod: { d1_databases: [{ binding: "SECRETS", database_name: "acme-prod-secrets", database_id: "db-prod" }] },
      },
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const withSecrets = (): Capability[] => [
  secrets({
    registry: {
      "app-session-secret": {
        backend: "d1",
        scope: "environment",
        rotatable: true,
        valueType: "text",
        devValue: "random",
        origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
        rotation: { kind: "local" },
        rotateEveryDays: 90,
        overlap: { days: 7, minimumDays: 7 },
      },
    },
  }),
];

function options(overrides: Partial<SecretRotationsOptions> = {}): SecretRotationsOptions {
  return {
    projectDir: root,
    environments: ["staging", "prod"],
    workers: [{ name: "api", dir: join(root, "apps", "api") }],
    account: null,
    remoteSkip: null,
    composeWorker: async () => ({ capabilities: withSecrets() }),
    readLedger: async () => [],
    ...overrides,
  };
}

describe("checkSecretRotations (#602)", () => {
  test("a failed automatic rotation is a finding, named with its code and its day", async () => {
    const check = await checkSecretRotations(
      options({
        readLedger: async (env) =>
          env === "prod"
            ? [{ name: "app-session-secret", at: "2026-10-18T03:00:04.000Z", reason: "not-recorded" }]
            : [],
      }),
    );
    expect(check.state).toBe("findings");
    expect(describeSecretRotations(check)).toEqual([
      "staging: no failed rotation.",
      "prod: 1 secret's last rotation failed.",
      "  app-session-secret — 2026-10-18: the issuer rolled and the store did not take the value — the old credential is dead, act now.",
    ]);
  });

  test("a failure in words this release did not write is still reported, without the words", async () => {
    const check = await checkSecretRotations(
      options({
        readLedger: async () => [{ name: "app-session-secret", at: "2026-10-18T03:00:04.000Z", reason: null }],
      }),
    );
    expect(describeSecretRotations(check)).toContain(
      "  app-session-secret — 2026-10-18: for a reason this release does not record.",
    );
  });

  test("every environment read and nothing failed is ok", async () => {
    expect((await checkSecretRotations(options())).state).toBe("ok");
  });

  test("a project composing no secrets capability is not applicable and reads nothing", async () => {
    const readLedger = vi.fn();
    const check = await checkSecretRotations(
      options({
        composeWorker: async () => ({ capabilities: [defineCapability({ name: "app", requiredBindings: [] })] }),
        readLedger,
      }),
    );
    expect(check).toEqual({ state: "not-applicable", environments: [] });
    expect(readLedger).not.toHaveBeenCalled();
  });

  test("a config that throws in one environment does not make a project with no secrets applicable", async () => {
    const readLedger = vi.fn();
    const check = await checkSecretRotations(
      options({
        composeWorker: async (_worker, env) => {
          if (env === "prod") throw new Error("Billing is not configured for this environment");
          return { capabilities: [defineCapability({ name: "app", requiredBindings: [] })] };
        },
        readLedger,
      }),
    );
    expect(check).toEqual({ state: "not-applicable", environments: [] });
    expect(readLedger).not.toHaveBeenCalled();
  });

  test("a config that throws beside one that composes secrets is still reported as not composed", async () => {
    const check = await checkSecretRotations(
      options({
        composeWorker: async (_worker, env) => {
          if (env === "prod") throw new Error("Billing is not configured for this environment");
          return { capabilities: withSecrets() };
        },
      }),
    );
    expect(check.state).toBe("could-not-check");
    expect(describeSecretRotations(check)).toEqual([
      "staging: no failed rotation.",
      "prod: pithy.config.ts did not compose for prod, so no ledger was read.",
    ]);
  });

  test("a config that composes in no environment is unknown, since whether it composes secrets is too", async () => {
    const check = await checkSecretRotations(
      options({
        composeWorker: async () => {
          throw new Error("Billing is not configured for this environment");
        },
      }),
    );
    expect(check.state).toBe("could-not-check");
    expect(describeSecretRotations(check)).toEqual([
      "staging: pithy.config.ts did not compose for staging, so no ledger was read.",
      "prod: pithy.config.ts did not compose for prod, so no ledger was read.",
    ]);
  });

  test("offline, nothing is read and the report says so rather than reading as healthy", async () => {
    const readLedger = vi.fn();
    const check = await checkSecretRotations(options({ remoteSkip: "offline", readLedger }));
    expect(check.state).toBe("could-not-check");
    expect(readLedger).not.toHaveBeenCalled();
    expect(describeSecretRotations(check)).toEqual([
      "staging: skipped — offline, so no ledger was read.",
      "prod: skipped — offline, so no ledger was read.",
    ]);
  });

  test("a ledger that will not read is unknown, never clean", async () => {
    const check = await checkSecretRotations(
      options({
        readLedger: async () => {
          throw new Error("D1 unreachable: db-prod select * from …");
        },
      }),
    );
    expect(check.state).toBe("could-not-check");
    expect(describeSecretRotations(check).join("\n")).not.toContain("db-prod");
  });

  test("an environment with no SECRETS database is not provisioned, and is not asked", async () => {
    await writeFile(
      join(root, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({
        name: "api",
        d1_databases: [{ binding: "SECRETS", database_name: "x", database_id: "local" }],
        env: {
          staging: { d1_databases: [{ binding: "SECRETS", database_name: "acme-staging-secrets" }] },
          prod: { d1_databases: [{ binding: "SECRETS", database_name: "acme-prod-secrets", database_id: "db-prod" }] },
        },
      }),
    );
    const readLedger = vi.fn(async () => []);
    const check = await checkSecretRotations(options({ readLedger }));
    expect(check.environments[0]).toEqual({ env: "staging", state: "not-provisioned" });
    expect(readLedger).toHaveBeenCalledTimes(1);
    // Nothing could have rotated where nothing is provisioned, so it is not a gap in what was learned.
    expect(check.state).toBe("ok");
  });
});
