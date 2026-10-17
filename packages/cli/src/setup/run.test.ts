// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PreparedDev } from "../dev/prepare";
import type { SeedRunReport } from "../seed/run";
import type { HeldTable } from "./dataHeld";
import type { MintReport } from "./mint";
import { isBlockedPlan, type SetupReport, type SetupResult, type SetupSteps, setupCheckout, setupPlan } from "./run";

/**
 * **The order of `pithy setup`, and what each step's answer does to the next (#764).** Every step is a recording
 * fake here; each step's own behavior is its own module's test, and `setup.e2e.test.ts` runs them all for real on
 * a fresh clone.
 */

const DIR = "/home/you/acme";
const SECRETS = "/home/you/.config/pithy/acme/secrets.jsonc";

function prepared(overrides: Partial<PreparedDev> = {}): PreparedDev {
  return {
    dev: null,
    allocated: false,
    devVars: [],
    devVarsDirs: [`${DIR}/apps/api`],
    seededSecrets: [],
    notes: [],
    ...overrides,
  };
}

function seedReport(sets: SeedRunReport["workers"][number]["sets"], dryRun: boolean): SeedRunReport {
  return { command: "seed", env: "dev", dryRun, workers: [{ worker: "api", sets, skippedByEnv: [], shared: [] }] };
}

const ROWS = [
  { name: "1000_app_demo", d1: [{ database: "app", table: "things", rows: 2 }], kv: [], r2: [], media: [] },
];

/** A fresh clone: nothing minted, migrations pending, no ports, an empty database. */
function freshClone(log: string[], overrides: SetupSteps = {}): SetupSteps {
  const record =
    <T>(name: string, value: T) =>
    async () => {
      log.push(name);
      return value;
    };
  return {
    install: record("install", {
      packageManager: "bun",
      lockfile: "bun.lock",
      command: "bun",
      args: ["install", "--frozen-lockfile"],
    }),
    planInstall: record("planInstall", {
      packageManager: "bun",
      lockfile: "bun.lock",
      command: "bun",
      args: ["install", "--frozen-lockfile"],
    }),
    check: record("check", { project: "acme", workers: [] }),
    mint: async ({ dryRun }) => {
      log.push(dryRun ? "planMint" : "mint");
      return {
        path: SECRETS,
        minted: ["SECRETS_ENCRYPTION_KEYS", "auth-session-secret"],
        adopted: [],
        refused: [],
      } satisfies MintReport;
    },
    migrate: record("migrate", ["0100_secrets_0001_init"]),
    planMigrate: record("planMigrate", [
      {
        env: "dev",
        worker: "api",
        database: "secrets",
        binding: "SECRETS",
        name: "0100_secrets_0001_init",
        direction: "up" as const,
      },
    ]),
    prepare: async ({ dryRun }) => {
      log.push(dryRun ? "planPrepare" : "prepare");
      return prepared({ allocated: true, devVars: dryRun ? [] : [`${DIR}/apps/api`] });
    },
    held: record("held", [] as HeldTable[]),
    seed: async ({ dryRun, account }) => {
      log.push(dryRun ? "planSeed" : "seed");
      expect(account).toBeNull();
      return seedReport(ROWS, dryRun);
    },
    external: record("external", ["auth-github-client-secret"]),
    ...overrides,
  };
}

function report(result: SetupResult): SetupReport {
  if (isBlockedPlan(result)) throw new Error("expected a full report");
  return result;
}

describe("setupCheckout", () => {
  test("a fresh clone runs every step, in order, and says what changed", async () => {
    const log: string[] = [];

    const result = report(await setupCheckout({ projectDir: DIR, account: null, steps: freshClone(log) }));

    expect(log).toEqual(["install", "check", "mint", "migrate", "prepare", "held", "planSeed", "seed", "external"]);
    expect(result.changed).toBe(true);
    expect(result.seed).toEqual({ state: "seeded" });
    expect(result.external).toEqual(["auth-github-client-secret"]);
    expect(result.secrets.minted).toEqual(["SECRETS_ENCRYPTION_KEYS", "auth-session-secret"]);
  });

  test("a check that fails stops the run before any step writes, and names the failure", async () => {
    const log: string[] = [];
    const steps = freshClone(log, {
      check: async () => {
        log.push("check");
        throw new ValidationError({ message: "The project check failed, so setup stopped before writing anything." });
      },
    });

    await expect(setupCheckout({ projectDir: DIR, account: null, steps })).rejects.toThrow("The project check failed");
    expect(log).toEqual(["install", "check"]);
  });

  test("a database holding rows is not seeded, and the run says which table", async () => {
    const log: string[] = [];
    const held = [{ worker: "api", binding: "DB", table: "pithy_auth_users" }];
    const steps = freshClone(log, { held: async () => held });

    const result = report(await setupCheckout({ projectDir: DIR, account: null, steps }));

    expect(log).not.toContain("seed");
    expect(log).not.toContain("planSeed");
    expect(result.seed).toEqual({ state: "held", held });
  });

  test("a seed that uploads media is not run: it would reach an account", async () => {
    const log: string[] = [];
    const media = [
      {
        name: "1000_app_media",
        d1: [],
        kv: [],
        r2: [],
        media: [{ store: "images" as const, mode: "once" as const, action: "upload" as const }],
      },
    ];
    const steps = freshClone(log, {
      seed: async ({ dryRun }) => {
        log.push(dryRun ? "planSeed" : "seed");
        return seedReport(media, dryRun);
      },
    });

    const result = report(await setupCheckout({ projectDir: DIR, account: null, steps }));

    expect(log).not.toContain("seed");
    expect(result.seed).toEqual({ state: "media" });
  });

  test("a second run changes nothing and says so", async () => {
    const log: string[] = [];
    const steps = freshClone(log, {
      mint: async () => ({ path: SECRETS, minted: [], adopted: [], refused: [] }),
      migrate: async () => [],
      prepare: async () => prepared(),
      held: async () => [{ worker: "api", binding: "DB", table: "things" }],
    });

    const result = report(await setupCheckout({ projectDir: DIR, account: null, steps }));

    expect(result.changed).toBe(false);
  });

  test("a seed whose sets wrote nothing has not seeded, and is no change", async () => {
    const log: string[] = [];
    const empty = [{ name: "9999_auth_devSession", d1: [], kv: [], r2: [], media: [] }];
    const steps = freshClone(log, {
      mint: async () => ({ path: SECRETS, minted: [], adopted: [], refused: [] }),
      migrate: async () => [],
      prepare: async () => prepared(),
      seed: async ({ dryRun }) => seedReport(empty, dryRun),
    });

    const result = report(await setupCheckout({ projectDir: DIR, account: null, steps }));

    expect(result.seed).toEqual({ state: "none" });
    expect(result.changed).toBe(false);
  });

  test("--skip-install skips the install and nothing else", async () => {
    const log: string[] = [];

    const result = report(
      await setupCheckout({ projectDir: DIR, account: null, install: false, steps: freshClone(log) }),
    );

    expect(log[0]).toBe("check");
    expect(result.install).toBeNull();
  });

  test("a dry run plans every step and runs none of the writing ones", async () => {
    const log: string[] = [];

    const result = report(
      await setupCheckout({ projectDir: DIR, account: null, dryRun: true, steps: freshClone(log) }),
    );

    expect(log).toEqual([
      "planInstall",
      "check",
      "planMint",
      "planMigrate",
      "planPrepare",
      "held",
      "planSeed",
      "external",
    ]);
    expect(result.changed).toBe(false);
    expect(result.seed).toEqual({ state: "planned" });

    const plan = setupPlan(DIR, result);
    expect(plan.secrets.map((secret) => secret.name)).toEqual(["SECRETS_ENCRYPTION_KEYS", "auth-session-secret"]);
    expect(plan.files.map((file) => file.path)).toContain(".dev.config.json");
    expect(plan.files.map((file) => file.path)).toContain("apps/api/.dev.vars");
    expect(plan.data).toEqual([{ worker: "api", store: "d1", target: "app.things", count: 2, action: "write" }]);
    expect(plan.notes).toContain("Runs bun install --frozen-lockfile, which never rewrites bun.lock.");
    expect(plan.migrations.map((migration) => migration.name)).toEqual(["0100_secrets_0001_init"]);
  });

  test("a dry run on a clone with nothing installed plans the install and says why it stopped", async () => {
    const log: string[] = [];
    const steps = freshClone(log, {
      check: async () => {
        throw new ValidationError({ message: "Cannot find package '@pithy-sh/auth'.", action: "Install it." });
      },
    });

    const result = await setupCheckout({ projectDir: DIR, account: null, dryRun: true, steps });

    expect(isBlockedPlan(result)).toBe(true);
    expect(result).toMatchObject({ blocked: "Cannot find package '@pithy-sh/auth'. Install it." });
  });
});
