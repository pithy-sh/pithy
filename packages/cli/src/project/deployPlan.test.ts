// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { Plan, type PlanMigration } from "../plan/plan";
import { EXIT } from "../terminal/exitClass";
import { type DeployPlanInput, deployPlan, deployPlanExit, readPendingForPlan } from "./deployPlan";

/**
 * **`pithy deploy --dry-run`'s plan, assembled (#697).** Deploy uploads Workers and does nothing else, so the
 * plan's `resources` are the uploads — each app Worker whose bundle `wrangler deploy --dry-run` accepted, and
 * each kit Worker whose stamp says it would ship. What a deploy does not do itself is said in `notes`: the
 * migrations it leaves to `pithy migrate`. Those are never `plan.migrations`, which is what a command would
 * apply, and deploy applies none. A binding with no id is not here: the dry run refuses on it as the deploy
 * does (`commands/deployDryRun.test.ts`).
 */

const MIGRATION: PlanMigration = {
  env: "staging",
  worker: "api",
  database: "app",
  binding: "DB",
  name: "1000_app_0001_things",
  direction: "up",
};

/** A dry run with nothing to say, varied per case. */
function input(overrides: Partial<DeployPlanInput> = {}): DeployPlanInput {
  return {
    env: "staging",
    pending: { state: "read", migrations: [] },
    deploys: [],
    kit: null,
    ...overrides,
  };
}

describe("deployPlan", () => {
  test("each app Worker whose bundle wrangler accepted is an upload, and a failed one is not", () => {
    const plan = deployPlan(
      input({
        deploys: [
          { name: "acme-staging-api", ok: true },
          { name: "acme-staging-web", ok: false, built: false, error: "build failed" },
        ],
      }),
    );
    expect(Plan.parse(plan)).toEqual(plan);
    expect(plan.resources).toEqual([{ kind: "worker", name: "acme-staging-api", env: "staging", action: "upload" }]);
    expect(plan.files).toEqual([]);
    expect(plan.migrations).toEqual([]);
  });

  test("a bare deploy's uploads name no environment", () => {
    expect(deployPlan(input({ env: undefined, deploys: [{ name: "acme-api", ok: true }] })).resources).toEqual([
      { kind: "worker", name: "acme-api", action: "upload" },
    ]);
  });

  test("each kit Worker the stamp says would ship is an upload, with the run's reason", () => {
    const plan = deployPlan(
      input({
        kit: {
          workers: [{ capability: "media", worker: "acme-staging-media", outcome: "unchanged", reason: "current" }],
          problems: [],
          planned: [{ capability: "email", worker: "acme-staging-email", reason: "It was not on the account." }],
        },
      }),
    );
    expect(plan.resources).toEqual([
      {
        kind: "worker",
        name: "acme-staging-email",
        env: "staging",
        action: "upload",
        reason: "It was not on the account.",
      },
    ]);
  });

  test("pending migrations are a note naming each one and the command that applies them, never plan.migrations", () => {
    const plan = deployPlan(
      input({ pending: { state: "read", migrations: [MIGRATION, { ...MIGRATION, name: "1000_app_0002_more" }] } }),
    );
    expect(plan.migrations).toEqual([]);
    expect(plan.notes).toEqual([
      "2 migrations unapplied for staging: 1000_app_0001_things, 1000_app_0002_more. Deploy does not migrate — run pithy migrate --env staging.",
    ]);
  });

  test("one pending migration reads in the singular, and none says nothing", () => {
    expect(deployPlan(input({ pending: { state: "read", migrations: [MIGRATION] } })).notes).toEqual([
      "1 migration unapplied for staging: 1000_app_0001_things. Deploy does not migrate — run pithy migrate --env staging.",
    ]);
    expect(deployPlan(input()).notes).toEqual([]);
  });

  test("a ledger it could not read is said, with why", () => {
    expect(deployPlan(input({ pending: { state: "unread", reason: "DB has no id." } })).notes).toEqual([
      "Pending migrations for staging were not read. DB has no id.",
    ]);
  });

  test("a bare deploy reads no ledger, and says nothing about one", () => {
    expect(deployPlan(input({ env: undefined, pending: { state: "skipped" } })).notes).toEqual([]);
  });
});

describe("deployPlanExit", () => {
  test("a plan the deploy could carry out exits 0", () => {
    expect(deployPlanExit(input({ deploys: [{ name: "acme-staging-api", ok: true }] }))).toBe(EXIT.ok);
  });

  test("a bundle that did not build fails the dry run, as it would fail the deploy", () => {
    expect(deployPlanExit(input({ deploys: [{ name: "acme-staging-api", ok: false, error: "boom" }] }))).toBe(
      EXIT.failed,
    );
  });

  test("a kit half the deploy would fail fails it too", () => {
    expect(deployPlanExit(input({ kit: { workers: [], problems: ["unreadable"], planned: [] } }))).toBe(EXIT.failed);
  });
});

describe("readPendingForPlan", () => {
  test("the names the migrate plan reads", async () => {
    expect(await readPendingForPlan("staging", async () => [MIGRATION])).toEqual({
      state: "read",
      migrations: [MIGRATION],
    });
  });

  test("a read that throws is a reason, not a failed dry run — deploy never migrates", async () => {
    const read = async () => {
      throw new ValidationError({ message: "DB has no id.", action: "Run pithy provision --env staging --yes." });
    };
    expect(await readPendingForPlan("staging", read)).toEqual({
      state: "unread",
      reason: "DB has no id. Run pithy provision --env staging --yes.",
    });
  });

  test("a bare deploy reads nothing", async () => {
    const read = async (): Promise<PlanMigration[]> => {
      throw new Error("A bare deploy read a ledger.");
    };
    expect(await readPendingForPlan(undefined, read)).toEqual({ state: "skipped" });
  });
});
