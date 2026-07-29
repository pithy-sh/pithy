import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { devConfigPath, readDevConfig } from "../feature/devConfig";
import { wireFeatureDevVars } from "../feature/devVars";
import { syncFeatureDevConfig } from "../feature/sync";
import { defaultGit, type GitRunner, mainRepoRoot } from "../feature/worktree";
import { detectPackageManager } from "./packageManager";
import { scaffoldWorker } from "./workerScaffold";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "./workers";

const run = promisify(execFile);

/** Discover-workers seam, defaulted to the real discovery so tests can fix the worker set. */
type DiscoverWorkers = (projectDir: string) => Promise<WorkerTarget[]>;
/** Workspace-install seam, defaulted to the detected package manager's bare `install`. */
export type WorkspaceInstall = (projectDir: string) => Promise<void>;

/** A bare `<pm> install` at the project root — relinks the workspace so a new `apps/<name>` is picked up. */
const defaultInstall: WorkspaceInstall = async (projectDir) => {
  const pm = await detectPackageManager(projectDir);
  try {
    await run(pm, ["install"], { cwd: projectDir });
  } catch (cause) {
    throw new InternalError({
      message: `${pm} install failed after scaffolding the worker.`,
      action: `Run ${pm} install by hand in the project root.`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/** The current branch name, e.g. `feature/73-cli-commands` — the port registry's key for a feature worktree. */
async function currentBranch(git: GitRunner, cwd: string): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/** Shared seams every worker command accepts, so the flows are testable without git, install, or discovery. */
interface WorkerContext {
  /** The project root (a main checkout or a feature worktree). Defaults to `process.cwd()` at the call site. */
  projectDir: string;
  /** The main checkout root — where the port registry lives. Defaults to `mainRepoRoot()`. */
  mainRoot?: string;
  /** The feature branch. Defaults to the current branch. */
  branch?: string;
  git?: GitRunner;
  discoverWorkers?: DiscoverWorkers;
}

/**
 * Whether this project dir is a feature worktree (distinct from the main checkout) — where ports reconcile.
 * A project that is not a git repo yet (a fresh `pithy init` before `git init`) is not a worktree: resolving
 * the main root would fail, so we treat the project dir as its own root and skip the port reconcile. Worker
 * scaffolding must never depend on git being set up.
 */
async function resolveRoots(ctx: WorkerContext): Promise<{ mainRoot: string; inWorktree: boolean }> {
  if (ctx.mainRoot !== undefined) return { mainRoot: ctx.mainRoot, inWorktree: ctx.projectDir !== ctx.mainRoot };
  const git = ctx.git ?? defaultGit;
  try {
    const mainRoot = await mainRepoRoot(git);
    return { mainRoot, inWorktree: ctx.projectDir !== mainRoot };
  } catch {
    return { mainRoot: ctx.projectDir, inWorktree: false };
  }
}

/** The outcome of {@link addWorker}: where it landed, its pinned port (when reconciled), and whether it was. */
export interface AddWorkerReport {
  name: string;
  dir: string;
  /** The port pinned for this worker, when run inside a feature worktree; null in a plain checkout. */
  port: number | null;
  /** Whether the feature's `.dev.config.json` was reconciled (only inside a worktree). */
  reconciled: boolean;
}

/** Options for {@link addWorker}. */
export interface AddWorkerOptions extends WorkerContext {
  name: string;
  skipInstall?: boolean;
  install?: WorkspaceInstall;
}

/**
 * Scaffold `apps/<name>/` and wire it into the project — the logic behind `pithy worker add`. Additive: the
 * root worker and every sibling are untouched. Inside a feature worktree it reconciles the feature's
 * `.dev.config.json` (the new worker takes the lowest free port in the reserved block, every existing worker
 * keeps its port) and re-links `.dev.vars`. In a plain main checkout there is no port block yet — it only
 * links `.dev.vars`; ports are assigned when `pithy feature create`/`sync` runs.
 */
export async function addWorker(options: AddWorkerOptions): Promise<AddWorkerReport> {
  const { dir } = await scaffoldWorker({ projectDir: options.projectDir, name: options.name });

  if (!options.skipInstall) await (options.install ?? defaultInstall)(options.projectDir);

  const discoverWorkers = options.discoverWorkers ?? discoverWorkersDefault;
  const { mainRoot, inWorktree } = await resolveRoots(options);

  if (!inWorktree) {
    // No feature port block in a plain checkout — just link the new worker's .dev.vars at the shared file.
    await wireFeatureDevVars({
      mainRoot,
      worktreePath: options.projectDir,
      workers: await discoverWorkers(options.projectDir),
    });
    return { name: options.name, dir, port: null, reconciled: false };
  }

  const branch = options.branch ?? (await currentBranch(options.git ?? defaultGit, options.projectDir));
  const report = await syncFeatureDevConfig({
    mainRoot,
    worktreePath: options.projectDir,
    branch,
    discoverWorkers,
  });
  return { name: options.name, dir, port: report.dev.workers[options.name]?.port ?? null, reconciled: true };
}

/** One row of {@link listWorkers}: a worker's name, dir, whether it autostarts, and its pinned dev port. */
export interface WorkerListing {
  name: string;
  dir: string;
  autostart: boolean;
  hasWrangler: boolean;
  /** The port pinned in `.dev.config.json`, or null when none is assigned (a plain checkout, or unassigned). */
  port: number | null;
}

/** List the discovered workers with their autostart state and pinned dev port — the logic behind `pithy worker list`. */
export async function listWorkers(options: WorkerContext): Promise<WorkerListing[]> {
  const discoverWorkers = options.discoverWorkers ?? discoverWorkersDefault;
  const workers = await discoverWorkers(options.projectDir);
  const config = await readDevConfig(devConfigPath(options.projectDir));
  return workers.map((worker) => ({
    name: worker.name,
    dir: worker.dir,
    autostart: worker.dev?.autostart ?? true,
    hasWrangler: worker.hasWrangler !== false,
    port: config?.workers[worker.name]?.port ?? null,
  }));
}

/** The outcome of {@link removeWorker}: what was deleted and whether the feature's ports were reconciled. */
export interface RemoveWorkerReport {
  name: string;
  dir: string;
  reconciled: boolean;
}

/** Options for {@link removeWorker}. */
export interface RemoveWorkerOptions extends WorkerContext {
  name: string;
}

/**
 * Delete `apps/<name>/` and release its port — the logic behind `pithy worker remove`. `apps/<name>` is a
 * plain directory (not a git worktree), so a recursive delete is safe here; the `rm -rf`/inotify caveat in
 * the docs is about worktrees, which this is not. Inside a feature worktree the reconcile returns the freed
 * port to the block via the sticky assignment every existing worker keeps.
 */
export async function removeWorker(options: RemoveWorkerOptions): Promise<RemoveWorkerReport> {
  const discoverWorkers = options.discoverWorkers ?? discoverWorkersDefault;
  const appsDir = join(options.projectDir, "apps");
  // Resolve the target from the discovered set — matched by the name `worker list` shows OR its apps/<dir>
  // basename — so a worker whose wrangler `name` differs from its directory is still removable. Restricted to
  // `apps/*`, which also means the root worker (its dir is the project root) can never be removed here.
  const workers = await discoverWorkers(options.projectDir);
  const target = workers.find(
    (worker) =>
      dirname(worker.dir) === appsDir && (worker.name === options.name || basename(worker.dir) === options.name),
  );
  if (!target) {
    throw new NotFoundError({
      message: `No worker named "${options.name}" under apps/.`,
      action: "Run pithy worker list to see the workers this project has.",
    });
  }

  await rm(target.dir, { recursive: true, force: true });

  const { mainRoot, inWorktree } = await resolveRoots(options);
  if (!inWorktree) return { name: target.name, dir: target.dir, reconciled: false };

  const branch = options.branch ?? (await currentBranch(options.git ?? defaultGit, options.projectDir));
  await syncFeatureDevConfig({ mainRoot, worktreePath: options.projectDir, branch, discoverWorkers });
  return { name: target.name, dir: target.dir, reconciled: true };
}
