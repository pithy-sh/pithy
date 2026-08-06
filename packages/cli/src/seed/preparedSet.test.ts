// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { DEV_LOGIN_PATH } from "@pithy-sh/core/src/seed/devLogin";
import { d1SeedGroup, defineSeed, type SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { describe, expect, test } from "vitest";
import { migrateProject } from "../migrations/run";
import { createThings, localWrangler, seedHarness, Things } from "../test-utils/seedHarness";
import { seedProject } from "./run";

/** A capability whose set computes its rows at seed time and emits a login artifact, like auth's does. */
function preparedCapability(seen: SeedPrepareContext[], environments: readonly string[] = ["dev"]): Capability {
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

describe("a prepared seed set", () => {
  const h = seedHarness();

  test("writes its computed rows and its artifact into the gitignored logs directory", async () => {
    await h.writeWrangler(localWrangler);
    await writeFile(join(h.projectDir, ".dev.vars"), "auth-session-secret=s3cr3t\n");
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
