// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { describe, expect, test } from "vitest";
import { secrets_0001_init } from "../migrations/0001_init";

/**
 * LIVE integration test — runs the `secrets_*` migrations against a real D1 over the REST API, the
 * way `pithy add secrets` provisioning will. Creates a throwaway database, migrates it, verifies the
 * prefixed tables exist, and deletes it. Reads creds from `.dev.vars`; skipped when absent.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const vars = loadCloudflareEnv(path.join(__dirname, "../.."));
const hasCreds = Boolean(vars.CLOUDFLARE_API_TOKEN && vars.CLOUDFLARE_ACCOUNT_ID);

/** The secrets migration set, as provisioning composes it for the SECRETS database. */
function provider() {
  const registry = createMigrationRegistry([
    { database: "secrets", namespace: "secrets", order: 100, migrations: { "0001_init": secrets_0001_init } },
  ]);
  const found = registry.secrets;
  if (!found) throw new Error("no secrets migration provider");
  return found;
}

describe.skipIf(!hasCreds)("secrets migrations — LIVE against a real D1 over REST", () => {
  test("create a throwaway D1, migrate it, verify the prefixed tables, then delete it", async () => {
    const cf = new CloudflareClients({
      accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: vars.CLOUDFLARE_API_TOKEN ?? "",
    });
    const db = await cf.d1Provisioner().createDatabase(`pithy-secrets-migrate-test-${Date.now()}`);
    try {
      const results = await runMigrations(cf.d1(db.uuid), provider());
      expect(results.map((r) => [r.migrationName, r.status])).toEqual([["0100_secrets_0001_init", "Success"]]);

      const tables = await cf
        .d1(db.uuid)
        .prepare("select name from sqlite_master where type = 'table' and name like 'pithy_secrets_%'")
        .all<{ name: string }>();
      expect((tables.results ?? []).map((r) => r.name).sort()).toEqual([
        "pithy_secrets_rotations",
        "pithy_secrets_system_secrets",
      ]);
    } finally {
      await cf.d1Provisioner().deleteDatabase(db.uuid);
    }
  });
});
