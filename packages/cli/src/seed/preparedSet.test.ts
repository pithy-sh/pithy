// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { DEV_LOGIN_PATH } from "@pithy-sh/core/src/seed/devLogin";
import { d1SeedGroup, defineSeed, type SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import { migrateProject } from "../migrations/run";
import { createThings, localWrangler, seedHarness, Things } from "../test-utils/seedHarness";
import { seedProject } from "./run";

/** A capability whose set computes its rows at seed time and emits a login artifact, like auth's does. */
function preparedCapability(seen: SeedPrepareContext[], environments: readonly string[] = ["dev"]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    // Declared, because the reader routes off the registry: a name no capability declares is not a
    // secret, and answering `undefined` for it is the point (#176).
    secretRegistry: defineSecretRegistry({
      "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    }),
    databases: {
      app: {
        binding: "DB",
        tables: { things: Things },
        migrations: { "0001_things": createThings },
        migrationOrder: 1000,
      },
    },
    seeds: [
      defineSeed({
        name: "prepared",
        order: 1000,
        environments,
        prepare: async (context) => {
          seen.push(context);
          const secret = await context.secret("auth-session-secret");
          return {
            d1: [d1SeedGroup("app", "things", Things, [{ id: 9, name: `${context.project}:${secret ?? "none"}` }])],
            artifacts: [{ file: "dev-login.json", contents: `${JSON.stringify(context.preferences)}\n` }],
          };
        },
      }),
    ],
  });
}

/**
 * A capability whose static set declares a row and whose prepared set reads it back off the context. The
 * shape auth's dev login has: one set creates the users, a later one references whichever exist.
 */
function inventoryCapability(seen: string[]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: {
        binding: "DB",
        tables: { things: Things },
        migrations: { "0001_things": createThings },
        migrationOrder: 1000,
      },
    },
    seeds: [
      defineSeed({
        name: "static",
        order: 900,
        environments: ["dev"],
        d1: [d1SeedGroup("app", "things", Things, [{ id: 1, name: "declared" }])],
      }),
      defineSeed({
        name: "prepared",
        order: 1000,
        environments: ["dev"],
        prepare: async (context) => {
          seen.push(...context.seeded("app", "things").map((row) => Things.parse(row).name));
          return {};
        },
      }),
    ],
  });
}

describe("a prepared seed set", () => {
  const h = seedHarness();

  test("writes its computed rows and its artifact into the gitignored logs directory", async () => {
    await h.writeWrangler(localWrangler);
    // The dev secrets file, not `.dev.vars`: since #153 that file carries no `d1` secret, and since
    // #176 the reader looks where `pithy seed` actually writes.
    const secrets = devSecretsFile("acme");
    await mkdir(dirname(secrets), { recursive: true });
    await writeFile(
      secrets,
      JSON.stringify({ "auth-session-secret": { currentVersion: "1", versions: { "1": "s3cr3t" } } }),
    );
    const seen: SeedPrepareContext[] = [];
    const capabilities = [preparedCapability(seen)];
    await migrateProject({ workers: [h.api(capabilities)], projectDir: h.projectDir, env: "dev", project: "acme" });

    const report = await seedProject({
      project: "acme",
      workers: [h.api(capabilities)],
      projectDir: h.projectDir,
      env: "dev",
      preferences: async () => ({ user: "ada@example.com" }),
    });

    expect(report.workers[0]?.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 1 }]);
    expect(seen[0]?.env).toBe("dev");
    expect(seen[0]?.project).toBe("acme");
    expect(seen[0]?.preferences).toEqual({ user: "ada@example.com" });

    const store = await h.openLocal();
    try {
      const row = await store.d1.prepare("SELECT name FROM things WHERE id = 9").first<{ name: string }>();
      expect(row?.name).toBe("acme:s3cr3t");
    } finally {
      await store.dispose();
    }

    expect(await readFile(join(h.projectDir, DEV_LOGIN_PATH), "utf8")).toBe('{"user":"ada@example.com"}\n');
  });

  test("sees the rows another set declares, so it can reference a row it does not own", async () => {
    await h.writeWrangler(localWrangler);
    const seen: string[] = [];
    const capabilities = [inventoryCapability(seen)];
    await migrateProject({ workers: [h.api(capabilities)], projectDir: h.projectDir, env: "dev", project: "acme" });

    await seedProject({
      project: "acme",
      workers: [h.api(capabilities)],
      projectDir: h.projectDir,
      env: "dev",
    });

    expect(seen).toEqual(["declared"]);
  });

  test("a dry run neither prepares nor emits — it touches no backend and needs no secret", async () => {
    await h.writeWrangler(localWrangler);
    const seen: SeedPrepareContext[] = [];
    const capabilities = [preparedCapability(seen)];

    const report = await seedProject({
      project: "acme",
      workers: [h.api(capabilities)],
      projectDir: h.projectDir,
      env: "dev",
      dryRun: true,
      preferences: async () => ({ user: "ada@example.com" }),
    });

    expect(report.dryRun).toBe(true);
    expect(seen).toEqual([]);
    expect(await readFile(join(h.projectDir, DEV_LOGIN_PATH), "utf8").catch(() => null)).toBeNull();
  });

  test("is never prepared for an environment its set does not allow", async () => {
    await h.writeWrangler(localWrangler);
    const seen: SeedPrepareContext[] = [];
    const capabilities = [preparedCapability(seen)];

    const report = await seedProject({
      project: "acme",
      workers: [h.api(capabilities)],
      projectDir: h.projectDir,
      env: "staging",
      yes: true,
      preferences: async () => ({ user: "ada@example.com" }),
    });

    expect(report.workers[0]?.skippedByEnv).toEqual(["1000_app_prepared"]);
    expect(seen).toEqual([]);
  });

  test("leaves no artifact behind when the rows it describes fail to land", async () => {
    await h.writeWrangler(localWrangler);
    const seen: SeedPrepareContext[] = [];
    const capabilities = [preparedCapability(seen)];
    // No migration ran, so `things` does not exist and the computed row cannot be written.
    const failure = await seedProject({
      project: "acme",
      workers: [h.api(capabilities)],
      projectDir: h.projectDir,
      env: "dev",
      preferences: async () => ({ user: "ada@example.com" }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await readFile(join(h.projectDir, DEV_LOGIN_PATH), "utf8").catch(() => null)).toBeNull();
  });
});
