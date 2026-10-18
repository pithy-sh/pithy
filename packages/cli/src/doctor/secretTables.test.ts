// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { secretTablesDatabase } from "@pithy-sh/secrets/src/tables/database";
import { defineSecretTable } from "@pithy-sh/secrets/src/tables/defineSecretTable";
import type { VaultTableStats } from "@pithy-sh/secrets/src/tables/stats";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { checkSecretTables, describeSecretTables, type SecretTablesOptions, secretTablesFix } from "./secretTables";

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: { userId: z.string().describe("The user."), organizationId: z.string().describe("The organization.") },
  secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-doctor-tables-"));
  await mkdir(join(root, "apps", "api"), { recursive: true });
  // A provisioned stanza for prod, so the read is attempted there.
  await writeFile(
    join(root, "apps", "api", "wrangler.jsonc"),
    JSON.stringify({
      name: "api",
      d1_databases: [{ binding: "SECRETS", database_name: "x", database_id: "local" }],
      env: {
        prod: { d1_databases: [{ binding: "SECRETS", database_name: "acme-prod-secrets", database_id: "db-prod" }] },
      },
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const composed = (declares: boolean): Capability[] => [
  secrets({ registry: {} }),
  defineCapability({
    name: "app",
    requiredBindings: [],
    ...(declares ? { databases: { secrets: secretTablesDatabase({ tables: [CustomerSecrets] }) } } : {}),
  }),
];

const vault = (keyVersions: Record<string, number>): VaultTableStats => ({
  newestKeyVersion: Math.max(...Object.keys(keyVersions).map(Number)),
  tables: [
    {
      table: "customer",
      keys: ["userId", "organizationId"],
      secrets: [{ name: "STRIPE_KEY", rows: Object.values(keyVersions).reduce((a, b) => a + b, 0), keyVersions }],
    },
  ],
});

function options(overrides: Partial<SecretTablesOptions> = {}): SecretTablesOptions {
  return {
    projectDir: root,
    environments: ["dev", "prod"],
    workers: [{ name: "api", dir: join(root, "apps", "api") }],
    account: null,
    remoteSkip: null,
    composeWorker: async () => ({ capabilities: composed(true) }),
    readVault: async () => vault({ "4": 10 }),
    ...overrides,
  };
}

describe("checkSecretTables", () => {
  test("a project declaring no table is not applicable and reads nothing", async () => {
    const readVault = vi.fn();
    const check = await checkSecretTables(
      options({ composeWorker: async () => ({ capabilities: composed(false) }), readVault }),
    );
    expect(check).toEqual({ state: "not-applicable", declared: [], environments: [] });
    expect(readVault).not.toHaveBeenCalled();
  });

  test("reports the declared tables, and every environment whose rows are all on the newest key", async () => {
    const check = await checkSecretTables(options());
    expect(check.state).toBe("ok");
    expect(describeSecretTables(check)).toEqual([
      "customer (userId, organizationId)",
      "dev: every row on key v4.",
      "prod: every row on key v4.",
    ]);
  });

  test("flags rows not on the newest key, per environment", async () => {
    const check = await checkSecretTables(
      options({ readVault: async (env) => (env === "prod" ? vault({ "3": 12, "4": 1192 }) : vault({ "4": 3 })) }),
    );
    expect(check.state).toBe("findings");
    expect(describeSecretTables(check)).toContain(
      "prod: 12 rows not on key v4 — the last at-rest rotation did not reach them.",
    );
  });

  test("a skipped deployed read says so, and keeps the verdict open", async () => {
    const readVault = vi.fn(async () => vault({ "4": 1 }));
    const check = await checkSecretTables(options({ remoteSkip: "offline", readVault }));
    expect(check.state).toBe("could-not-check");
    expect(describeSecretTables(check)).toContain("prod: skipped — offline, so no table was read.");
    expect(readVault).toHaveBeenCalledTimes(1);
  });

  test("a table not migrated in an environment names the command, and an empty vault says no rows yet", async () => {
    const check = await checkSecretTables(options({ readVault: async () => ({ newestKeyVersion: null, tables: [] }) }));
    expect(describeSecretTables(check)).toContain(
      "dev: no rows yet. customer not migrated. Run pithy migrate --env dev.",
    );
  });

  test("an unreadable vault and a config that will not compose are said, never counted", async () => {
    const check = await checkSecretTables(
      options({
        composeWorker: async (_worker, env) => {
          if (env === "prod") throw new Error("boom");
          return { capabilities: composed(true) };
        },
        readVault: async () => {
          throw new Error("D1 db-123 refused query select …");
        },
      }),
    );
    expect(check.state).toBe("could-not-check");
    const lines = describeSecretTables(check);
    expect(lines).toContain("dev: could not be read, so whether every row is on the newest key is unknown.");
    expect(lines).toContain("prod: pithy.config.ts did not compose for prod, so no table was read.");
    expect(lines.join("\n")).not.toContain("db-123");
  });
});

describe("secretTablesFix", () => {
  test("a table not migrated is fixed by migrate; a row behind and every other state name nothing", () => {
    expect(
      secretTablesFix({ env: "staging", state: "read", newestKeyVersion: 1, behind: 0, notMigrated: ["customer"] }),
    ).toBe("pithy migrate --env staging");
    expect(
      secretTablesFix({ env: "prod", state: "read", newestKeyVersion: 4, behind: 12, notMigrated: [] }),
    ).toBeNull();
    expect(secretTablesFix({ env: "prod", state: "skipped", reason: "offline" })).toBeNull();
  });
});
