// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, spawn as spawnChild } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { findEntitlementGap } from "../capabilities/entitlementGap";
import { type GenerateDevVarsResult, generateDevVars } from "../devSecrets/generate";
import { renderDevSecretsNotes, renderDevVarsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, seedProjectDevSecrets } from "../devSecrets/seed";
import {
  buildDevConfig,
  type DevConfig,
  devConfigPath,
  readDevConfig,
  scanPinnedBlocks,
  writeDevConfig,
} from "../feature/devConfig";
import { allocatePortBlock, type PortBlock, reclaimPortBlocks, resolvePortsRegistryPath } from "../feature/ports";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { detectPackageManager, execArgs } from "../project/packageManager";
import { defaultWorkerDev } from "../project/workerManifest";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "../project/workers";
import { dim, workerColor } from "../terminal/style";
import { devLoginLines, readDevLogin as readDevLoginDefault } from "./devLogin";
import { buildWorkerEnv, startCommand, type WranglerLauncher } from "./env";
import { type DataStream, teeStream } from "./logging";
import {
  isAlive as isAliveDefault,
  type Sleep,
  sweepStaleDevPorts,
  type TryBind,
  tryBind as tryBindDefault,
  verifyPinnedPort,
} from "./ports";
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
  launchWrangler?: WranglerLauncher;
  hasSetsid?: boolean;
  stdout?: (text: string) => void;
  /** Seam: the seeded dev login the ready banner offers, if `pithy seed` wrote one. */
  readDevLogin?: (projectDir: string) => Promise<DevLogin | undefined>;
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
  /** Resolve the central `.dev-ports.json` (default: the main repo root, or the project when there is no repo). */
  registryPathFor?: (projectDir: string) => Promise<string>;
  /** The current branch, the registry's key (default: `git rev-parse --abbrev-ref HEAD`; `null` off a branch). */
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

/** The registry lives at the main repo root; with no repo at all, the project keeps its own. */
async function defaultRegistryPath(projectDir: string): Promise<string> {
  try {
    return await resolvePortsRegistryPath(projectDir);
  } catch {
    return join(projectDir, ".dev-ports.json");
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
 */
export async function ensureDevConfig(options: EnsureDevConfigOptions): Promise<DevConfig> {
  const existing = options.existing ?? null;
  const writeConfig = options.writeConfig ?? writeDevConfig;

  let branch: string;
  let block: PortBlock;
  if (existing) {
    branch = existing.branch;
    block = { block: existing.ports.index, base: existing.ports.base, size: existing.ports.size };
  } else {
    const registryPath = await (options.registryPathFor ?? defaultRegistryPath)(options.projectDir);
    const named = await (options.branchFor ?? defaultBranch)(options.projectDir);
    // Off a branch (no repo, detached HEAD) the checkout path is the stable key — one block per checkout.
    branch = named ?? `local:${options.projectDir}`;
    // Rebuild any registry entry lost since the worktrees were created, so a fresh registry can never hand
    // out a block a live feature still holds.
    await reclaimPortBlocks({ registryPath, reservations: await scanPinnedBlocks(dirname(registryPath)) });
    block = await allocatePortBlock({ registryPath, branch });
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
  const readDevLogin = options.readDevLogin ?? readDevLoginDefault;
  const openLog = options.openLog ?? openLogDefault;
  const now = options.now ?? (() => new Date());
  const readState = options.readState ?? readDevState;
  const writeState = options.writeState ?? writeDevState;
  const removeState = options.removeState ?? removeDevState;
  const ownPid = options.ownPid ?? process.pid;
  const emitLine = (text: string) => stdout(`${text}\n`);

  // 1. Discover the autostart set. apps/ is the registry; no hand-kept list.
  const discovered = await discoverWorkers(projectDir);
  const autostart = discovered.filter((w) => (w.dev ?? defaultWorkerDev()).autostart);
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
      : await ensure({ projectDir, workers: discovered, existing, ...(options.ensureDeps ?? {}) });

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
  const childEnv = buildWorkerEnv(config, options.baseEnv ?? process.env);
  // One local store for the whole project. Each worker runs in its own apps/<name>/, where wrangler would
  // otherwise create a private `.wrangler/` — so two workers sharing a binding would not share the data.
  const persistTo = join(projectDir, ".wrangler", "state");

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

  const showBannerIfReady = () => {
    if (bannerShown || [...readyState.values()].some((r) => !r)) return;
    bannerShown = true;
    if (!options.json) {
      emitLine("Ready.");
      for (const s of started) emitLine(`${s.worker.name}: ${s.origin}`);
      // The banner is the discovery mechanism. A seeded session nobody finds has removed no friction, and
      // the line below is the only place a developer reliably looks after `pithy dev`.
      for (const line of devLoginLines(devLogin, now())) emitLine(line);
      emitLine(dim(`logs → ${logPath}`));
    }
    for (const s of started) log.write(`ready: ${s.worker.name} ${s.origin}`);
    resolveReady();
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

  emitLine(`Starting ${started.map((s) => s.worker.name).join(", ")}.`);

  for (const { worker, port } of started) {
    readyState.set(worker.name, false);
    readyRegex.set(worker.name, readyRegexFor(worker));
    const { command, args } = startCommand(worker, port, launchWrangler, persistTo);
    const child = spawn(command, args, { cwd: worker.dir, env: childEnv, detached: hasSetsid });
    children.push({ name: worker.name, child });

    const onLine = (line: string) => {
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

  // 8. Record the live session so a re-run can stop it and reap its children.
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
