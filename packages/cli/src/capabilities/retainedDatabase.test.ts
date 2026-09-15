// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, resolve, sep } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { RetainedBudget } from "@pithy-sh/core/src/migrations/retained";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import { deprovisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { MigrationProvider } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, test, vi } from "vitest";
import { blankStrings } from "../ci/childProcesses";
import { readSource, sourcePaths } from "../ci/sourceFiles";
import { KIT_ROOT } from "../test-utils/kitRoot";
import { CloudflareEmailDeprovisioner, suppressionMigrationProvider } from "./emailProvisioner";
import { deleteRetainedDatabase } from "./retainedDatabase";
import { CloudflareSecretsDeprovisioner, secretsMigrationProvider } from "./secretsProvisioner";

/**
 * **#591: `pithy secrets deprovision` deleted production's vault.**
 *
 * These run against a real SQLite D1 (Miniflare), migrated by the provisioner's **own** migration set — and
 * this file imports neither `secrets()` nor `email()`. That is the point: the CLI process that tears a
 * database down never constructs the capability, so if the retained declaration reached the count only
 * through `defineCapability`, every count here would find nothing and every delete would go through.
 */

const PROJECT = "acme";

const open: Miniflare[] = [];
afterEach(async () => {
  for (const mf of open.splice(0)) await mf.dispose();
});

/** A fresh in-memory D1, migrated by `provider`. */
async function migratedD1(provider: MigrationProvider): Promise<D1Database> {
  const mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { D: "retained" } });
  open.push(mf);
  const db = (await mf.getD1Database("D")) as unknown as D1Database;
  await runMigrations(db, provider);
  return db;
}

/** Seal `count` secrets into the vault, the way the manager stores them. */
async function storeSecrets(db: D1Database, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await db
      .prepare(
        "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, 'sealed', 'iv', 1, 'text', 1, 1)",
      )
      .bind(`secret-${index}`)
      .run();
  }
}

/** One account holding one database called `name`, served by `db`, with a spy on the control-plane delete. */
function accountWith(name: string, db: D1Database) {
  const deleteDatabase = vi.fn(async () => {});
  const deleteWorker = vi.fn(async () => {});
  const cf = {
    d1: () => db,
    d1Provisioner: () => ({
      findDatabaseByName: async (wanted: string) => (wanted === name ? { uuid: "db-1", name } : null),
      deleteDatabase,
    }),
    workers: () => ({ getWorker: async () => null, deleteWorker }),
    secrets: () => ({ exists: async () => false, deleteSecret: async () => {} }),
    accountTokens: () => ({ deleteTokensByName: async () => 0 }),
  } as unknown as CloudflareClients;
  return { cf, deleteDatabase };
}

const pinned = { accountId: "acct-1", confirmation: "pinned" } as const;

describe("the secrets teardown counts the vault before it deletes it", () => {
  test("a vault holding rows is not deleted without the count — refused naming the database and the count", async () => {
    const db = await migratedD1(secretsMigrationProvider());
    await storeSecrets(db, 3);
    const { cf, deleteDatabase } = accountWith(managerWorkerName(PROJECT, "prod"), db);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ account: pinned, cf, project: PROJECT, storeId: "s" });

    await expect(
      deprovisionSecrets(deprovisioner, { environment: "prod", declared: ["staging", "prod"] }),
    ).rejects.toThrow(
      "Retained 3 rows would be dropped: pithy_secrets_system_secrets on acme-prod-secrets (3 rows). Refused before anything was deleted.",
    );
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  test("the floor holds on its own: the seam's delete, called directly, refuses what its budget does not cover", async () => {
    const db = await migratedD1(secretsMigrationProvider());
    await storeSecrets(db, 3);
    const { cf, deleteDatabase } = accountWith(managerWorkerName(PROJECT, "prod"), db);

    const underBudget = new CloudflareSecretsDeprovisioner({
      account: pinned,
      cf,
      project: PROJECT,
      storeId: "s",
      budget: new RetainedBudget(2),
    });
    await expect(underBudget.deleteDatabase("prod")).rejects.toThrow("Retained 3 rows would be dropped");
    expect(deleteDatabase).not.toHaveBeenCalled();

    const counted = new CloudflareSecretsDeprovisioner({
      account: pinned,
      cf,
      project: PROJECT,
      storeId: "s",
      budget: new RetainedBudget(3),
    });
    await counted.deleteDatabase("prod");
    expect(deleteDatabase).toHaveBeenCalledWith("db-1");
  });

  test("an empty vault deletes with the environment named and nothing else", async () => {
    const db = await migratedD1(secretsMigrationProvider());
    const { cf, deleteDatabase } = accountWith(managerWorkerName(PROJECT, "staging"), db);
    const deprovisioner = new CloudflareSecretsDeprovisioner({ account: pinned, cf, project: PROJECT, storeId: "s" });

    await deprovisionSecrets(deprovisioner, { environment: "staging", declared: ["staging", "prod"] });
    expect(deleteDatabase).toHaveBeenCalledWith("db-1");
  });
});

describe("the email teardown counts the suppression list before it deletes it", () => {
  test("a suppression list holding rows is not deleted without the count", async () => {
    const db = await migratedD1(suppressionMigrationProvider());
    await db
      .prepare("insert into pithy_email_suppressions (email, reason, created_at) values ('a@example.com', 'bounce', 1)")
      .run();
    const { cf, deleteDatabase } = accountWith(suppressionDatabaseName(PROJECT), db);
    const deprovisioner = new CloudflareEmailDeprovisioner({ account: pinned, cf, project: PROJECT });

    await expect(deprovisioner.deleteSuppressionDatabase()).rejects.toThrow(
      `Retained 1 row would be dropped: pithy_email_suppressions on ${suppressionDatabaseName(PROJECT)} (1 row).`,
    );
    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});

describe("deleteRetainedDatabase", () => {
  test("refuses a migration set that declares nothing retained, rather than counting nothing and deleting", async () => {
    // The hole this closes: a provisioner whose registry was built without the capability's `retained`.
    const undeclared = createMigrationRegistry([
      {
        database: "secrets",
        namespace: "secrets",
        order: 100,
        migrations: { "0001_init": { up: async () => {}, down: async () => {} } },
      },
    ]).secrets as MigrationProvider;
    const db = await migratedD1(undeclared);
    const { cf, deleteDatabase } = accountWith("acme-prod-secrets", db);

    await expect(
      deleteRetainedDatabase(
        { cf, databaseId: "db-1", name: "acme-prod-secrets", provider: undeclared },
        new RetainedBudget(undefined),
      ),
    ).rejects.toThrow(InternalError);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});

/** Every shipped module under the CLI's `src`, keyed by its path below `src`, with comments blanked. */
function cliModules(): { path: string; file: string; code: string }[] {
  const root = join(KIT_ROOT, "src");
  const modules: { path: string; file: string; code: string }[] = [];
  for (const file of sourcePaths(root)) {
    const text = readSource(file);
    if (text !== null)
      modules.push({ path: relative(root, file).split(sep).join("/"), file, code: blankComments(text) });
  }
  return modules;
}

/** The feature teardown's provisioners: the one module that exposes a D1 delete without counting it. */
const RESOURCES = join(KIT_ROOT, "src", "provision", "resources.ts");

/** Whether `module` imports `provision/resources.ts` — by a static, dynamic or template specifier, however aliased. */
function importsResources(module: { file: string; code: string }): boolean {
  for (const match of module.code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(["'\x60])(\.[^"'\x60]*)\1/g)) {
    const target = resolve(dirname(module.file), (match[2] as string).replace(/\.(?:js|ts)$/, ""));
    if (`${target}.ts` === RESOURCES || target === RESOURCES) return true;
  }
  return false;
}

/**
 * **The reach, checked rather than asserted.** Every D1 deletion in the CLI's own sources is the counted
 * primitive, `deleteRetainedDatabase`, or the feature teardown — which is deliberately uncounted, and says
 * so in `retainedDatabase.ts`. Two things have to be true for that, and each is a test:
 *
 * 1. **Only two modules name the control-plane delete.** `deleteDatabase` is spelled in `retainedDatabase.ts`
 *    and `provision/resources.ts`, and nowhere else — a call, a destructured or aliased member, and a string
 *    key all spell it once. A seam method *declared* with the name (`async deleteDatabase(env)`) is a name,
 *    not a delete; its body has to reach one of the two to delete anything.
 * 2. **Only the feature teardown deletes through `provision/resources.ts`.** That module re-exposes the delete
 *    as `ResourceProvisioners.d1.delete`, so a module holding its provisioners can delete a vault without
 *    naming `deleteDatabase` at all (#591's review planted exactly that, and the first half stayed green).
 *    Every module that imports it — found by the specifier, which an alias cannot rename — and says `delete`
 *    in code is `feature/provision.ts`.
 *
 * What this cannot see is written in `retainedDatabase.ts`'s header.
 */
describe("every D1 delete in the CLI is counted first, or is the feature teardown", () => {
  test("this walk sees the CLI, so a miss is a failure and not a silent pass", () => {
    const modules = cliModules();
    expect(modules.length).toBeGreaterThan(200);
    expect(modules.filter(importsResources).map((module) => module.path)).toEqual(
      expect.arrayContaining(["commands/feature.ts", "feature/provision.ts"]),
    );
  });

  test("the only sources naming the control-plane delete are the primitive and the feature teardown's provisioners", () => {
    const permitted = new Set(["capabilities/retainedDatabase.ts", "provision/resources.ts"]);
    const offenders: string[] = [];
    for (const module of cliModules()) {
      if (permitted.has(module.path)) continue;
      for (const [index, line] of module.code.split("\n").entries()) {
        const code = line.trim();
        if (!code.includes("deleteDatabase")) continue;
        // A declaration names the member once and deletes nothing; a one-line body that also calls it does not pass.
        if (/^async deleteDatabase\(/.test(code) && code.split("deleteDatabase").length === 2) continue;
        offenders.push(`${module.path}:${index + 1}: ${code}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the only module that deletes through the feature teardown's provisioners is the feature teardown", () => {
    const offenders = cliModules()
      .filter((module) => module.path !== "provision/resources.ts" && importsResources(module))
      .filter((module) => {
        // `delete` as a word in code, strings blanked so a flag's description does not count — and the one
        // spelling blanking would hide, a string key, read from the unblanked code.
        return /\bdelete\b/.test(blankStrings(module.code)) || /\[\s*["'\x60]delete["'\x60]\s*\]/.test(module.code);
      })
      .map((module) => module.path);
    expect(offenders).toEqual(["feature/provision.ts"]);
  });
});
