// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { migrateProject } from "../migrations/run";
import { loadProject, requireProjectName } from "../project/config";
import { detectPackageManager, type InstallRunner } from "../project/packageManager";
import type { WorkerTarget } from "../project/workers";
import { seedProject } from "../seed/run";
import type { DevConfig } from "./devConfig";
import { syncFeatureDevConfig } from "./sync";
import { createWorktree, defaultGit, type GitRunner } from "./worktree";

/**
 * `pithy feature create` — the local, automatic half of the lifecycle, run from the main checkout. It
 * creates the branch + worktree (the proven core), reserves a non-overlapping port block and pins one port
 * per worker into the worktree's `.dev.config.json`, wires every worker's `.dev.vars` to the repo's one
 * shared file, installs deps with the adopter's package manager, then migrates and seeds the local Miniflare
 * backend. No Cloudflare spend — a working local env, ready for `pithy dev`, from one command.
 */

/** A local/dev backend step (migrate or seed) — a seam so create is testable without Miniflare. */
export type LocalRunner = (args: { projectDir: string }) => Promise<void>;

// A `dev` migrate names its project too: the local Miniflare store lives at the project root and is
// shared with `wrangler dev`, and this is usually the run that first stamps it. An unstamped database is
// one any project can later claim, so the first write is the only chance to record the owner.
const localMigrate: LocalRunner = async ({ projectDir }) => {
  const project = requireProjectName(await loadProject(projectDir));
  await migrateProject({ env: "dev", projectDir, project });
};

// Even a `dev` seed names its project: Cloudflare Images and Stream have no local emulation, so a media
// fixture here writes into the same account-wide store production shares, and only the ownership metadata
// says who put it there.
const localSeed: LocalRunner = async ({ projectDir }) => {
  const project = requireProjectName(await loadProject(projectDir));
  await seedProject({ env: "dev", projectDir, project, json: true });
};

/** The structured outcome of `pithy feature create` — the `--json` payload and the human summary source. */
export interface CreateReport {
  /** The command that produced the report. */
  command: "feature.create";
  /** The feature branch created or attached. */
  branch: string;
  /** The absolute worktree path. */
  worktree: string;
  /** Whether a new worktree was created (false on an idempotent re-run over an existing one). */
  created: boolean;
  /** The feature's dev config — its reserved port block and each worker's pinned endpoint. */
  dev: DevConfig;
  /** Whether local migrations ran. */
  migrated: boolean;
  /** Whether the local seed ran. */
  seeded: boolean;
}

/** Options for {@link createFeature}. */
export interface CreateFeatureOptions {
  /** The main checkout root — where `.dev-ports.json` and the source `.dev.vars` live. */
  projectDir: string;
  /** The issue number. */
  issue: string;
  /** The kebab-case slug. */
  slug: string;
  /** Skip the dependency install (tests set this; a real run installs so the gates run in the tree). */
  skipInstall?: boolean;
  /** Ports per feature block (defaults to the registry's block size). */
  blockSize?: number;
  /** git runner seam. */
  git?: GitRunner;
  /** Install runner seam. */
  install?: InstallRunner;
  /** Local migrate seam (default: `migrateProject` against dev). */
  migrate?: LocalRunner;
  /** Local seed seam (default: `seedProject` against dev). */
  seed?: LocalRunner;
  /** Worker-discovery seam (default: `discoverWorkers`), so tests fix the worker set. */
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
}

/**
 * Stand up a feature's local environment. Creates the worktree, reserves its port block and pins one port
 * per worker into `.dev.config.json`, wires `.dev.vars` to the shared file, installs deps (unless skipped),
 * then migrates and seeds the local backend. Idempotent: a re-run reuses the existing worktree, keeps its
 * port block (so every worker's address is stable for the life of the feature), and re-runs migrate/seed
 * harmlessly.
 */
export async function createFeature(options: CreateFeatureOptions): Promise<CreateReport> {
  const git = options.git ?? defaultGit;
  const worktree = await createWorktree({ issue: options.issue, slug: options.slug, git });

  // Install before discovering workers so a freshly-cut worktree has its dependencies in place.
  if (!options.skipInstall) {
    const pm = await detectPackageManager(worktree.wtPath);
    const installer = options.install ?? defaultInstall;
    await installer(pm, ["install"], worktree.wtPath);
  }

  // Reserve the block, pin every worker's port, and wire `.dev.vars` — the same reconciliation
  // `pithy feature sync` runs, so creating and later adding a worker go through one implementation.
  const { dev } = await syncFeatureDevConfig({
    mainRoot: worktree.root,
    worktreePath: worktree.wtPath,
    branch: worktree.branch,
    ...(options.blockSize !== undefined ? { blockSize: options.blockSize } : {}),
    ...(options.discoverWorkers !== undefined ? { discoverWorkers: options.discoverWorkers } : {}),
  });

  // Migrate and seed run against the **worktree**, and discover its Workers themselves: the branch being
  // created is what decides which Workers exist and what each composes, and it may already differ from the
  // main checkout this command was run in.
  const migrate = options.migrate ?? localMigrate;
  const seed = options.seed ?? localSeed;
  await migrate({ projectDir: worktree.wtPath });
  await seed({ projectDir: worktree.wtPath });

  return {
    command: "feature.create",
    branch: worktree.branch,
    worktree: worktree.wtPath,
    created: worktree.created,
    dev,
    migrated: true,
    seeded: true,
  };
}

/** The default install runner — spawn the detected package manager. Lazy import keeps it out of the seam type. */
const defaultInstall: InstallRunner = async (command, args, cwd) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(command, args, { cwd });
};
