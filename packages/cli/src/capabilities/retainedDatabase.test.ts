// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { RetainedBudget } from "@pithy-sh/core/src/migrations/retained";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import { deprovisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { MigrationProvider } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, test, vi } from "vitest";
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

/** Every non-test `.ts` file under `dir`, recursively. */
async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/**
 * **The reach, checked rather than asserted.** Every place the CLI's own sources name Cloudflare's D1 delete
 * is the primitive above, or `provision/resources.ts` — a feature environment's teardown, which binds no
 * retained database (see `retainedDatabase.ts`). A seam method *declared* with the same name
 * (`async deleteDatabase(env)`) is a name, not a delete; its body has to reach one of the two to delete
 * anything. Any other spelling — a call, a destructured or aliased member, a string key — names the member
 * once and is listed here.
 *
 * What this cannot see is written in `retainedDatabase.ts`'s header.
 */
describe("every D1 delete in the CLI is counted first", () => {
  test("the only sources naming the control-plane delete are the primitive and the feature teardown", async () => {
    const root = join(KIT_ROOT, "src");
    const permitted = new Set(["capabilities/retainedDatabase.ts", "provision/resources.ts"]);
    const offenders: string[] = [];
    for (const file of await sources(root)) {
      const path = relative(root, file);
      if (permitted.has(path)) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (!code.includes("deleteDatabase")) continue;
        // A declaration names the member once and deletes nothing; a one-line body that also calls it does not pass.
        if (/^async deleteDatabase\(/.test(code) && code.split("deleteDatabase").length === 2) continue;
        offenders.push(`${path}:${index + 1}: ${code}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
