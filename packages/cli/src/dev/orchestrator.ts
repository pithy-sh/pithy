// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, spawn as spawnChild } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isContinuousIntegration } from "@pithy-sh/core/src/env/ci";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { findEntitlementGap } from "../capabilities/entitlementGap";
import { type GenerateDevVarsResult, generateDevVars } from "../devSecrets/generate";
import { renderDevSecretsNotes, renderDevVarsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, seedProjectDevSecrets } from "../devSecrets/seed";
import { localDevStateRoot } from "../devSecrets/store";
import {
  buildDevConfig,
  type DevConfig,
  devConfigPath,
  readDevConfig,
  scanPinnedBlocks,
  writeDevConfig,
} from "../feature/devConfig";
import {
  allocatePortBlock,
  type PortBlock,
  portsRegistryPath,
  reclaimPortBlocks,
  resolveMainRepoRoot,
} from "../feature/ports";
import { canonicalRepoPath } from "../feature/worktree";
import { allCapabilities, loadProject, loadWorkerConfig, requireProjectName } from "../project/config";
import { detectPackageManager, execArgs } from "../project/packageManager";
import { defaultWorkerDev } from "../project/workerManifest";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "../project/workers";
import { formatJsonLine } from "../terminal/output";
import { dim, workerColor } from "../terminal/style";
import { hasCloudflareLogin as defaultHasCloudflareLogin, deliveryFailureNote, deliveryPreflight } from "./delivery";
import { type DevLoginTarget, devLoginKeyAction, devLoginLines, readDevLogin as readDevLoginDefault } from "./devLogin";
import { devLoginTargets as devLoginTargetsDefault } from "./devLoginTargets";
import { buildWorkerEnv, startCommand, type WranglerLauncher } from "./env";
import {
  discoverHostWorkers as discoverHostWorkersDefault,
  type HostMaterialization,
  type HostWorker,
  type HostWorkerDiscovery,
  hostDeliveryIdentity,
  type MaterializeHostConfigsOptions,
  materializeHostConfigs as materializeHostConfigsDefault,
} from "./hostWorkers";
import { type KeyReader, readKeys as readKeysDefault } from "./keys";
import { type DataStream, stripAnsi, teeStream } from "./logging";
import { openUrl as openUrlDefault } from "./openUrl";
import {
  isAlive as isAliveDefault,
  type Sleep,
  sweepStaleDevPorts,
  type TryBind,
  tryBind as tryBindDefault,
  verifyPinnedPort,
} from "./ports";
import { type ReadyWatch, type Schedule, stillWaitingLines, watchReady } from "./readyWatch";
import { type DevState, devStatePath, readDevState, removeDevState, writeDevState } from "./state";

/** A spawned child, minimally what the orchestrator drives — satisfied by a real `ChildProcess` or a fake. */
export interface ChildLike {
  pid?: number;
  stdout: DataStream | null;
  stderr: DataStream | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  /** The spawn error channel (e.g. ENOENT when a `dev.command` binary is missing) — required so it is handled, not thrown. */
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** The spawn seam. Detached makes the child a process-group leader, so `kill(-pid)` tears down its subtree. */
export type SpawnDev = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; detached: boolean },
) => ChildLike;

/** A log destination — the terminal's tee'd copy in `logs/dev.log`, injectable so tests capture lines. */
export interface LogSink {
  write: (line: string) => void;
  end: () => Promise<void> | void;
}

/** Everything `startDev` needs, every dependency defaulted to its real implementation. */
/**
 * One Worker's entitlement composition gap: the gating source files, or empty when there is none. A
 * config that cannot be loaded yields no gap — `pithy dev` reports wiring, and a config that will not
 * load is wrangler's error to raise, not a reason to invent an entitlement warning.
 */
const defaultCheckEntitlements = async (workerDir: string): Promise<string[]> => {
  try {
    return await findEntitlementGap(workerDir, allCapabilities(await loadWorkerConfig(workerDir)));
  } catch {
    return [];
  }
};

/**
 * The project name every host's derived names lead with, or `null` when the project states none.
 *
 * `requireProjectName` rather than `resolveProjectName`: a guessed name differs between checkouts,
 * and this one is stamped into a Worker script name. A project that states none gets no hosts and
 * one line saying why — the alternative is a host running under a name nothing else in the project
 * would reproduce.
 */
const defaultProjectName = async (projectDir: string): Promise<string | null> => {
  try {
    return requireProjectName(await loadProject(projectDir));
  } catch {
    return null;
  }
};

export interface StartDevOptions {
  projectDir: string;
  json?: boolean;
  /** Test seam: the entitlement composition check, without loading a real `pithy.config.ts`. */
  checkEntitlements?: (workerDir: string) => Promise<string[]>;
  /** Seam: seed the dev secrets file into the local `SECRETS` store before anything spawns. */
  seedSecrets?: (projectDir: string) => Promise<DevSecretsSeedReport>;
  /** Seam: generate each Worker's `.dev.vars` before anything reads one. */
  generateDevVars?: (projectDir: string, workerDirs: string[]) => Promise<GenerateDevVarsResult>;
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
  /** Seam: the host Worker of every capability the project's Workers compose. */
  discoverHostWorkers?: (options: {
    projectDir: string;
    workers: readonly WorkerTarget[];
  }) => Promise<HostWorkerDiscovery>;
  /** Seam: resolve and write each host's local `wrangler.jsonc`. */
  materializeHostConfigs?: (options: MaterializeHostConfigsOptions) => Promise<HostMaterialization>;
  /** Seam: the project name every host's derived names lead with. `null` skips the hosts, loudly. */
  projectName?: (projectDir: string) => Promise<string | null>;
  /** Seam: whether Cloudflare credentials resolve at all — the cheap half of the delivery preflight. */
  hasCloudflareLogin?: (projectDir: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  loadDevConfig?: (projectDir: string) => Promise<DevConfig | null>;
  /** Bootstrap seam: assign and persist pinned ports when the project has none yet. */
  ensureDevConfig?: (options: EnsureDevConfigOptions) => Promise<DevConfig>;
  /** Seams handed to the real {@link ensureDevConfig} (git branch, registry path, write). */
  ensureDeps?: EnsureDevConfigDeps;
  tryBind?: TryBind;
  /** Reap our own orphans on the pinned ports. `knownPids` are the previous session's recorded children. */
  sweep?: (ports: number[], knownPids: readonly number[]) => Promise<number[]>;
  spawn?: SpawnDev;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: Sleep;
  /** Seam: the ready-deadline timer. Real `setTimeout` in production, a hand-driven clock in tests. */
  schedule?: Schedule;
  launchWrangler?: WranglerLauncher;
  hasSetsid?: boolean;
  stdout?: (text: string) => void;
  /** Seam: where the prose goes when stdout is reserved for JSON (`--json`). */
  stderr?: (text: string) => void;
  /** Seam: the seeded dev login the ready banner offers, if `pithy seed` wrote one. */
  readDevLogin?: (projectDir: string) => Promise<DevLogin | undefined>;
  /** Seam: which started workers carry the dev-login route (they compose auth). */
  devLoginTargets?: (started: readonly { name: string; dir: string; origin: string }[]) => Promise<DevLoginTarget[]>;
  /** Seam: the raw-mode key reader. Answers `active: false` on every non-TTY, and is never entered there. */
  readKeys?: typeof readKeysDefault;
  /** Seam: hand a URL to the platform's browser opener. */
  openUrl?: (url: string) => Promise<void>;
  openLog?: (path: string) => LogSink;
  baseEnv?: NodeJS.ProcessEnv;
  now?: () => Date;
  readState?: (path: string) => Promise<DevState | null>;
  writeState?: (path: string, state: DevState) => Promise<void>;
  removeState?: (path: string, ownPid: number) => void;
  ownPid?: number;
}

/** The resolved endpoint for one started worker. */
export interface StartedWorker {
  name: string;
  port: number;
  origin: string;
}

/** A running dev session's handle — its resolved workers, its lifecycle promises, and a shutdown hook. */
export interface DevHandle {
  workers: StartedWorker[];
  /** Resolves once every started worker has matched its ready signal (the ready banner fires). */
  ready: Promise<void>;
  /** Resolves once the session has fully torn down (all children gone, state removed). */
  closed: Promise<void>;
  /** Tear the session down: SIGTERM every child group, SIGKILL survivors after a grace window, clean up. */
  shutdown: (reason: string) => Promise<void>;
  state: DevState;
}

/** How long a child gets to exit on SIGTERM before it is SIGKILLed. */
const SHUTDOWN_GRACE_MS = 5000;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real log sink: truncate `logs/dev.log` fresh, stream lines to it, flush on close. */
function openLogDefault(path: string): LogSink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "w" });
  return {
    write: (line) => void stream.write(`${line}\n`),
    end: () => new Promise<void>((resolve) => stream.end(() => resolve())),
  };
}

/** The real spawn: a group-leader child (POSIX `setsid` via `detached`) with piped stdout/stderr. */
const spawnDefault: SpawnDev = (command, args, options) =>
  spawnChild(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: ["ignore", "pipe", "pipe"],
  });

const execFileAsync = promisify(execFile);

/** Seams for {@link ensureDevConfig} — the git and registry lookups a test drives itself. */
export interface EnsureDevConfigDeps {
  /** Resolve the machine's registry file (default: `<config>/dev-ports.json`). */
  registryPathFor?: (projectDir: string) => Promise<string>;
  /** The main checkout root, the registry's outer key (default: git-common-dir; the project itself with no repo). */
  rootFor?: (projectDir: string) => Promise<string>;
  /** The current branch, the registry's inner key (default: `git rev-parse --abbrev-ref HEAD`; `null` off a branch). */
  branchFor?: (projectDir: string) => Promise<string | null>;
  /** Persist the built config (default: {@link writeDevConfig}). */
  writeConfig?: (path: string, config: DevConfig) => Promise<void>;
}

/** Arguments to {@link ensureDevConfig}. */
export interface EnsureDevConfigOptions extends EnsureDevConfigDeps {
  /** The project (or worktree) root that owns `.dev.config.json`. */
  projectDir: string;
  /** Every discovered worker — not just the autostart set, so a port survives an autostart flip. */
  workers: WorkerTarget[];
  /** The config already on disk, whose worker→port pairs are preserved. `null` on first run. */
  existing?: DevConfig | null;
}

/** The registry is machine-wide and always resolvable — no repository is involved in finding it (#435). */
async function defaultRegistryPath(_projectDir: string): Promise<string> {
  return portsRegistryPath();
}

/**
 * The main checkout root, the key this project's blocks are filed under. With no repository at all the
 * project is its own root, which keys one block set per checkout — the same answer the old registry
 * location gave by sitting in it.
 */
async function defaultRoot(projectDir: string): Promise<string> {
  try {
    return await resolveMainRepoRoot(projectDir);
  } catch {
    // Canonical for the same reason `resolveMainRepoRoot` is: the answer is a registry key, and a project
    // reached once through a symlink and once through the real path would occupy two of them.
    return canonicalRepoPath(projectDir);
  }
}

/** The current branch, or `null` when there is no repo or HEAD is detached. */
async function defaultBranch(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir });
    const branch = stdout.trim();
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Put this config's already-pinned block back into the registry if the registry has lost it.
 *
 * Gap-filling only — {@link reclaimPortBlocks} never overwrites a live allocation, so this can only ever
 * restore a claim, never move one. Swallows its own failure: see {@link ensureDevConfig} for why a
 * registry that cannot be written must not stop a session whose ports are already decided.
 */
async function reregisterPinnedBlock(options: EnsureDevConfigOptions, branch: string, block: PortBlock): Promise<void> {
  try {
    const registryPath = await (options.registryPathFor ?? defaultRegistryPath)(options.projectDir);
    const root = await (options.rootFor ?? defaultRoot)(options.projectDir);
    await reclaimPortBlocks({ registryPath, root, reservations: [{ branch, block }] });
  } catch {
    // Nothing to report and nothing to stop: the ports this run uses are the ones already on disk.
  }
}

/**
 * Guarantee this project has pinned ports, then return them — the bootstrap behind `pithy dev`.
 *
 * `.dev.config.json` is written at feature creation, but a plain `pithy init` project is the main checkout,
 * which `pithy feature sync` deliberately refuses to touch — the main checkout is not a feature. So the
 * scaffold's own `pithy dev` had no way to ever get one. This writes the port half; the `.dev.vars` half is
 * {@link startDev}'s own step, because the two are needed in different projects at different moments.
 *
 * The invariant is unchanged: ports are **assigned** here, from the same central registry under the same
 * file lock, then verified before anything binds — never probed at startup. Idempotent: a block is reused
 * once allocated, and assignment is sticky, so a second run returns the same ports and a worker added later
 * takes a free port without moving a sibling's address. An existing config keeps its own block and branch —
 * the registry is never re-keyed underneath a live feature.
 *
 * **A pinned config still re-registers its claim, and that is not a contradiction of the line above**
 * (#435). The registry is machine-wide now, so it can lose this project's entry to something this project
 * never did: a wiped config directory, a new machine, a moved checkout pruned as gone by another project's
 * allocation. Every one of those ends with a live feature's ports on offer to whoever allocates next.
 * Before, the whole reclaim lived on the path that runs when there is *no* config — which is the path a
 * settled project never takes, so `pithy dev`, the command anybody actually runs, repaired nothing. The
 * repair is {@link reclaimPortBlocks}, which fills gaps and never overwrites, so re-registering a block
 * this config already pins cannot move anyone: the promise above is about *re-keying*, and nothing here
 * re-keys.
 *
 * Best-effort, deliberately. This session's ports are already pinned and are verified on both stacks
 * before anything binds, so a registry that cannot be written is not a reason to refuse to start — an
 * unwritable `$PITHY_CONFIG_DIR` used to leave `pithy dev` working off the pinned config alone, and it
 * still does.
 */
export async function ensureDevConfig(options: EnsureDevConfigOptions): Promise<DevConfig> {
  const existing = options.existing ?? null;
  const writeConfig = options.writeConfig ?? writeDevConfig;

  let branch: string;
  let block: PortBlock;
  if (existing) {
    branch = existing.branch;
    block = { block: existing.ports.index, base: existing.ports.base, size: existing.ports.size };
    await reregisterPinnedBlock(options, branch, block);
  } else {
    const registryPath = await (options.registryPathFor ?? defaultRegistryPath)(options.projectDir);
    const root = await (options.rootFor ?? defaultRoot)(options.projectDir);
    const named = await (options.branchFor ?? defaultBranch)(options.projectDir);
    // Off a branch (no repo, detached HEAD) the checkout path is the stable key — one block per checkout.
    branch = named ?? `local:${options.projectDir}`;
    // Rebuild any registry entry lost since the worktrees were created, so a fresh registry can never hand
    // out a block a live feature still holds. Scanned from the repository root, never from the registry's
    // own directory: the file sits in the config directory now, which has no `.worktrees` and never will,
    // so `dirname(registryPath)` would make this a silent no-op in every direction (#435).
    await reclaimPortBlocks({ registryPath, root, reservations: await scanPinnedBlocks(root) });
    block = await allocatePortBlock({ registryPath, root, branch });
  }

  const config = buildDevConfig({ branch, block, workers: options.workers, previous: existing });
  await writeConfig(devConfigPath(options.projectDir), config);
  return config;
}

/** Compile a worker's ready-signal regex, falling back to the default when the source is invalid. */
function readyRegexFor(worker: WorkerTarget): RegExp {
  const source = (worker.dev ?? defaultWorkerDev()).readySignal;
  try {
    return new RegExp(source);
  } catch {
    return new RegExp(defaultWorkerDev().readySignal);
  }
}

/**
 * Start and supervise the local dev session — the engine behind `pithy dev`.
 *
 * It discovers the autostart workers, resolves each one's **pinned** port from `.dev.config.json` (bootstrapping
 * one from the central port registry when the project has none — see {@link ensureDevConfig}), verifies
 * every port is free on both loopback families before spawning anything (a conflict aborts the whole session
 * — it never drifts to another port), stops any previous session and reaps orphaned workers, then spawns each
 * worker as a process-group leader with its siblings' addresses wired into the env. Output is tee'd — colorized
 * to the terminal, plain to `logs/dev.log` — and a single ready banner fires once every worker matches its
 * ready signal. Returns a handle; signal wiring and process exit stay with the caller so the engine is testable.
 */
export async function startDev(options: StartDevOptions): Promise<DevHandle> {
  const projectDir = options.projectDir;
  const discoverWorkers = options.discoverWorkers ?? discoverWorkersDefault;
  const loadDevConfig = options.loadDevConfig ?? ((dir: string) => readDevConfig(devConfigPath(dir)));
  const bind = options.tryBind ?? tryBindDefault;
  const spawn = options.spawn ?? spawnDefault;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? isAliveDefault;
  const sleep = options.sleep ?? realSleep;
  const hasSetsid = options.hasSetsid ?? process.platform !== "win32";
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
  const readDevLogin = options.readDevLogin ?? readDevLoginDefault;
  const resolveDevLoginTargets =
    options.devLoginTargets ??
    ((started: readonly { name: string; dir: string; origin: string }[]) => devLoginTargetsDefault({ started }));
  const readKeys = options.readKeys ?? readKeysDefault;
  const openUrl = options.openUrl ?? ((url: string) => openUrlDefault(url));
  const openLog = options.openLog ?? openLogDefault;
  const now = options.now ?? (() => new Date());
  const readState = options.readState ?? readDevState;
  const writeState = options.writeState ?? writeDevState;
  const removeState = options.removeState ?? removeDevState;
  const ownPid = options.ownPid ?? process.pid;
  /**
   * Say one line to whoever is reading this session.
   *
   * **Under `--json`, stdout is reserved for JSON and the prose goes to stderr.** Everything a person is
   * told here — the `Starting …` line, the delivery verdict, a `.dev.vars` refusal, and above all the
   * workers' own teed output, which is the bulk of the stream and every line wrangler and Vite print —
   * used to land on the same descriptor as the machine-readable line. So `pithy dev --json | jq` choked
   * on the first thing wrangler said, and the only rule a consumer could apply was to try each line and
   * skip what did not parse — which quietly skips a JSON line we get wrong, too. CLAUDE.md asks every
   * command to be agent-drivable; a stream is only that if a script knows which lines are for it.
   * Splitting by descriptor is the shell's own answer, costs a person nothing (both still reach the
   * terminal, and `logs/dev.log` has every line in either mode), and gives the rule a consumer can
   * actually apply: **every line on stdout is one object.** `docs/commands/dev.md` §`--json` states it.
   */
  const emitLine = (text: string) => (options.json ? stderr : stdout)(`${text}\n`);
  /** The machine's half: one object per line, always on stdout, only under `--json`. */
  const emitJson = (payload: Record<string, unknown>) => stdout(`${formatJsonLine(payload)}\n`);

  // 1. Discover the autostart set. apps/ is the registry; no hand-kept list.
  const discovered = await discoverWorkers(projectDir);

  //    …plus the host Worker of every capability those Workers compose (pithy-sh/pithy#410). Nine
  //    capabilities ship a prebuilt host that `pithy <capability> provision` deploys, none of them
  //    lives in `apps/`, and until now not one had ever run under `pithy dev` — which is why every
  //    email enqueued locally sat `pending` forever while the UI reported success. A host joins as an
  //    ordinary member: its own pinned port, label, color, state entry, and teardown. Discovery is
  //    through the shared registry, so the dev command names no capability.
  //
  //    The project name is settled first, and `requireProjectName` rather than a guess: it is stamped
  //    into a Worker script name, and a guessed one differs between checkouts. A project that states
  //    none gets no hosts and one line saying so, rather than hosts running under a name nothing else
  //    in the project would reproduce.
  const project = await (options.projectName ?? defaultProjectName)(projectDir);
  const findHosts = options.discoverHostWorkers ?? discoverHostWorkersDefault;
  const hostFinding =
    project === null
      ? {
          hosts: [],
          notes: [
            "No project name in pithy.config.ts, so no capability host can be named — none will run.",
            dim('  set: export default { name: "<project>" }'),
          ],
        }
      : await findHosts({ projectDir, workers: discovered });
  for (const line of hostFinding.notes) emitLine(line);
  const hosts = hostFinding.hosts;
  const hostNames = new Set(hosts.map((host) => host.worker.name));
  const members = [...discovered, ...hosts.map((host) => host.worker)];
  const autostart = members.filter((w) => (w.dev ?? defaultWorkerDev()).autostart);
  if (autostart.length === 0) {
    throw new ValidationError({
      message: "No autostart workers to run.",
      action: "Add one with pithy worker add, or set dev.autostart in a worker's pithy.worker.jsonc.",
    });
  }

  // 2. Generate every worker's `.dev.vars`, before anything reads one (#154).
  //
  //    wrangler loads the file beside the worker it runs, so each one needs its own. That was a symlink at
  //    a shared root file, and the symlink is the thing that never survived a clone: `pithy init` made it
  //    once for whoever created the project, and every developer after them cloned, wrote the `.dev.vars`
  //    the example told them to, and got nothing — every secret reported absent while the file sat at the
  //    root, unread. A `postinstall` could not fix it either, because the usual order is clone, install,
  //    *then* write `.dev.vars`. Generation removes the question: `pithy dev` is the command that runs
  //    every time, and it builds each file from the machine-local sources whether or not one is there.
  //
  //    Idempotent by content, so a second `pithy dev` writes no bytes and wrangler's watcher sees nothing.
  //    A `.dev.vars` pithy did not generate is never overwritten and never merged — it is named, with the
  //    supported place for local values, and that worker starts without one rather than with somebody
  //    else's file replaced underneath it.
  //
  //    Non-fatal in every direction. A project whose config directory is unreadable still starts, and
  //    says why its Workers have no bindings, because the alternative is a dev session that will not run
  //    at all over a file wrangler would have reported on itself.
  const generate =
    options.generateDevVars ??
    ((dir: string, dirs: string[]) => generateDevVars({ projectDir: dir, workerDirs: dirs }));
  const generateInto = async (dirs: string[]): Promise<void> => {
    const devVars = await generate(projectDir, dirs);
    for (const line of renderDevVarsNotes(devVars)) emitLine(line);
    for (const line of devVars.unresolvable) emitLine(line);
  };
  try {
    const devVars = await generate(
      projectDir,
      discovered.map((worker) => worker.dir),
    );
    for (const line of renderDevVarsNotes(devVars)) emitLine(line);
    // A Worker whose `pithy.config.ts` would not import (#199). Emitted here rather than folded into
    // `renderDevVarsNotes`, because this is not a delivery outcome: the file was written, and written
    // empty on purpose. It is the one thing a `pithy dev` in this state has to say, and until now it
    // said nothing — the session started, the Worker came up with no bindings, and the only line about
    // it was `Starting <worker>.` Every run, not once: the state persists until the config is fixed,
    // and the run after the one they missed is the one that has to reach them.
    for (const line of devVars.unresolvable) emitLine(line);
  } catch (error) {
    emitLine(`.dev.vars not generated. ${messageOf(error)}`);
  }

  // 3. Resolve pinned ports from the dev config — never probe. A project that has none yet (a plain
  //    `pithy init` checkout, which `pithy feature sync` refuses to touch) gets one bootstrapped here from
  //    the same central registry, so ports stay assigned-then-verified rather than probed at startup.
  const ensure = options.ensureDevConfig ?? ensureDevConfig;
  const existing = await loadDevConfig(projectDir);
  const unpinned = autostart.filter((w) => !existing?.workers[w.name]);
  const config =
    unpinned.length === 0 && existing
      ? existing
      : await ensure({ projectDir, workers: members, existing, ...(options.ensureDeps ?? {}) });

  const started: { worker: WorkerTarget; port: number; origin: string }[] = [];
  for (const worker of autostart) {
    const pinned = config.workers[worker.name];
    if (!pinned) {
      throw new ValidationError({
        message: `Worker "${worker.name}" has no port in .dev.config.json.`,
        action: "Delete .dev.config.json and run pithy dev again to reassign this project's ports.",
      });
    }
    started.push({ worker, port: pinned.port, origin: pinned.origin });
  }

  // 3b. Resolve and write each host's local `wrangler.jsonc`, now that the app Worker's own address
  //     is known — a message sent from here builds its callback links against it.
  //
  //     The delivery preflight runs first and *decides*. `remote: true` on the email host's send
  //     binding runs the Worker locally and delivers through Cloudflare Email Service for real, which
  //     is what makes a magic link triggered from localhost actually arrive; that needs a Cloudflare
  //     login and an onboarded sending domain, neither of which the kit owns. Where the cheap check
  //     can already see one of them is missing, the host is resolved for its local simulator instead
  //     of for a binding that would fail at startup — and it says so, before anyone is waiting on an
  //     inbox. The preflight is not the guarantee: `deliveryFailureNote` watches the host's own
  //     output for the failures it cannot see from here.
  const hostPorts: Record<string, number> = {};
  for (const host of hosts) {
    const pinned = config.workers[host.worker.name];
    if (pinned) hostPorts[host.worker.name] = pinned.port;
  }
  // The delivery verdict, said **once** — in the ready banner, which is where a developer looks, and
  // pre-spawn only under `--json`, where there is no banner and the reader is a script. Saying it in
  // both places was two copies of one sentence in every interactive session.
  let deliveryLines: readonly string[] = [];
  // The hosts that actually have a config on disk, the seam that wrote it, and the address it wrote
  // them against — all three needed after the block below: only these are started, and a delivery
  // failure at runtime rewrites one of them for its simulator.
  let liveHosts: HostWorker[] = hosts;
  let materializeHosts: ((options: MaterializeHostConfigsOptions) => Promise<HostMaterialization>) | undefined;
  let hostBaseUrl = "http://localhost";
  let deliveryIsLive = false;
  if (project !== null && hosts.length > 0) {
    // The app's address: the first started Worker that is not a host. Callback links point at the
    // app, never at the host — the host holds no public route of its own.
    const app = started.find((s) => !hostNames.has(s.worker.name));
    const identity = await hostDeliveryIdentity(hosts);
    const preflight = deliveryPreflight({
      composed: identity !== undefined,
      requested: identity?.requested ?? "remote",
      fromAddress: identity?.fromAddress,
      hasCloudflareLogin: await (options.hasCloudflareLogin ?? defaultHasCloudflareLogin)(
        projectDir,
        options.baseEnv ?? process.env,
      ),
    });
    deliveryLines = preflight.lines;
    deliveryIsLive = preflight.live;
    if (options.json) for (const line of preflight.lines) emitLine(line);
    hostBaseUrl = app?.origin ?? started[0]?.origin ?? "http://localhost";
    const materialize = options.materializeHostConfigs ?? materializeHostConfigsDefault;
    materializeHosts = materialize;
    const materialized = await materialize({
      projectDir,
      project,
      baseUrl: hostBaseUrl,
      hosts,
      simulateDelivery: !preflight.live,
    });
    for (const line of materialized.notes) emitLine(line);
    // A host with no config on disk leaves the set here, and that is the whole point of the second
    // list. Its directory was never created, so `wrangler dev` in it fails on the spawn itself — Node
    // raises `error`, the handler below tears the session down, and every Worker that was running fine
    // dies for one capability nobody could resolve. The note said "it will not run"; this is what makes
    // that true. Its siblings' `<STEM>_ORIGIN` goes with it, because an address nothing listens on is
    // worse than none: the loopback dispatcher prefers a published origin over the binding.
    const dropped = new Set(materialized.failed);
    if (dropped.size > 0) {
      for (let index = started.length - 1; index >= 0; index -= 1) {
        if (dropped.has(started[index]?.worker.name ?? "")) started.splice(index, 1);
      }
      for (const name of dropped) delete hostPorts[name];
    }
    liveHosts = hosts.filter((host) => !dropped.has(host.worker.name));
    // A host's `.dev.vars` is generated once its directory exists, from the same project-wide
    // bootstrap set every Worker gets — the master key above all, since a local host has no Secrets
    // Store for the resolved template's entries to point at (which is why that block is dropped).
    // Through the one generator, so a `.dev.vars` value is never written by a second hand.
    try {
      await generateInto(liveHosts.map((host) => host.worker.dir));
    } catch (error) {
      emitLine(`Capability hosts start without secrets. ${messageOf(error)}`);
    }
  }

  // 4. Stop a previous session, then reap orphaned workerd/wrangler still holding the pinned ports. This runs
  //    BEFORE verification: a crashed prior session's orphan must be reaped, not treated as an external
  //    conflict that blocks startup (docs/CLI.md §6.2 — a crashed session can't block the next one). The
  //    sweep is scoped to our own orphans — the previous session's pids and workerd/wrangler-shaped
  //    commands — so anything genuinely external falls through to step 5 and is reported, never killed.
  const statePath = devStatePath(projectDir);
  const previous = await stopPreviousSession({ statePath, readState, isAlive, kill, sleep, emitLine });
  const sweep =
    options.sweep ??
    ((ports: number[], knownPids: readonly number[]) =>
      sweepStaleDevPorts(ports, { knownPids, selfPid: ownPid, log: (m) => emitLine(m) }));
  await sweep(
    started.map((s) => s.port),
    previous?.childPids ?? [],
  );

  // 5. Verify every pinned port is now free on both loopback families — one conflict (something genuinely
  //    external still holds it) aborts the whole session with one error; it never drifts to another port.
  for (const { worker, port } of started) {
    await verifyPinnedPort(worker.name, port, bind);
  }

  // 6. Resolve the wrangler launcher through the project's package manager (never a hardcoded global).
  const launchWrangler =
    options.launchWrangler ??
    (await (async () => {
      const pm = await detectPackageManager(projectDir);
      return (args: string[]) => execArgs(pm, "wrangler", args);
    })());

  // 7. Open the log, wire the shared env, and spawn.
  const logPath = join(projectDir, "logs", "dev.log");
  // Read before anything spawns, so the banner never waits on the disk once the workers are up.
  const devLogin = await readDevLogin(projectDir);
  const log = openLog(logPath);
  log.write(
    `=== dev session ${now().toISOString()} — ${started.map((s) => `${s.worker.name}:${s.port}`).join(", ")} ===`,
  );
  const baseEnv = options.baseEnv ?? process.env;
  // The keypress follows the route. Under CI the auth capability registers none, so `l` would open a
  // 404 — the read is the same one the capability makes, from the same module, and it is the only
  // refusal the supervisor can see coming rather than discover.
  const ci = isContinuousIntegration(baseEnv);
  // Which running workers carry `GET /__pithy/dev-login` — the ones composing auth. Resolved only when
  // there is a session to open, so a project with no dev login never loads a Worker config for this.
  const devLoginWorkers: DevLoginTarget[] =
    devLogin && !ci
      ? await resolveDevLoginTargets(
          started
            .filter((s) => !hostNames.has(s.worker.name))
            .map((s) => ({ name: s.worker.name, dir: s.worker.dir, origin: s.origin })),
        )
      : [];
  const childEnv = buildWorkerEnv(config, baseEnv);
  // One local store for the whole project, named in one place — `localDevStateRoot`. This used to compose
  // the path itself, which made three independent statements of one directory (#404).
  const persistTo = localDevStateRoot(projectDir);

  const children: { name: string; child: ChildLike }[] = [];
  const pipes: Promise<void>[] = [];
  const exits: Promise<void>[] = [];
  const readyState = new Map<string, boolean>();
  const readyRegex = new Map<string, RegExp>();
  let bannerShown = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shuttingDown = false;

  // The ready deadline's timer, replaced by the live watch once the children are spawned. Declared here
  // for the same reason `keys` is: the banner and the shutdown both stop it, and both are written above
  // the spawn loop that starts it.
  let readyWatch: ReadyWatch = { stop: () => {} };

  const showBannerIfReady = () => {
    if (bannerShown || [...readyState.values()].some((r) => !r)) return;
    bannerShown = true;
    readyWatch.stop();
    if (!options.json) {
      // Bindings go live with the banner, not before it: `l` opens a URL, and a URL that answers is a
      // worker that has already matched its ready signal. `--json` gets none — its output is being read
      // by a script, and a supervisor that entered raw mode for a machine would be holding a terminal
      // nobody is at.
      startKeys();
      emitLine("Ready.");
      for (const s of started) emitLine(`${s.worker.name}: ${s.origin}`);
      // Said once, where a developer actually looks. Real delivery or the simulator is the difference
      // between a magic link arriving and a rendered file on disk, and nobody should learn it from an
      // inbox that stays empty. Every line of the verdict, action included — a sentence naming the
      // problem without the sentence naming the fix is half a report.
      for (const line of deliveryLines) emitLine(line);
      // The banner is the discovery mechanism. A seeded session nobody finds has removed no friction, and
      // the line below is the only place a developer reliably looks after `pithy dev`. It says that there
      // is a session and how to reach it — never what the session *is*.
      for (const line of devLoginLines(devLogin, now(), { interactive: keys.active, targets: devLoginWorkers, ci })) {
        emitLine(line);
      }
      emitLine(dim(`logs → ${logPath}`));
    }
    for (const s of started) log.write(`ready: ${s.worker.name} ${s.origin}`);
    resolveReady();
  };

  /**
   * `l` — open a signed-in browser.
   *
   * The decision is {@link devLoginKeyAction}'s and is made without touching the terminal, so the only
   * work here is saying it and handing the URL over. A failed open is reported and survived: `pithy dev`
   * supervises workers, and no browser is a reason for a sentence, not for tearing a session down.
   */
  const openDevLogin = async (): Promise<void> => {
    const action = devLoginKeyAction(devLogin, now(), devLoginWorkers, ci);
    for (const line of action.lines) emitLine(line);
    if (!action.url) return;
    try {
      await openUrl(action.url);
    } catch (error) {
      emitLine(messageOf(error));
    }
  };

  // Scoped to `l`. A second binding is one more entry here — `r` to restart and `o` to open the app are
  // the obvious neighbors — and neither is this issue.
  let keys: KeyReader = { active: false, stop: () => {} };
  const startKeys = () => {
    keys = readKeys({
      bindings: [{ key: "l", run: openDevLogin }],
      // Raw mode takes the terminal's own Ctrl-C handling away, so the supervisor has to put it back.
      // Without this line `pithy dev` becomes unstoppable from the keyboard.
      onInterrupt: () => void shutdown("interrupted"),
      onError: (error) => emitLine(messageOf(error)),
    });
  };

  const signalChild = (pid: number | undefined, signal: NodeJS.Signals) => {
    if (!pid) return;
    try {
      kill(hasSetsid ? -pid : pid, signal);
    } catch {
      // Already exited (ESRCH) — nothing to signal.
    }
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // First, before anything can take time: give the terminal back. A session that died with the
    // terminal in raw mode leaves a shell that echoes nothing.
    keys.stop();
    readyWatch.stop();
    emitLine(`Stopping — ${reason}.`);
    log.write(`stopping — ${reason}`);
    for (const { child } of children) signalChild(child.pid, "SIGTERM");
    const allExited = Promise.allSettled(exits);
    const timedOut = await Promise.race([allExited.then(() => false), sleep(SHUTDOWN_GRACE_MS).then(() => true)]);
    if (timedOut) {
      emitLine("Children still alive after grace window — sending SIGKILL.");
      for (const { child } of children) signalChild(child.pid, "SIGKILL");
      await allExited;
    }
    await Promise.allSettled(pipes);
    await log.end();
    removeState(statePath, ownPid);
    resolveClosed();
  };

  // The entitlement composition check, reported once at startup. The seam fails closed, so a Worker that
  // gates routes on an entitlement while composing no provider denies every one of them — and at runtime
  // that is indistinguishable from a project full of unentitled users. Non-fatal: it is a warning about
  // wiring, not a reason to refuse to run, and a config that will not load is left to wrangler to report.
  const checkEntitlements = options.checkEntitlements ?? defaultCheckEntitlements;
  for (const { worker } of started) {
    const gates = await checkEntitlements(worker.dir);
    if (gates.length === 0) continue;
    emitLine(`${worker.name}: routes gate on an entitlement, but no capability resolves one — they will deny.`);
    for (const gate of gates) emitLine(dim(`  ${gate}`));
    emitLine(dim("  run: pithy add payments"));
  }

  // Secrets are seeded before anything spawns, for the same reason the `.dev.vars` link is wired before
  // anything spawns (#139): a Worker reads its secrets on the first request, and a store seeded after
  // startup is a store the first sign-in of the session missed. Idempotent, so this is silent on every
  // run but the one that changed something.
  //
  // Non-fatal, in both directions. A project that never composed `secrets` has nothing to seed and
  // hears nothing. A dev secrets file that will not parse is said out loud and the session still
  // starts — refusing to run every Worker over one malformed file would be a worse trade than letting
  // the capability that needs the secret fail with its own error.
  const seedSecrets = options.seedSecrets ?? ((dir: string) => seedProjectDevSecrets({ projectDir: dir }));
  try {
    for (const line of renderDevSecretsNotes(await seedSecrets(projectDir))) emitLine(line);
  } catch (error) {
    emitLine(`Secrets not seeded. ${messageOf(error)}`);
  }

  /**
   * The runtime half of the delivery fallback (pithy-sh/pithy#410).
   *
   * The preflight decides what it can see from outside the process; a remote `send_email` binding that
   * will not stand up, and a send Cloudflare refuses, appear only in the host's own output. Reporting
   * that and stopping there leaves the session in the one state the issue forbids — every subsequent
   * magic link failing, quietly, for the rest of the afternoon. So the host is re-resolved for its
   * local simulator, which sends nothing and logs the recipient, subject and URL.
   *
   * **Rewriting the config is the whole restart.** `wrangler dev` watches the `wrangler.jsonc` it was
   * started with and reloads the Worker when it changes, so the fallback needs no second spawn path,
   * no kill that the exit handler would read as a crash, and no port to re-verify.
   *
   * Once per host. A failing binding usually says so more than once, and a rewrite loop would reload
   * the Worker on every line it printed.
   */
  const simulated = new Set<string>();
  const fallBackToSimulator = async (capability: string): Promise<void> => {
    // Nothing to fall back to when this session was never sending for real: the host already holds the
    // simulator, and rewriting an identical config would reload a Worker for no change.
    if (!deliveryIsLive || simulated.has(capability) || !materializeHosts || project === null) return;
    const host = liveHosts.find((candidate) => candidate.worker.name === capability);
    if (!host) return;
    simulated.add(capability);
    try {
      const again = await materializeHosts({
        projectDir,
        project,
        baseUrl: hostBaseUrl,
        hosts: [host],
        simulateDelivery: true,
      });
      for (const line of again.notes) emitLine(line);
      emitLine(`${capability}: using the simulator from here. Messages are logged and written to disk, never sent.`);
    } catch (error) {
      emitLine(`${capability}: the simulator fallback could not be written. ${messageOf(error)}`);
    }
  };

  emitLine(`Starting ${started.map((s) => s.worker.name).join(", ")}.`);

  for (const { worker, port } of started) {
    readyState.set(worker.name, false);
    readyRegex.set(worker.name, readyRegexFor(worker));
    const { command, args } = startCommand(worker, port, launchWrangler, persistTo, baseEnv, hostPorts);
    const child = spawn(command, args, { cwd: worker.dir, env: childEnv, detached: hasSetsid });
    children.push({ name: worker.name, child });

    const isHost = hostNames.has(worker.name);
    const onLine = (line: string) => {
      // A remote send binding that will not stand up, or a send Cloudflare refuses, appears here and
      // nowhere else — the preflight above cannot see either from outside the process. Caught where it
      // appears, rendered with the action that fixes it, then the host is dropped to its simulator so
      // the rest of the session still sends something. Never fatal: `pithy dev` supervises Workers, and
      // a message that did not send is a reason for a sentence, not for a teardown.
      if (isHost) {
        const note = deliveryFailureNote(line);
        if (note) {
          for (const text of note.split("\n")) emitLine(text);
          void fallBackToSimulator(worker.name);
        }
      }
      if (bannerShown || readyState.get(worker.name)) return;
      if (readyRegex.get(worker.name)?.test(line)) {
        readyState.set(worker.name, true);
        showBannerIfReady();
      }
    };
    const paint = workerColor(children.length - 1);
    if (child.stdout) {
      pipes.push(
        teeStream({
          stream: child.stdout,
          label: worker.name,
          paint,
          sinks: { terminal: (l) => emitLine(l), log: (l) => log.write(l), line: onLine },
        }),
      );
    }
    if (child.stderr) {
      pipes.push(
        teeStream({
          stream: child.stderr,
          label: worker.name,
          paint,
          sinks: { terminal: (l) => emitLine(l), log: (l) => log.write(l), line: onLine },
        }),
      );
    }

    exits.push(
      new Promise<void>((resolve) => {
        child.once("exit", (code) => {
          resolve();
          if (!shuttingDown) void shutdown(`${worker.name} exited (${code})`);
        });
        // A spawn failure (ENOENT for a missing dev.command binary, EACCES, …) emits 'error' and never 'exit'.
        // Without this listener Node re-throws it as an uncaught error, crashing dev with a raw stack and never
        // shutting down. Handle it: report it, settle this child's exit, and tear the session down.
        child.once("error", (error) => {
          emitLine(`${worker.name} failed to start: ${error.message}`);
          log.write(`error: ${worker.name} ${error.message}`);
          resolve();
          if (!shuttingDown) void shutdown(`${worker.name} failed to start`);
        });
      }),
    );
  }

  // 8. Start the ready deadline, now that every child is running (pithy-sh/pithy#429).
  //
  //    `wrangler dev` does not exit when a build fails — it prints the error and keeps running. So a
  //    worker that cannot build is a live child that never matches its ready signal: the banner waits on
  //    the whole set and never fires, and the session proceeds looking healthy with the real error forty
  //    lines up the scrollback, interleaved with every sibling's startup. Three capability workers reached
  //    an adopter that way (#426). The deadline names whoever has not arrived, and keeps naming them.
  //
  //    **A child that fails to build is deliberately not treated as dead — it is reported, and left.**
  //    The tempting alternative loses on three counts. A death here is not local: the exit handler above
  //    tears the *whole* session down when any child exits, so condemning one broken build would stop
  //    every healthy worker for one worker's typo, which is a worse trade than a line naming it. The
  //    verdict would have to be read out of wrangler's own output (`Build failed with 1 error`), which
  //    is version-coupled prose, and a false positive kills a working session — while a `dev.command`
  //    worker is not wrangler at all, and Vite does recover from a bad build. And the deadline already
  //    catches strictly more than a build failure: a port that never binds, a binding that never
  //    resolves, a startup that hangs. So the watch reports; it never condemns.
  //
  //    It does say what a restart cannot be avoided for. A `wrangler dev` whose **first** build fails
  //    never rebuilds — fixing the file changes nothing, measured, so the report's action line names
  //    `pithy dev` rather than implying the session will heal itself.
  //
  //    **`--json` gets a record, not the prose.** CLAUDE.md makes every command agent-drivable, and the
  //    agent driving `pithy dev --json` is in exactly the position #426's adopter was: a session that
  //    never emits its ready line, and nothing on the wire saying which worker is missing. A sentence it
  //    would have to regex is not an answer, so the deadline emits one JSON line per report — the same
  //    line-per-object shape as the handshake above it, `event` naming which kind of line it is. That is
  //    the one place `pithy dev`'s streaming surface owes a machine something the handshake cannot carry:
  //    the handshake is written the moment the children are spawned, and readiness is decided after it.
  //    The prose still goes to `logs/dev.log` in both modes — the log is read by a person either way.
  readyWatch = watchReady({
    pending: () => started.map((s) => s.worker.name).filter((name) => !readyState.get(name)),
    report: (waiting, first) => {
      // Both destinations, the way the banner's own lines go: a report only in the terminal is a report
      // a piped session loses, and `logs/dev.log` is where a developer looks after the fact.
      const lines = stillWaitingLines(waiting, first);
      if (options.json) {
        emitJson({ command: "dev", event: "still-waiting", waiting: [...waiting] });
      } else {
        for (const line of lines) emitLine(line);
      }
      for (const line of lines) log.write(stripAnsi(line));
    },
    schedule: options.schedule,
  });

  // 9. Record the live session so a re-run can stop it and reap its children.
  const state: DevState = {
    pid: ownPid,
    startedAt: now().toISOString(),
    childPids: children.map((c) => c.child.pid).filter((pid): pid is number => typeof pid === "number"),
    workers: Object.fromEntries(
      children.map(({ name, child }, i) => [name, { port: started[i]?.port ?? 0, pid: child.pid ?? 0 }]),
    ),
  };
  await writeState(statePath, state);

  return {
    workers: started.map((s) => ({ name: s.worker.name, port: s.port, origin: s.origin })),
    ready,
    closed,
    shutdown,
    state,
  };
}

/**
 * Stop a still-running previous session, or reap the orphaned children of a crashed one. Returns the state
 * it read, so the port sweep knows which pids were ours and can leave every other one to be reported.
 */
async function stopPreviousSession(deps: {
  statePath: string;
  readState: (path: string) => Promise<DevState | null>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: Sleep;
  emitLine: (text: string) => void;
}): Promise<DevState | null> {
  const prev = await deps.readState(deps.statePath);
  if (!prev) return null;
  if (deps.isAlive(prev.pid)) {
    deps.emitLine(`Stopping previous session (pid ${prev.pid}).`);
    trySignal(deps.kill, prev.pid, "SIGINT");
    const gone = await waitFor(prev.pid, 5000, deps.isAlive, deps.sleep);
    if (!gone) {
      trySignal(deps.kill, prev.pid, "SIGKILL");
      await waitFor(prev.pid, 2000, deps.isAlive, deps.sleep);
    }
    return prev;
  }
  for (const pid of prev.childPids) {
    if (deps.isAlive(pid)) {
      deps.emitLine(`Reaping orphan child pid ${pid}.`);
      trySignal(deps.kill, pid, "SIGTERM");
    }
  }
  return prev;
}

function trySignal(kill: (pid: number, signal: NodeJS.Signals) => void, pid: number, signal: NodeJS.Signals): void {
  try {
    kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function waitFor(
  pid: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  sleep: Sleep,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(100);
  }
}
