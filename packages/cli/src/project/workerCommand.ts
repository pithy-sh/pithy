// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { generateDevVars } from "../devSecrets/generate";
import { devConfigPath, readDevConfig } from "../feature/devConfig";
import { syncFeatureDevConfig } from "../feature/sync";
import { defaultGit, type GitRunner, mainRepoRoot } from "../feature/worktree";
import { loadProject, projectCloudflareAccount, requireProjectName } from "./config";
import { detectPackageManager } from "./packageManager";
import { ensureScaffoldPath, pathExists, removeScaffoldPath, WORKER_NAME } from "./scaffold";
import { scaffoldWorker } from "./workerScaffold";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "./workers";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

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
      // The worker is rolled back, so "run the install by hand" would point at a workspace that no
      // longer has the package in it. The retry is the command itself.
      message: `${pm} install failed, so the worker was not added.`,
      action: `Fix the install, then run pithy worker add again — or pass --skip-install and run ${pm} install later.`,
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
  /**
   * One sentence per Worker whose `.dev.vars` this run did not generate — a file pithy did not write, or
   * a directory it may not write into. This command regenerates *every* Worker it discovers, not just the
   * new one, so a sibling that will not get its bindings is a fact about the project the adopter has to
   * be told. `pithy dev` names it on every run; the command that adds the Worker used to say nothing.
   */
  devVarsRefused: string[];
}

/** Options for {@link addWorker}. */
export interface AddWorkerOptions extends WorkerContext {
  name: string;
  skipInstall?: boolean;
  install?: WorkspaceInstall;
}

/**
 * Everything `pithy worker add` does once `apps/<name>/` exists: generate the Worker's `.dev.vars`, take a
 * port when there is a block to take one from, relink the workspace, and report what it could not write.
 *
 * **The install goes last.** It used to run first, and it is the one step here that reaches the network —
 * so when it threw, the `.dev.vars` step below it never ran and every worker after the first came out
 * without the file `pithy init` promises every worker has. Ordering fixes that outright: by the time an
 * install can fail, there is nothing left for it to skip.
 */
async function wireAddedWorker(options: AddWorkerOptions, dir: string): Promise<AddWorkerReport> {
  const discoverWorkers = options.discoverWorkers ?? discoverWorkersDefault;
  const { mainRoot, inWorktree } = await resolveRoots(options);

  let port: number | null = null;
  let reconciled = false;
  if (inWorktree) {
    const branch = options.branch ?? (await currentBranch(options.git ?? defaultGit, options.projectDir));
    const report = await syncFeatureDevConfig({ mainRoot, worktreePath: options.projectDir, branch, discoverWorkers });
    port = report.dev.workers[options.name]?.port ?? null;
    reconciled = true;
  }

  // Generated, not linked (#154). The new Worker needs a `.dev.vars` beside it because that is where
  // wrangler reads one; every sibling is regenerated in the same pass because generation is idempotent by
  // content and a run that changes nothing writes no bytes. The refusals come back because `SyncReport`
  // does not carry them, and dropping that list was how a Worker with no bindings went unmentioned by the
  // command that made it.
  const devVars = await generateDevVars({
    projectDir: options.projectDir,
    workerDirs: (await discoverWorkers(options.projectDir)).map((worker) => worker.dir),
  });

  if (!options.skipInstall) await (options.install ?? defaultInstall)(options.projectDir);
  return { name: options.name, dir, port, reconciled, devVarsRefused: devVars.refused };
}

/**
 * Scaffold `apps/<name>/` and wire it into the project — the logic behind `pithy worker add`. Additive: the
 * root worker and every sibling are untouched. Inside a feature worktree it reconciles the feature's
 * `.dev.config.json` (the new worker takes the lowest free port in the reserved block, every existing worker
 * keeps its port) and re-links `.dev.vars`. In a plain main checkout there is no port block yet — it only
 * links `.dev.vars`; ports are assigned when `pithy feature create`/`sync` runs.
 *
 * **All-or-nothing.** Anything that fails after the directory is made rolls it back, so the same command
 * works on the retry. It used to leave the half-made `apps/<name>` behind, and `scaffoldWorker` refuses a
 * directory holding anything at all — so the failure blocked its own retry, and `rm -rf` by hand was the
 * only way forward. Rolled back rather than resumed, deliberately: `apps/<name>` is a directory pithy owns
 * outright and fills in one pass, so nothing in it is ever the adopter's and removing it destroys nothing
 * they wrote. Resuming would mean deciding whether a non-empty `apps/<name>` is our half-made worker or
 * their directory — and after they have opened an editor in it, those look identical. Guessing wrong there
 * overwrites their file, which is a worse failure than the one being fixed.
 *
 * The feature's `.dev.config.json` may name the rolled-back worker until the next reconcile. It is derived
 * state, rebuilt from the workers actually present on every `feature sync`, `worker add` and `worker
 * remove`, and `pithy dev` starts the discovered set rather than the pinned one — so a stale entry starts
 * nothing and costs the feature one port until it is next reconciled away.
 */
export async function addWorker(options: AddWorkerOptions): Promise<AddWorkerReport> {
  // The project comes from the root config, through `requireProjectName` — never the directory basename.
  // It is stamped into the new Worker's `PROJECT` var, and that stamp has to be the same string every
  // command composes resource names from, or the Worker's Images/Stream assets land under an owner
  // nothing sweeps. A project with no `name` is refused here rather than scaffolding a Worker that
  // cannot mint an attributable upload.
  const project = requireProjectName(await loadProject(options.projectDir));
  const { dir } = await scaffoldWorker({ projectDir: options.projectDir, name: options.name, project });

  try {
    return await wireAddedWorker(options, dir);
  } catch (cause) {
    // Only `dir`, and only the one this call just created — never a sibling, and never a path that was
    // there before `scaffoldWorker` ran, which it would have refused.
    //
    // Gated even here (#158): a rollback is still a recursive delete of a path built out of a name, and
    // "we made it a moment ago" is an assumption about a tree that another process shares. A refusal is
    // swallowed rather than thrown, because it would replace the failure being reported with a second
    // one — and `scaffoldWorker` already refused every layout this gate catches, so a refusal at this
    // point means the tree changed mid-run and the original cause is still the more useful answer.
    await removeScaffoldPath(options.projectDir, dir).catch(() => {});
    throw cause;
  }
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

  // Gated, and the gate is stricter than the one a write gets (#158). `target.dir` is `apps/<name>`,
  // composed from a name and handed to a recursive delete: a symlink at `apps` carried that delete onto a
  // canary tree outside the project, reproduced with the real CLI, and the command said "Done."
  await removeScaffoldPath(options.projectDir, target.dir);

  const { mainRoot, inWorktree } = await resolveRoots(options);
  if (!inWorktree) return { name: target.name, dir: target.dir, reconciled: false };

  const branch = options.branch ?? (await currentBranch(options.git ?? defaultGit, options.projectDir));
  await syncFeatureDevConfig({ mainRoot, worktreePath: options.projectDir, branch, discoverWorkers });
  return { name: target.name, dir: target.dir, reconciled: true };
}

/**
 * The `wrangler.jsonc` keys a rename rewrites: the deployed script name, and the `WORKER` var in every
 * environment stanza. Everything else in the file belongs to the adopter and is left exactly as it is.
 */
interface RenamableWrangler {
  name?: string;
  vars?: Record<string, string | undefined>;
  env?: Record<string, RenamableWrangler | undefined>;
}

/**
 * The script name a worker called `to` would deploy under, given the one it deploys under as `from` —
 * `null` when the current name does not carry the worker segment at all.
 *
 * `scaffoldWorker` writes `<project>-<worker>`, so the worker is the trailing segment and only that
 * segment moves. A name that does not end in it (`my-service`, brought in from a Worker that predates the
 * project) was never composed from the worker's name, so there is nothing here to recompute: renaming it
 * would rename a Worker the adopter named themselves, and — deployed — strand it under a name pithy
 * invented.
 */
function renamedScript(declared: string, from: string, to: string): string | null {
  if (declared === from) return to;
  return declared.endsWith(`-${from}`) ? `${declared.slice(0, -from.length)}${to}` : null;
}

/**
 * Every script name the worker currently deploys under, in environment order.
 *
 * The top-level `name` is the dev script. A named environment takes `env.<name>.name` when it declares
 * one and wrangler's own default — `<name>-<env>` — when it does not, which is the case for every Worker
 * `pithy` scaffolds. These are the names the account is asked about: they are what a rename leaves behind.
 */
function deployedScriptNames(config: RenamableWrangler): string[] {
  const top = config.name;
  if (top === undefined) return [];
  const names = [top];
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    names.push(stanza?.name ?? `${top}-${env}`);
  }
  return names;
}

/** What the account said about the old worker's script names. */
export interface DeployedScripts {
  /** The script names that exist on the account. Empty when nothing does — or when nothing was asked. */
  live: string[];
  /**
   * Whether the account actually answered. `false` means unchecked, not clear: no credentials, an
   * offline laptop, or a token that would not list. A rename then proceeds saying so, rather than
   * claiming a check it never made.
   */
  checked: boolean;
}

/** The account seam — asked which of `scripts` are live, so a unit test never reaches Cloudflare. */
export type DeployedScriptProbe = (
  scripts: string[],
  account: CloudflareAccountSelection | null,
) => Promise<DeployedScripts>;

/**
 * Ask the account which of these script names are deployed. Never throws: every failure is `checked:
 * false`, because "I could not find out" and "nothing is there" must not become the same answer when the
 * difference decides whether a rename orphans a live Worker.
 */
export const probeDeployedScripts: DeployedScriptProbe = async (scripts, account) => {
  if (scripts.length === 0) return { live: [], checked: true };
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return { live: [], checked: false };
  try {
    // One listing, not one call per name: the account is asked once and the answer filtered locally.
    const live = await new CloudflareClients({ accountId, apiToken }).workers().listWorkers();
    const deployed = new Set(live.map((script) => script.id));
    return { live: scripts.filter((script) => deployed.has(script)), checked: true };
  } catch {
    return { live: [], checked: false };
  }
};

/** The outcome of {@link renameWorker}. */
export interface RenameWorkerReport {
  from: string;
  to: string;
  /** Where the worker now lives — `apps/<to>`. */
  dir: string;
  /** The deployed script name before and after, or `null` when it carried no worker segment to move. */
  script: { from: string; to: string } | null;
  /**
   * Script names left live on the account under the old name — non-empty only under `force`. Empty when
   * the account said nothing is there **and** when it said nothing at all; read it with `accountChecked`.
   */
  orphaned: string[];
  /** Whether the account answered. `false` → `orphaned` establishes nothing. */
  accountChecked: boolean;
  /** Whether the feature's `.dev.config.json` was reconciled (only inside a worktree). */
  reconciled: boolean;
}

/** Options for {@link renameWorker}. */
export interface RenameWorkerOptions extends WorkerContext {
  /** The worker to rename, by the name `worker list` shows or its `apps/<dir>` basename. */
  from: string;
  /** The new name — the directory, the script's worker segment, and the `WORKER` var. */
  to: string;
  /** Rename even though a script is live under the old name. It stays deployed, and the report says so. */
  force?: boolean;
  probeDeployed?: DeployedScriptProbe;
}

/**
 * Rename a worker — the logic behind `pithy worker rename`.
 *
 * **A worker's name is three strings, and they have to agree.** The directory `apps/<name>/`, which
 * tsconfig references and CI working-directories point at; the deployed script name in `wrangler.jsonc`
 * and `package.json`; and `vars.WORKER`, which is what separates two Workers' audit events when they
 * share a database. Renamed by hand, whichever one is missed fails quietly and in the worst possible
 * shape: the Worker deploys under one name and stamps its events with another.
 *
 * **A rename after a deploy is not a rename.** Resource names are computed rather than stored, so
 * `<project>-<env>-<binding>` survives untouched. The Worker script is not: it is named for the worker,
 * so a renamed worker deploys as a *new* script and leaves the old one live, serving, and billing. That
 * is refused rather than reported, and `force` is the way to say it is understood — the report then names
 * exactly what was left behind. When the account cannot be reached the rename proceeds with
 * `accountChecked: false`; declaring an unchecked account clear would be the one lie this guard cannot
 * afford.
 *
 * Not touched, deliberately: the app capability's `name` in `pithy.config.ts`. That is a **migration
 * namespace**, and it is stamped into every applied migration's row — moving it orphans the ledger and
 * re-runs every migration under a name the database has never seen.
 */
export async function renameWorker(options: RenameWorkerOptions): Promise<RenameWorkerReport> {
  // The same rule `scaffoldWorker` holds a new worker to, imported rather than restated: a name this
  // refuses is a directory `pithy worker add` could not have created in the first place.
  if (!WORKER_NAME.test(options.to)) {
    throw new ValidationError({
      message: `Worker name must be kebab-case (got "${options.to}").`,
      action: "Use lowercase words joined by hyphens, e.g. web or admin-api.",
    });
  }

  const discoverWorkers = options.discoverWorkers ?? discoverWorkersDefault;
  const appsDir = join(options.projectDir, "apps");
  // Resolved from the discovered set exactly as `removeWorker` resolves one — by the name `worker list`
  // shows OR the `apps/<dir>` basename — so a worker already half-renamed by hand is still addressable.
  const workers = await discoverWorkers(options.projectDir);
  const target = workers.find(
    (worker) =>
      dirname(worker.dir) === appsDir && (worker.name === options.from || basename(worker.dir) === options.from),
  );
  if (!target) {
    throw new NotFoundError({
      message: `No worker named "${options.from}" under apps/.`,
      action: "Run pithy worker list to see the workers this project has.",
    });
  }

  const to = join(appsDir, options.to);
  // **Both ends of the move, and the source is the one that was missing.** A rename reads its source path
  // as well as writing its destination, and `rename` on a symlink moves the *link* — so a link at
  // `apps/<from>` arrived at `apps/<to>` still pointing outside the project, and the `wrangler.jsonc` and
  // `package.json` rewrites below then went through it. Reproduced against a canary: `worker rename api
  // board` left `apps/board` a link and rewrote the canary's two files, reporting success. #164.
  //
  // The source is gated as a `move` rather than a `write`: nothing is scaffolded here, and telling an
  // adopter "the files would land outside the project" about a directory being moved is the same false
  // sentence a delete borrowing the write wording used to print.
  await ensureScaffoldPath(options.projectDir, target.dir, "move");
  // Safe first, then free. `ensureScaffoldPath` refuses a link at `apps` or at `apps/<to>` — `rename` onto
  // one is ENOTDIR, and this function had its own `exists()` over `access`, which follows the link and so
  // read a dangling one as "nothing there". The gate cleared, `rename` threw, and a raw node:fs stack trace
  // came out of a command whose `--json` callers parse `{"error":{…}}`. Reproduced against the real CLI.
  await ensureScaffoldPath(options.projectDir, to);
  // Then existence, checked against the filesystem rather than the discovered set: a directory holding
  // neither manifest nor `wrangler.jsonc` is not a worker, and moving a worker on top of it would still
  // destroy it. `pathExists` is `lstat`, shared with every other gate for the reason above.
  if (await pathExists(to)) {
    throw new ConflictError({
      message: `apps/${options.to} already exists.`,
      action: "Pick another name, or remove that directory first.",
    });
  }

  let config: RenamableWrangler;
  try {
    config = (await readWranglerConfig(target.dir)) as RenamableWrangler;
  } catch (cause) {
    throw new InternalError({
      message: `Could not read ${basename(target.dir)}'s wrangler.jsonc.`,
      action: "Fix the file, then run the rename again — this command edits it.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  // The account is asked before anything moves, and asked even under `force`: the point of the flag is to
  // proceed knowing what is being orphaned, which means the report still has to name it.
  const deployed = await (options.probeDeployed ?? probeDeployedScripts)(
    deployedScriptNames(config),
    await projectCloudflareAccount(options.projectDir),
  );
  if (deployed.live.length > 0 && !options.force) {
    throw new ConflictError({
      message: `${options.from} is deployed as ${deployed.live.join(", ")}.`,
      action:
        "A renamed worker deploys as a NEW script and leaves that one live and serving. Delete it first, or pass --force to rename anyway and orphan it.",
      detail: `Live scripts under the old name: ${deployed.live.join(", ")}.`,
    });
  }

  // A plain filesystem move, not `git mv`: a project need not be a git repo at all (`pithy worker add`
  // scaffolds into one that is not), and git reads a rename off the content anyway on the next `git add`.
  await rename(target.dir, to);

  const from = basename(target.dir);
  const declared = config.name;
  const renamed = declared === undefined ? null : renamedScript(declared, from, options.to);
  const script = declared !== undefined && renamed !== null ? { from: declared, to: renamed } : null;
  if (script) config.name = script.to;
  for (const stanza of [config, ...Object.values(config.env ?? {})]) {
    if (!stanza) continue;
    if (stanza !== config && stanza.name !== undefined) {
      // A stanza that names its own script gets the same treatment; one that does not inherits
      // wrangler's `<name>-<env>` default and so moved with the top-level name already.
      stanza.name = renamedScript(stanza.name, from, options.to) ?? stanza.name;
    }
    // Set, never added: a stanza that declares no `WORKER` declares nothing this rename can invalidate,
    // and inventing the var would put a binding-shaped opinion into a config that never asked for one.
    if (stanza.vars?.WORKER !== undefined) stanza.vars.WORKER = options.to;
  }
  await writeWranglerConfig(to, config);
  await renamePackage(to, from, options.to);

  const { mainRoot, inWorktree } = await resolveRoots(options);
  const report: RenameWorkerReport = {
    from,
    to: options.to,
    dir: to,
    script,
    orphaned: deployed.live,
    accountChecked: deployed.checked,
    reconciled: false,
  };
  if (!inWorktree) return report;

  const branch = options.branch ?? (await currentBranch(options.git ?? defaultGit, options.projectDir));
  await syncFeatureDevConfig({ mainRoot, worktreePath: options.projectDir, branch, discoverWorkers });
  return { ...report, reconciled: true };
}

/**
 * Move the worker's package name with it, by the same rule the script name moves. Written as plain JSON
 * (CLAUDE.md: `package.json` stays strict JSON), and a worker without one is simply left alone — a
 * non-Worker process in the dev set may have no package at all.
 */
async function renamePackage(dir: string, from: string, to: string): Promise<void> {
  const path = join(dir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const name = pkg.name;
  if (typeof name !== "string") return;
  const renamed = renamedScript(name, from, to);
  if (renamed === null) return;
  await writeFile(path, `${JSON.stringify({ ...pkg, name: renamed }, null, 2)}\n`);
}
