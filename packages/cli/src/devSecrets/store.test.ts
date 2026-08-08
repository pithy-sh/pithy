// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { secrets_0001_init } from "@pithy-sh/secrets/src/migrations/0001_init";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDevSecretsStore, SECRETS_D1_BINDING } from "./store";

let dir: string;
let workerDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secrets-store-"));
  workerDir = join(dir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A `wrangler.jsonc` declaring the SECRETS binding, the way `pithy add secrets` writes it (no id). */
async function withSecretsBinding(): Promise<void> {
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    '{ "d1_databases": [{ "binding": "SECRETS", "database_name": "replay-dev-secrets" }] }',
  );
}

/** A `.dev.vars` with a real dev master key, as `pithy add secrets` mints it. */
async function withMasterKey(): Promise<void> {
  await writeFile(
    join(dir, ".dev.vars"),
    `SECRETS_ENCRYPTION_KEYS=${JSON.stringify(await initialMasterKeyConfig())}\n`,
  );
}

/**
 * Migrate the same Miniflare store `openDevSecretsStore` opens — same persistence root, same resolved
 * database identity (`database_id` else the binding). If those two ever disagree, this test is what says
 * so: the store would come back ready and read an empty database the Worker never writes to.
 */
async function migrateLocalSecrets(): Promise<void> {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { [SECRETS_D1_BINDING]: SECRETS_D1_BINDING },
    d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
  });
  try {
    const d1 = (await miniflare.getD1Database(SECRETS_D1_BINDING)) as unknown as D1Database;
    await secrets_0001_init.up(createDatabase(d1, secretsTables));
  } finally {
    await miniflare.dispose();
  }
}

describe("openDevSecretsStore", () => {
  test("a Worker with no SECRETS binding is not an error — it names the command that adds one", async () => {
    await writeFile(join(workerDir, "wrangler.jsonc"), '{ "d1_databases": [] }');
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board" });
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("pithy add secrets --worker board");
  });

  test("no master key names the master key, not the database", async () => {
    await withSecretsBinding();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("SECRETS_ENCRYPTION_KEYS");
  });

  test("an unmigrated database says pithy migrate — no adopter can act on `no such table`", async () => {
    await withSecretsBinding();
    await withMasterKey();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("pithy migrate");
  });

  test("a master key that is not a key config says so, instead of blaming the migration", async () => {
    await withSecretsBinding();
    await migrateLocalSecrets();
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS=not-json\n");
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("not a valid master key");
  });

  test("a migrated project opens the store the Worker itself reads — a put comes back out", async () => {
    await withSecretsBinding();
    await withMasterKey();
    await migrateLocalSecrets();

    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    expect(handle.ready).toBe(true);
    if (!handle.ready) return;
    try {
      await handle.store.put("auth-session-secret", { currentVersion: "1", versions: { "1": "value" } }, "text");
      expect(await handle.store.getValue("auth-session-secret")).toEqual({
        currentVersion: "1",
        versions: { "1": "value" },
      });
    } finally {
      await handle.dispose();
    }
  });

  test("what it writes persists where wrangler dev looks — a second open finds the first one's row", async () => {
    await withSecretsBinding();
    await withMasterKey();
    await migrateLocalSecrets();

    const first = await openDevSecretsStore({ projectDir: dir, workerDir });
    if (!first.ready) throw new Error(first.reason);
    await first.store.put("auth-session-secret", { currentVersion: "1", versions: { "1": "value" } }, "text");
    await first.dispose();

    const second = await openDevSecretsStore({ projectDir: dir, workerDir });
    if (!second.ready) throw new Error(second.reason);
    try {
      expect(await second.store.getValue("auth-session-secret")).toBeDefined();
    } finally {
      await second.dispose();
    }
  });
});
