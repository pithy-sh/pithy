// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import type { CreateReport } from "../feature/create";
import { portsRegistryPath } from "../feature/ports";
import type { PruneReport } from "../feature/prune";
import type { SyncReport } from "../feature/sync";
import { Plan } from "../plan/plan";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What `pithy feature create`, `sync` and `prune` write under `--json`, held to the schemas `pithy schema
 * feature` publishes (#697).**
 *
 * Each one's work — a git worktree, a port block, a registry sweep — is its own module's and its own tests'.
 * It is replaced here by the report it returns, typed as it returns it, so what runs is the command's own
 * body: the flag checks, the trunk's distance from its remote, the renames into the published keys.
 * `destroy` is held to its schema from the real binary in `feature/destroyBranch.e2e.test.ts`.
 */

const DEV = {
  version: 1,
  branch: "feature/12-media-cli",
  ports: { index: 1, base: 8807, size: 20 },
  workers: { "acme-api": { port: 8807, origin: "http://localhost:8807" } },
} as const;

const reports = vi.hoisted(() => ({ base: "main" as string | null }));

vi.mock("../feature/slugBudget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/slugBudget")>()),
  assertFeatureSlugFitsProject: async () => {},
}));
vi.mock("../feature/create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/create")>()),
  createFeature: async (): Promise<CreateReport> => ({
    command: "feature.create",
    branch: DEV.branch,
    worktree: "/home/you/acme/.worktrees/12-media-cli",
    worktreeCreated: reports.base !== null,
    base: reports.base,
    dev: { ...DEV, workers: { ...DEV.workers } },
  }),
}));
vi.mock("../feature/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/worktree")>()),
  behindRemote: async () => 2,
  mainRepoRoot: async () => "/home/you/acme",
}));
vi.mock("../feature/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/identity")>()),
  deriveIdentityFromBranch: async () => ({ branch: DEV.branch, issue: "12", slug: "media-cli" }),
}));
vi.mock("../feature/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/sync")>()),
  syncFeatureDevConfig: async (): Promise<SyncReport> => ({
    branch: DEV.branch,
    block: { block: 1, base: 8807, size: 20 },
    dev: { ...DEV, workers: { ...DEV.workers } },
    added: ["acme-api"],
    removed: [],
  }),
}));
vi.mock("../feature/prune", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/prune")>()),
  pruneFeatureBlocks: async (options: { dryRun: boolean }): Promise<PruneReport> => ({
    root: "/home/you/acme",
    dryRun: options.dryRun,
    freedBlocks: [{ branch: "feature/9-gone", block: 2, base: 8827, size: 20 }],
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pithy feature --json conforms to its published payloads", () => {
  test("create, cut from a trunk and attached to an existing branch", async () => {
    await expectConforms(
      "feature create",
      await runCaptured("feature create", ["media-cli", "--issue", "12", "--json"]),
    );
    reports.base = null;
    await expectConforms(
      "feature create",
      await runCaptured("feature create", ["media-cli", "--issue", "12", "--json"]),
    );
  });

  test("sync, ports only", async () => {
    await expectConforms("feature sync", await runCaptured("feature sync", ["--skip-data", "--json"]));
  });

  test("prune, for real and as a dry run", async () => {
    await expectConforms("feature prune", await runCaptured("feature prune", ["--json"]));
    await expectConforms("feature prune", await runCaptured("feature prune", ["--dry-run", "--json"]));
  });

  test("prune --dry-run carries the one plan every dry run shares, and a real run carries none", async () => {
    // The plan key is optional in the published schema, so conforming alone would pass a dry run that lost
    // it. The block the stub frees is the one edit to the machine's port registry.
    const planned = JSON.parse((await runCaptured("feature prune", ["--dry-run", "--json"])).join("")) as {
      dryRun: boolean;
      plan?: unknown;
    };
    expect(planned.dryRun).toBe(true);
    expect(Plan.parse(planned.plan).files).toEqual([
      { path: portsRegistryPath(), action: "edit", changes: ["Frees 8827–8846, feature/9-gone."] },
    ]);

    const real = JSON.parse((await runCaptured("feature prune", ["--json"])).join("")) as Record<string, unknown>;
    expect(real.dryRun).toBe(false);
    expect("plan" in real).toBe(false);
  });
});
