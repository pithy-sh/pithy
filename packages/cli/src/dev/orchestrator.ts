// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn as spawnChild } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isContinuousIntegration } from "@pithy-sh/core/src/env/ci";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { DevLogin, DevLogins } from "@pithy-sh/core/src/seed/devLogin";
import { findEntitlementGap } from "../capabilities/entitlementGap";
import type { CloudflareAccountSelection } from "../cloudflare/config";
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
  describeStaleAutostartRoots,
  type PortBlock,
  portsRegistryPath,
  readWorkerAutostart,
  reclaimPortBlocks,
  registryRootFor,
  type StaleAutostartRoot,
  setWorkerAutostart,
  staleAutostartRoots,
} from "../feature/ports";
import { heldReservations } from "../feature/prune";
import { currentBranch, defaultGit } from "../feature/worktree";
import { openUrl as openUrlDefault } from "../platform/browser";
import { composeFor } from "../project/composeFor";
import { allCapabilities } from "../project/config";
import { detectPackageManager, execArgs } from "../project/packageManager";
import { defaultWorkerDev } from "../project/workerManifest";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "../project/workers";
import { type KeyReader, readKeys as readKeysDefault } from "../terminal/keys";
import { formatJsonStreamLine } from "../terminal/output";
import { dim, workerColor } from "../terminal/style";
import {
  type DevCloudflareEnv,
  devCloudflareEnv as defaultDevCloudflareEnv,
  deliveryFailureNote,
  deliveryPreflight,
} from "./delivery";
import {
  type DevIdentity,
  type DevLoginTarget,
  devLoginChoice,
  devLoginChoiceLines,
  devLoginIdentities,
  devLoginKeyAction,
  devLoginLines,
  MAX_KEY_CHOICES,
  pickDevLoginByKey,
  readDevLogins as readDevLoginsDefault,
  selectDevLogin,
  usableDevLogins,
} from "./devLogin";
import { devLoginTargets as devLoginTargetsDefault } from "./devLoginTargets";
import { type DevMemberKind, type DevSetMember, resolveDevSet, selectDevMembers } from "./devSet";
import { buildWorkerEnv, childEnvFor, ownOriginFor, startCommand, type WranglerLauncher } from "./env";
import type { DevEvent, DevEvents } from "./events";
import {
  type HostMaterialization,
  type HostWorker,
  type HostWorkerDiscovery,
  hostDeliveryIdentity,
  type MaterializeHostConfigsOptions,
  materializeHostConfigs as materializeHostConfigsDefault,
} from "./hostWorkers";
import { type DataStream, stripAnsi, teeStream } from "./logging";
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
    // Composed for `dev`, the environment this session serves (#595).
    const capabilities = await composeFor(LOCAL_ENVIRONMENT, async (load) => allCapabilities(await load(workerDir)));
    return await findEntitlementGap(workerDir, capabilities);
  } catch {
    return [];
  }
};

export interface StartDevOptions {
  projectDir: string;
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)` — or
   * `null` for a project that names none.
   *
   * **Required, and stated by the caller rather than defaulted**, for the reason `DeployProjectOptions`
   * gives: there is no safe default. `pithy dev` copied `process.env` into every worker and added only
   * the port table, so a `wrangler dev` with a remote send binding authenticated as whatever token the
   * operator's shell last exported — and a magic link left through a tenant that does not own the
   * sending domain, five times, silently (#555). This is the value that stops it, and it is the only
   * field on this interface that is not a seam.
   */
  account: CloudflareAccountSelection | null;
  json?: boolean;
  /**
   * Start exactly these members — `--app`, repeatable. A name is the deployed name, the `apps/<dir>`
   * basename, or a capability name for a host, and it starts that member whatever this branch
   * says. Empty starts the autostart set. It narrows what runs; it never narrows what gets a port.
   */
  apps?: readonly string[];
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
  /**
   * Seam: the credentialed child environment, and the identity the preflight reads off it.
   *
   * One seam, because they must be one value — the banner and the spawn consulting two resolutions is
   * exactly how a confident `sending for real` came to precede five silent failures (#555).
   */
  devCloudflareEnv?: (account: CloudflareAccountSelection | null, base: NodeJS.ProcessEnv) => DevCloudflareEnv;
  loadDevConfig?: (projectDir: string) => Promise<DevConfig | null>;
  /** Bootstrap seam: assign and persist pinned ports when the project has none yet. */
  ensureDevConfig?: (options: EnsureDevConfigOptions) => Promise<DevConfig>;
  /** Seams handed to the real {@link ensureDevConfig} (git branch, registry path, write). */
  ensureDeps?: EnsureDevConfigDeps;
  /**
   * This branch's local autostart answers (default: read from the port registry).
   *
   * A seam, and the only one that could make the resolution testable at this level: the registry read
   * needs a config directory, a git checkout and a branch, and a test driving `startDev` has none of
   * the three. Given, it is used as-is and nothing is read.
   */
  autostartOverrides?: Readonly<Record<string, boolean>>;
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
  /**
   * Seam: where a line goes.
   *
   * `origin` is the worker whose output this is, and it is absent for the session's own prose. The plain
   * renderer ignores it; the live roster filters on it, so a focused worker is decided on a value rather
   * than on a parse of the `[name]` prefix the line already carries in color (#670).
   */
  stdout?: (text: string, origin?: string) => void;
  /** Seam: where the prose goes when stdout is reserved for JSON (`--json`). */
  stderr?: (text: string, origin?: string) => void;
  /**
   * Where this session's structured events go, if anyone is listening.
   *
   * **Additive, never a replacement.** Every line this supervisor writes is written whether a sink is
   * installed or not — the stream is the contract `--json`, a pipe and `logs/dev.log` read, and
   * `orchestrator.test.ts` holds a run with a sink to writing byte-identical output to a run without one.
   * The sink exists so a live roster can render the state those lines describe (#670); under `--json`
   * there is none.
   */
  events?: DevEvents;
  /**
   * Seam: how a parked answer is written. The real one is `feature/ports.ts`'s, under its own file lock.
   *
   * Injected for the same reason every other writer here is — a case about what the roster *does* has no
   * business creating the operator's real config directory.
   */
  writeAutostart?: typeof setWorkerAutostart;
  /**
   * Whether a live roster is on screen, carrying every worker's state, port and address.
   *
   * **The one thing it changes is what the banner says.** With a table of those facts pinned directly
   * below it, the banner's `name: http://localhost:####` list is the same information printed twice, so
   * it is left out — and `logs/dev.log` still records every address, independently, as it always did.
   *
   * Keyed on this rather than on {@link events} being installed: a consumer that wants the structured
   * feed without rendering anything still gets every line of the stream it would otherwise have had.
   */
  roster?: boolean;
  /** Seam: the seeded dev login the ready banner offers, if `pithy seed` wrote one. */
  readDevLogins?: (projectDir: string) => Promise<DevLogins | undefined>;
  /**
   * Seam: ask which identity, for a list too long to number — an `@clack/prompts` `autocomplete`.
   *
   * Answers the chosen `userId`, or `undefined` when the prompt was canceled. A value rather than a
   * `DevLogin`, so the answer crosses the seam as the thing a person or a script could equally have named
   * and is resolved by {@link selectDevLogin} on the way back — including when it names nobody.
   */
  chooseDevLogin?: (logins: readonly DevLogin[]) => Promise<string | undefined>;
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
  /**
   * The seeded identities this session can sign in as — `userId`, `email`, `expiresAt`, and **no claim**.
   *
   * What `pithy dev --json` reports, and the surface an agent selects against. Empty when the seed wrote
   * none, when every claim has expired, and under `--json` exactly as under a banner: which identities
   * exist is a fact about the seed, not about who is reading.
   */
  identities: DevIdentity[];
  /** Resolves once every started worker has matched its ready signal (the ready banner fires). */
  ready: Promise<void>;
  /** Resolves once the session has fully torn down (all children gone, state removed). */
  closed: Promise<void>;
  /**
   * Restart one worker in place, on the same pinned port, without disturbing the session.
   *
   * Refuses a name this session is not running. A no-op once shutdown has begun.
   */
  restart: (worker: string) => Promise<void>;
  /**
   * Open a signed-in browser — what the `l` key does.
   *
   * On the handle because the live roster owns the keyboard when it is rendering, so the two key actions
   * have to be reachable from outside. `terminal/keys.ts` still binds them on the plain path.
   */
  devLogin: (worker?: string) => Promise<void>;
  /**
   * Every seeded identity that is still usable — `userId`, `email`, `expiresAt`, and **no claim**.
   *
   * Read as it is called, for the reason `devLogin` is: the record on disk is the truth, and a session
   * holding a copy from startup could not see a `pithy seed` run beside it. This is what the live
   * roster's identity picker renders, so the omission of the claim is enforced here rather than there.
   */
  listIdentities: () => Promise<DevIdentity[]>;
  /**
   * Sign in as one named identity — a `userId` or an `email`.
   *
   * What the picker calls once a choice is made. The resolution and all four of its refusals are
   * `selectDevLogin`'s, unchanged; `worker` scopes it the way {@link devLogin} does.
   */
  signInAs: (value: string, worker?: string) => Promise<void>;
  /**
   * Answer `devLogin`'s "which identity?" with a digit.
   *
   * **Inert unless a list is open**, which is what lets a renderer forward every digit without tracking
   * the mode. One digit consumes the choice, so a stray digit later opens nothing.
   */
  pickIdentity: (digit: string) => Promise<void>;
  /**
   * Where a worker answers, for **any** member of the dev set.
   *
   * `workers` is the startup snapshot, so it has no entry for one started later from a parked row — and
   * `o` resolving an origin from it lit the key up and then silently did nothing.
   */
  originOf: (worker: string) => string | undefined;
  /**
   * Park a worker, or unpark it: whether the **next** `pithy dev` on this branch starts it.
   *
   * What `pithy dev --app <name> --disable-autostart` writes, from the roster instead — the same
   * registry, the same key, the same three things it is scoped by (this checkout, this branch, this
   * machine), and nothing committed.
   *
   * **It changes the next run, never this one.** A worker parked while it is running keeps running, and
   * the roster says both — the two facts genuinely disagree until the session restarts, and pretending
   * otherwise on the row would be a lie about what is in front of you.
   */
  setAutostart: (worker: string, enabled: boolean) => Promise<void>;
  /** Tear the session down: SIGTERM every child group, SIGKILL survivors after a grace window, clean up. */
  shutdown: (reason: string) => Promise<void>;
  state: DevState;
}

/** How long a child gets to exit on SIGTERM before it is SIGKILLed. */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * How long a teardown waits after SIGKILL, and for the streams to end, before it stops waiting.
 *
 * **A teardown must end.** Both of these were awaited without a bound, and either one hanging meant the
 * session could not be stopped at all: `resolveClosed()` never ran, so the command never reached its
 * exit, and with the live roster holding raw mode a second Ctrl-C went to a handler that had already
 * begun shutting down. What an operator saw was `sending SIGKILL.` and then a dead prompt.
 *
 * Short, because by this point every child has had a full grace window *and* a SIGKILL: anything still
 * here is not going to leave, and the honest thing is to name it and go rather than wait on it forever.
 */
const REAP_TIMEOUT_MS = 2000;

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
 * The current branch, or `null` when there is no repo or HEAD is detached.
 *
 * One `rev-parse`, in `feature/worktree.ts` beside every other git lookup this package makes. This was
 * the second of three copies; `project/workerCommand.ts` held the third, and #548 would have added a
 * fourth. Identical semantics — `defaultGit` trims, and an empty or detached answer is `null`.
 */
async function defaultBranch(projectDir: string): Promise<string | null> {
  return currentBranch(defaultGit, projectDir);
}

/**
 * The three registry keys this branch's answers are filed under, or `null` when nothing can answer them.
 *
 * Resolved exactly as {@link ensureDevConfig} resolves them for the block, through the same seams — a
 * test that redirects the registry gets this redirected with it, and there is no second derivation of
 * *which branch am I* to disagree with the first.
 *
 * Off a branch the key is the checkout path, the same fallback the block uses. Two checkouts of one
 * repository in detached HEAD are two keys, which is the answer a developer would expect and the one
 * the ports already give.
 *
 * `null` is a checkout with no repository, no registry, or no readable config directory. That is the
 * state every project was in before any of this existed, and it is never a reason to refuse a dev run.
 */
async function resolveRegistryKeys(options: {
  projectDir: string;
  ensureDeps?: EnsureDevConfigDeps;
}): Promise<{ registryPath: string; root: string; branch: string } | null> {
  const deps = options.ensureDeps ?? {};
  try {
    const registryPath = await (deps.registryPathFor ?? defaultRegistryPath)(options.projectDir);
    const root = await (deps.rootFor ?? registryRootFor)(options.projectDir);
    const named = await (deps.branchFor ?? defaultBranch)(options.projectDir);
    return { registryPath, root, branch: named ?? `local:${options.projectDir}` };
  } catch {
    return null;
  }
}

/** What the registry says about autostart for this run: this branch's answers, and the lost ones. */
export interface AutostartResolution {
  /** Worker name → whether a plain `pithy dev` starts it. Empty when this branch has said nothing. */
  overrides: Record<string, boolean>;
  /**
   * Checkout roots that are gone from disk and still hold autostart answers (#685).
   *
   * Reported, never acted on. The dead root's branch key may itself be a path — `local:/old/app`, which
   * `ensureDevConfig` writes off a branch — so nothing here can match it to the current branch and
   * there is no worker name to honor a disable *for*. Only a root to name.
   */
  stale: StaleAutostartRoot[];
}

/**
 * What the registry says about this run's autostart set, and about answers it can no longer reach.
 *
 * **Exported because `--list` has to reach the same answer the run does.** It did not, for one commit:
 * the run resolved this and `printDevSet` called `listDevSet` without it, so a worker turned off still
 * listed as starting. Every test passed, because each injected `autostartOverrides` straight into
 * `listDevSet` and none of them went through the command. One function, both callers.
 *
 * **`autostartOverrides` short-circuits the answers and deliberately not the stale report.** An injected
 * set is a caller stating what this branch said; it is not a claim about which checkouts on the machine
 * still exist. Returning early for both would have made every seam-injecting test blind to the report —
 * the same divergence the paragraph above is the story of, one field across.
 */
export async function resolveAutostart(options: {
  projectDir: string;
  ensureDeps?: EnsureDevConfigDeps;
  autostartOverrides?: Readonly<Record<string, boolean>>;
}): Promise<AutostartResolution> {
  const keys = await resolveRegistryKeys(options);
  const overrides =
    options.autostartOverrides !== undefined
      ? { ...options.autostartOverrides }
      : keys === null
        ? {}
        : await readWorkerAutostart(keys).catch(() => ({}) as Record<string, boolean>);
  const stale =
    keys === null
      ? []
      : await staleAutostartRoots({ registryPath: keys.registryPath, keep: keys.root }).catch(() => []);
  return { overrides, stale };
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
    const root = await (options.rootFor ?? registryRootFor)(options.projectDir);
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
    const root = await (options.rootFor ?? registryRootFor)(options.projectDir);
    const named = await (options.branchFor ?? defaultBranch)(options.projectDir);
    // Off a branch (no repo, detached HEAD) the checkout path is the stable key — one block per checkout.
    branch = named ?? `local:${options.projectDir}`;
    // Rebuild any registry entry lost since the worktrees were created, so a fresh registry can never hand
    // out a block a live feature still holds. Scanned from the repository root, never from the registry's
    // own directory: the file sits in the config directory now, which has no `.worktrees` and never will,
    // so `dirname(registryPath)` would make this a silent no-op in every direction (#435). Filtered by
    // prune's own predicate (#637), so this never puts back a block prune frees, nor leaves out one it keeps.
    const reservations = await heldReservations(options.projectDir, await scanPinnedBlocks(root));
    await reclaimPortBlocks({ registryPath, root, reservations });
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
  const readDevLogins = options.readDevLogins ?? readDevLoginsDefault;
  const chooseDevLogin = options.chooseDevLogin ?? chooseDevLoginDefault;
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
  const emitLine = (text: string, origin?: string) => (options.json ? stderr : stdout)(`${text}\n`, origin);
  /**
   * The machine's half: one object per line, always on stdout, only under `--json`.
   *
   * Compact by construction. A session never ends, so a consumer reads it line by line and the framing
   * is the contract — `formatJsonStreamLine` is what says this is a stream rather than a document, and
   * keeps a terminal (or a PTY-allocating agent harness) from indenting it into something unreadable.
   */
  const emitJson = (payload: Record<string, unknown>) => stdout(`${formatJsonStreamLine(payload)}\n`);
  /**
   * Raise a session event, or do nothing at all.
   *
   * **It never throws into the supervisor.** A renderer is not allowed to be the reason `pithy dev` stops
   * supervising Workers, so a sink that fails is reported as a line, dropped, and the session carries on
   * with the stream it always had. This is the only place the sink is called, which is what makes that
   * guarantee one line rather than a convention.
   */
  let events = options.events;
  const raise = (event: DevEvent) => {
    if (!events) return;
    try {
      events(event);
    } catch (error) {
      events = undefined;
      emitLine(`The live roster stopped updating. ${messageOf(error)}`);
    }
  };

  // 1. Resolve the dev set — `apps/` plus the host Worker of every capability those Workers compose
  //    (pithy-sh/pithy#410). Through `resolveDevSet`, which is the one place membership is decided, so
  //    `pithy dev --list` describes the run this function makes rather than a second guess at it.
  //    This branch's own answer about what starts (#549) is resolved here, from the same three values the
  //    port block is keyed on. Best effort by construction: `readWorkerAutostart` never throws, so a
  //    registry that will not parse leaves every Worker starting — which is what it meant before.
  const { overrides, stale } = await resolveAutostart(options);
  const set = await resolveDevSet({
    projectDir,
    discoverWorkers,
    autostartOverrides: overrides,
    ...(options.projectName ? { projectName: options.projectName } : {}),
    ...(options.discoverHostWorkers ? { discoverHostWorkers: options.discoverHostWorkers } : {}),
  });
  for (const line of set.notes) emitLine(line);
  //    And the answers this run could *not* reach (#685). Said here, above every write, because the
  //    question it answers is the one a developer asks the moment the session starts — *why is the
  //    worker I parked running*. Through `emitLine`, so the prose lands on stderr under `--json` and the
  //    machine gets its own object instead: one event, not one per root, since a consumer reading a
  //    stream line by line should not have to correlate several to learn one fact.
  for (const line of describeStaleAutostartRoots(stale)) emitLine(line);
  if (options.json && stale.length > 0) emitJson({ command: "dev", event: "autostart-stale", roots: stale });
  const { project, hosts, hostNames } = set;
  const discovered = set.members.filter((m) => m.kind === "app").map((m) => m.worker);
  const members = set.members.map((m) => m.worker);

  //    What this run starts. `--app` names members outright — whatever this branch turned off, since
  //    naming one is the more specific act — and it is literal: no composed host comes along for the
  //    ride. Every name is resolved here, above every write below, so an unknown one refuses the run
  //    rather than letting half of it start and then die.
  const named = options.apps ?? [];
  const selected =
    named.length > 0 ? selectDevMembers(set.members, named) : set.members.filter((member) => member.autostart);
  if (selected.length === 0) {
    throw new ValidationError({
      message: "No autostart workers to run.",
      action: "Add one with pithy worker add, or re-enable one with pithy dev --app <name> --enable-autostart.",
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
  //    Over `members`, not over what this run starts. The set handed to `ensureDevConfig` and the set the
  //    write decision is made over have to be the same set, or `--app` narrows the file: `buildDevConfig`
  //    rebuilds its map from `{}` rather than merging into the previous one, so a narrowed call deletes
  //    every other member's pin and hands the named Worker the block's first port — and the next full run
  //    then renumbers the project off a `previous` holding one name. Ports survive a change in *which*
  //    workers run, which is the whole promise `--app` must not break.
  const unpinned = members.filter((w) => !existing?.workers[w.name]);
  const config =
    unpinned.length === 0 && existing
      ? existing
      : await ensure({ projectDir, workers: members, existing, ...(options.ensureDeps ?? {}) });

  /**
   * Every member of the dev set with the address it is pinned to — **including the ones this branch
   * parked.**
   *
   * `started` is the subset this run spawns. The difference matters twice: the roster lists the project
   * rather than the run, so a parked worker has a row (`pithy dev --list` has always named one), and
   * `restart` can *start* one, which is the only way to reach it without restarting the estate.
   */
  const roster: { worker: WorkerTarget; port: number; origin: string; kind: DevMemberKind; starts: boolean }[] = [];
  for (const member of set.members) {
    const pinned = config.workers[member.worker.name];
    if (!pinned) {
      throw new ValidationError({
        message: `Worker "${member.worker.name}" has no port in .dev.config.json.`,
        action: "Delete .dev.config.json and run pithy dev again to reassign this project's ports.",
      });
    }
    roster.push({
      worker: member.worker,
      port: pinned.port,
      origin: pinned.origin,
      kind: member.kind,
      starts: selected.some((s) => s.worker.name === member.worker.name),
    });
  }
  const started: { worker: WorkerTarget; port: number; origin: string }[] = roster.filter((entry) => entry.starts);

  //    Which hosts this run actually starts. Materializing a host's config is a disk write for a
  //    capability the run will not touch, so it follows the selection — while `hostPorts` below does
  //    not, deliberately.
  const selectedNames = new Set(selected.map((member) => member.worker.name));
  const selectedHosts = hosts.filter((host) => selectedNames.has(host.worker.name));

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
  //
  //     **`hostPorts` covers every host, not the selected ones.** `--app board` gives you board with
  //     `EMAIL_ORIGIN` pointing at something that is not running, and that is the answer that was asked
  //     for: a developer narrowing the dev set knows what they are narrowing, and an address nothing
  //     answers on is a clearer failure than a binding that is silently absent.
  //
  //     **Not the same case as the dropped host below**, which deletes its entry for the opposite
  //     reason. A host whose config would not resolve will not run in this project until somebody
  //     fixes it, so falling back to the Workflow binding is the recovery — that is #410's failure,
  //     where an enqueued message sat `pending` and nothing said so. A host that `--app` left out is
  //     one the developer excluded on purpose, this run, and a connection error naming the port is
  //     the honest answer to that; dispatching to the binding instead would put the run back in the
  //     state where mail disappears.
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
  let liveHosts: HostWorker[] = selectedHosts;
  let materializeHosts: ((options: MaterializeHostConfigsOptions) => Promise<HostMaterialization>) | undefined;
  let hostBaseUrl = "http://localhost";
  /** Whether delivery was resolved to the simulator, so a host materialized later is written the same way. */
  let hostsSimulateDelivery = false;
  /** Every composed host, so `restart` can write the config of one this run never started. */
  let allHosts: readonly HostWorker[] = [];
  let deliveryIsLive = false;
  // **Resolved here, before the preflight and before anything spawns, and exactly once.**
  // Two properties depend on the position. The preflight below decides whether this session sends real
  // mail, and it must decide from the credentials the children will *receive* — deciding from a second
  // resolution is how `Email: sending for real from noreply@pithy.sh.` came to be printed over workers
  // authenticating as a different tenant (#555). And a pinned `cloudflare.accountId` the credentials
  // contradict throws out of this call, which is #206's refusal finally reaching `pithy dev`: before, it
  // resolved no account at all, so there was nothing to compare and nothing to refuse.
  const cloudflare = (options.devCloudflareEnv ?? defaultDevCloudflareEnv)(
    options.account,
    options.baseEnv ?? process.env,
  );
  /*
    **Nothing is printed about which account this is. Using the project's is the expectation.**

    A line used to say so whenever the shell had exported `CLOUDFLARE_*` — on the grounds that `wrangler
    whoami` answers for the shell and nothing said the Workers use the project's. True, and the wrong
    place to say it: a developer whose shell holds a token for other work sees that line on every single
    run, forever, reporting that the normal thing happened. A banner that states the expectation is a
    banner people stop reading, which costs more than it buys on the lines that matter.

    **The refusal above is the part that had to stay**, and it is a throw rather than a line: a pinned
    `cloudflare.accountId` the credentials contradict stops the run before a Worker spawns. That is the
    case where the account is genuinely in question. `pithy doctor` reports the resolved account for
    anyone who wants to look, which is the place to answer a question rather than to volunteer one.
  */

  // **`hosts`, not `selectedHosts`.** The materializer and the host list below are what `restart` needs
  // to write a parked host's config when `r` starts it, and gating them on what *this* run selected left
  // both unset for a project whose only host is parked, so `r` spawned `wrangler dev` in a directory that
  // was never created. The eager materialize inside still covers only the hosts this run starts.
  if (project !== null && hosts.length > 0) {
    // The app's address: the first started Worker that is not a host. Callback links point at the
    // app, never at the host — the host holds no public route of its own.
    //
    // Under `--app <host>` no app Worker is running at all, and the fallback used to be `started[0]`,
    // which in that run *is* the host — so every link in a locally sent message pointed at a Worker
    // holding no public route. An app Worker's pinned address is the right answer whether or not this
    // run starts it: the port is pinned for the life of the feature, so it is where the app answers
    // the moment anyone starts it.
    //
    // Two tiers under it, in this order. An **autostart** app first, because the line above sees only
    // what this run started, which for a plain run is the first autostart app — so preferring any pinned
    // app would answer differently for `pithy dev` and for `pithy dev --app email` in a project holding
    // an opted-out Worker that sorts earlier. Then **any** pinned app, for the project whose Workers have
    // all opted out: there is no autostart app to agree with, and an opted-out Worker's pinned address is
    // still where the app answers when somebody starts it.
    //
    // And nothing after them. The old last resort was `started[0]`, which cannot help here: this branch
    // reaches its fallbacks only when `app` found no started non-host, so every started member is a host
    // and `started[0]` *is* one — a Worker holding no public route, which is the failure being fixed.
    const app = started.find((s) => !hostNames.has(s.worker.name));
    const pinnedOrigin = (member: DevSetMember | undefined): string | undefined =>
      member && config.workers[member.worker.name]?.origin;
    const isPinnedApp = (member: DevSetMember): boolean =>
      member.kind === "app" && config.workers[member.worker.name] !== undefined;
    const identity = await hostDeliveryIdentity(options.projectDir, selectedHosts);
    const preflight = deliveryPreflight({
      composed: identity !== undefined,
      requested: identity?.requested ?? "remote",
      fromAddress: identity?.fromAddress,
      cloudflare: cloudflare.identity,
    });
    deliveryLines = preflight.lines;
    deliveryIsLive = preflight.live;
    if (options.json) for (const line of preflight.lines) emitLine(line);
    hostBaseUrl =
      app?.origin ??
      pinnedOrigin(set.members.find((member) => isPinnedApp(member) && member.autostart)) ??
      pinnedOrigin(set.members.find(isPinnedApp)) ??
      "http://localhost";
    const materialize = options.materializeHostConfigs ?? materializeHostConfigsDefault;
    materializeHosts = materialize;
    hostsSimulateDelivery = !preflight.live;
    allHosts = hosts;
    // **Only the hosts this run starts are written now.** Materializing one the run will not touch is a
    // disk write for nothing, and `naming what starts` holds that line: `--app <an app worker>` writes
    // no host config at all. The seams above are assigned regardless, because `restart` needs them to
    // write a parked host's config at the moment `r` starts it.
    if (selectedHosts.length > 0) {
      const materialized = await materialize({
        projectDir,
        project,
        baseUrl: hostBaseUrl,
        hosts: selectedHosts,
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
      liveHosts = selectedHosts.filter((host) => !dropped.has(host.worker.name));
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
  const devLogins = await readDevLogins(projectDir);
  const log = openLog(logPath);
  log.write(
    `=== dev session ${now().toISOString()} — ${started.map((s) => `${s.worker.name}:${s.port}`).join(", ")} ===`,
  );
  // The credentialed environment from above, not `process.env` again: this is what every child inherits,
  // so the account the session reported is the account the children actually use (#555).
  const baseEnv = cloudflare.env;
  // The keypress follows the route. Under CI the auth capability registers none, so `l` would open a
  // 404 — the read is the same one the capability makes, from the same module, and it is the only
  // refusal the supervisor can see coming rather than discover.
  const ci = isContinuousIntegration(baseEnv);
  // Which running workers carry `GET /__pithy/dev-login` — the ones composing auth. Resolved only when
  // there is a session to open, so a project with no dev login never loads a Worker config for this.
  // An empty record is still a record, and `{}` is truthy — so the question is whether anything usable is
  // in it. Without this a project whose claims have all expired loads every worker's config to resolve
  // targets for a banner that will print nothing.
  const hasDevIdentity = usableDevLogins(devLogins, now()).length > 0;
  /**
   * Which running workers carry `GET /__pithy/dev-login`, resolved **when something needs them** and
   * remembered after.
   *
   * The optimization is the same one it always was — a project with no dev login never loads a Worker
   * config to answer a question nobody asked — but it used to be spent at startup against the record as
   * it stood *then*, and that quietly made the whole feature unavailable for the life of a session that
   * started unseeded. `pithy seed` in another terminal updated the record, `l` re-read it, found an
   * identity, and still had nowhere to open it: the targets had been resolved once, to `[]`, because at
   * that moment there was nothing to open. So the laziness moved to where it belongs.
   *
   * Memoized rather than re-resolved per keypress: `started` is fixed for the session and a restart keeps
   * a worker's pinned port, so no worker's origin can change under it.
   */
  let resolvedLoginTargets: DevLoginTarget[] | undefined;
  const loginTargets = async (): Promise<DevLoginTarget[]> => {
    // Under CI the route is not registered in any composition, so there is nothing to resolve and
    // nothing to remember.
    if (ci) return [];
    // **Over the whole dev set, not the startup subset.** `started` is what this run spawned, so a
    // worker that `r` started from a parked row was refused by name by the very key the roster had just
    // lit up. The same class of bug `originOf` was changed to fix; this one was missed.
    resolvedLoginTargets ??= await resolveDevLoginTargets(
      roster
        .filter((entry) => !hostNames.has(entry.worker.name))
        .map((entry) => ({ name: entry.worker.name, dir: entry.worker.dir, origin: entry.origin })),
    );
    return resolvedLoginTargets;
  };
  // **Primed when the record already holds an identity**, which is exactly what the eager version did —
  // so the banner stays synchronous and a seeded session behaves as it always has. The lazy path above is
  // for the case this used to get wrong: a seed that arrives after the session is up.
  if (hasDevIdentity) await loginTargets();
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

  // The ready deadline's timer, replaced by the live watch as soon as a child is running, and whether a
  // watch is currently armed. Declared here for the same reason `keys` is: the banner and the shutdown
  // both stop it, and both are written above the `startWorker` that arms it.
  let readyWatch: ReadyWatch = { stop: () => {} };
  let watching = false;

  /**
   * **Start the ready deadline for whoever has not arrived, unless one is already running**
   * (pithy-sh/pithy#429, #684).
   *
   * `wrangler dev` does not exit when a build fails — it prints the error and keeps running. So a worker
   * that cannot build is a live child that never matches its ready signal: the banner waits on the whole
   * set and never fires, and the session proceeds looking healthy with the real error forty lines up the
   * scrollback, interleaved with every sibling's startup. Three capability workers reached an adopter
   * that way (#426). The deadline names whoever has not arrived, and keeps naming them.
   *
   * **A child that fails to build is deliberately not treated as dead — it is reported, and left.** The
   * tempting alternative loses on three counts. A death here is not local: the exit handler tears the
   * *whole* session down when any child exits, so condemning one broken build would stop every healthy
   * worker for one worker's typo, which is a worse trade than a line naming it. The verdict would have to
   * be read out of wrangler's own output (`Build failed with 1 error`), which is version-coupled prose,
   * and a false positive kills a working session — while a `dev.command` worker is not wrangler at all,
   * and Vite does recover from a bad build. And the deadline already catches strictly more than a build
   * failure: a port that never binds, a binding that never resolves, a startup that hangs. So the watch
   * reports; it never condemns.
   *
   * It does say what a restart cannot be avoided for. A `wrangler dev` whose **first** build fails never
   * rebuilds — fixing the file changes nothing, measured, so the report's action line names `pithy dev`
   * rather than implying the session will heal itself.
   *
   * **`--json` gets a record, not the prose.** CLAUDE.md makes every command agent-drivable, and the
   * agent driving `pithy dev --json` is in exactly the position #426's adopter was: a session that never
   * emits its ready line, and nothing on the wire saying which worker is missing. A sentence it would
   * have to regex is not an answer, so the deadline emits one JSON line per report — the same
   * line-per-object shape as the handshake, `event` naming which kind of line it is. That is the one
   * place `pithy dev`'s streaming surface owes a machine something the handshake cannot carry: the
   * handshake is written the moment the children are spawned, and readiness is decided after it. It is
   * also the *only* thing on that stream after the handshake — `exited`, `spawned` and `ready` are
   * `DevEvent`s, and the event sink is wired from the roster, which `--json` never renders. The prose
   * still goes to `logs/dev.log` in both modes; the log is read by a person either way.
   *
   * **Called per spawn, and idempotent — never a stop and re-arm (#684).** Every spawn runs through
   * {@link startWorker}, startup and `restart` alike, which is the one path the two cannot diverge on.
   * The guard is what makes that safe: `r` is reachable before the banner — `commands/dev.ts` mounts the
   * roster first and `startDev` returns before every worker is ready — so re-arming would hand a worker
   * eighty-nine seconds into its budget another ninety, and pressing `r` repeatedly would starve the
   * report #426 exists for indefinitely. The price, stated: a worker restarted into a live watch inherits
   * that clock and can be named with little budget of its own. A line that arrives early beats a report
   * that never arrives.
   *
   * The flag cannot drift from the watch. `watchReady` only ends itself when its pending set is empty at
   * a tick (`readyWatch.test.ts`, *goes quiet once the set empties*), and every transition to ready runs
   * through {@link showBannerIfReady}, which is where the flag is cleared when that set empties.
   *
   * **The deadline is measured from a spawn, as `docs/commands/dev.md` says — now the first rather than
   * the last.** The startup loop is synchronous, so on a cold start the two are the same instant to
   * within a fraction of a millisecond; what moved is which function owns the decision.
   */
  const armReadyWatch = () => {
    // A spawn racing a teardown must not leave a timer the session no longer owns. `restart` re-checks
    // `shuttingDown` before it spawns, so this is belt and braces for the one that does not.
    if (watching || shuttingDown) return;
    watching = true;
    readyWatch = watchReady({
      // **Read off `readyState`, not off the subset this run spawned.** A worker `r` started from a
      // parked row is running and not ready, and sourcing `started` meant it could never be named —
      // while the all-ready check below already waited on it, so the banner and the deadline disagreed
      // about who counts. `docs/commands/dev.md` §`--json` already describes the wider set. Live at
      // every tick, so a worker that arrives late drops out of the next report on its own.
      pending: () => [...readyState].filter(([, isReady]) => !isReady).map(([name]) => name),
      report: (waiting, first) => {
        // Both destinations, the way the banner's own lines go: a report only in the terminal is a report
        // a piped session loses, and `logs/dev.log` is where a developer looks after the fact.
        raise({ event: "waiting", workers: [...waiting] });
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
  };

  /**
   * Stop the reporter, and say that none is running.
   *
   * Deliberately not the same act as showing the banner. They were one call for as long as a session
   * reached *every worker ready* once, and `r` made that false: a restarted worker is not ready, so the
   * deadline has work again while `bannerShown` must stay true (#684).
   */
  const stopReadyWatch = () => {
    watching = false;
    readyWatch.stop();
  };

  const showBannerIfReady = () => {
    if ([...readyState.values()].some((r) => !r)) return;
    // Everything has arrived, so the reporter has nothing left to say — whether or not this is the first
    // time it has been true. Above the `bannerShown` return, because stopping the watch is the half that
    // has to happen on every arrival.
    stopReadyWatch();
    if (bannerShown) return;
    bannerShown = true;
    raise({ event: "session-ready" });
    if (!options.json) {
      // Bindings go live with the banner, not before it: `l` opens a URL, and a URL that answers is a
      // worker that has already matched its ready signal. `--json` gets none — its output is being read
      // by a script, and a supervisor that entered raw mode for a machine would be holding a terminal
      // nobody is at.
      startKeys();
      // Left to the roster when there is one: every row says `ready` and the footer has stopped ticking,
      // so the word is the same fact a second time. `logs/dev.log` records it either way.
      if (!options.roster) emitLine("Ready.");
      // Left to the roster when there is one — the same facts, in a table, one line above. The log
      // below records them either way.
      if (!options.roster) for (const s of started) emitLine(`${s.worker.name}: ${s.origin}`);
      // Said once, where a developer actually looks. Real delivery or the simulator is the difference
      // between a magic link arriving and a rendered file on disk, and nobody should learn it from an
      // inbox that stays empty. Every line of the verdict, action included — a sentence naming the
      // problem without the sentence naming the fix is half a report.
      for (const line of deliveryLines) emitLine(line);
      // The banner is the discovery mechanism **when there is no roster**. A seeded session nobody finds
      // has removed no friction, and without a footer this line is the only place a developer reliably
      // looks after `pithy dev`. It says that there is a session and how to reach it, never what the
      // session *is*.
      //
      // With a roster, `l login` on the key bar is that discovery, and pressing it says what there is —
      // so the line is one more sentence under a table that already answers it.
      for (const line of options.roster
        ? []
        : devLoginLines(devLogins, now(), {
            interactive: keys.active,
            // Already resolved above when there was an identity to offer; the banner never waits on a disk.
            targets: resolvedLoginTargets ?? [],
            ci,
          })) {
        emitLine(line);
      }
      emitLine(dim(`logs → ${logPath}`));
    }
    for (const s of started) log.write(`ready: ${s.worker.name} ${s.origin}`);
    resolveReady();
  };

  /**
   * Open one identity's dev login, whichever way it was chosen.
   *
   * The decision is {@link devLoginKeyAction}'s and is made without touching the terminal, so the only
   * work here is saying it and handing the URL over. A failed open is reported and survived: `pithy dev`
   * supervises workers, and no browser is a reason for a sentence, not for tearing a session down.
   */
  const openIdentity = async (login: DevLogin | undefined, worker?: string): Promise<void> => {
    const targets = await loginTargets();
    /**
     * **A named worker is the answer, not a hint.**
     *
     * Without one, `devLoginKeyAction` picks: the worker carrying a UI wins and a tie prints the choices.
     * That is right for a session with nothing to read an intent from. The live roster has a marker on a
     * row, and an app stack can carry **several** front ends — so when the caller names one, that is the
     * one, and a name with no dev-login route is refused rather than quietly redirected to a sibling. A
     * browser signed into an origin you did not ask for is worse than a sentence.
     */
    if (worker !== undefined && !targets.some((target) => target.name === worker)) {
      emitLine(`${worker} serves no dev login — nothing there composes auth.`);
      if (targets.length > 0) emitLine(dim(`  try: ${targets.map((target) => target.name).join(", ")}`));
      return;
    }
    const scoped = worker === undefined ? targets : targets.filter((target) => target.name === worker);
    const action = devLoginKeyAction(login, now(), scoped, ci);
    for (const line of action.lines) emitLine(line);
    if (!action.url) return;
    try {
      await openUrl(action.url);
    } catch (error) {
      emitLine(messageOf(error));
    }
  };

  /**
   * The identities `l` has just listed and is waiting on a digit for.
   *
   * **It lasts exactly one keypress.** Empty before `l` and empty again after any digit, in range or not,
   * so the window is the interaction the printed list asked for and nothing longer. Left armed it would
   * outlive the question: somebody reads the list, thinks better of it, and a port number pasted into the
   * terminal an hour later opens a signed-in browser as whoever that index named. `l` re-arms it, so
   * declining a choice costs nothing.
   */
  let pendingIdentities: readonly DevLogin[] = [];
  /** Which worker `l` was pressed on, so the digit that answers it opens that one. */
  let pendingWorker: string | undefined;

  /**
   * `l` — choose who to be, then open a signed-in browser.
   *
   * **The user axis composes in front of the worker logic, never into it — `#667`.** All this decides is
   * which `DevLogin` {@link openIdentity} is handed; what happens next is the same four shapes it always
   * was. One identity is handed straight over, because a project seeding one user has nothing to choose.
   */
  const openDevLogin = async (worker?: string): Promise<void> => {
    /**
     * **Read as the key is pressed, not as the session started.**
     *
     * The startup read above is the *banner's* — "so the banner never waits on the disk once the workers
     * are up" — and that reasoning does not reach a keypress. While this closed over it, `pithy seed` run
     * against a session already up could never be seen by that session, and the refusal it got said
     * `Run pithy seed, then press l again` — the one remedy that could not possibly work. A developer
     * pressed `l` twice against a freshly seeded project and was told both times that nothing was seeded.
     *
     * A human just pressed a key, so this can afford a file read; and the record on disk is the truth in
     * both directions — an identity that expired during a long session stops being offered, too.
     */
    const logins = await readDevLogins(projectDir);
    const choice = devLoginChoice(logins, now());
    if (choice.kind === "only") {
      await openIdentity(choice.login, worker);
      return;
    }
    // **Before asking who.** Under CI no route is registered, and with nothing composing auth there is
    // nothing to open — neither refusal depends on which identity would have been picked, and making
    // somebody choose first only to tell them that is a worse sentence for the same information.
    if (ci || (await loginTargets()).length === 0) {
      await openIdentity(choice.logins[0], worker);
      return;
    }
    if (choice.kind === "keys") {
      pendingIdentities = choice.logins;
      pendingWorker = worker;
      for (const line of devLoginChoiceLines(choice.logins)) emitLine(line);
      return;
    }
    /**
     * **With a roster on screen there is no prompt to fall back to — so this never prompts.**
     *
     * The branch below hands the terminal to a prompt and takes it back after, which works because
     * `terminal/keys.ts` owns raw mode and can give it up. Ink cannot: it holds the terminal for the life
     * of the session, and the reader it is handed is inert, so a prompt and the footer would both read
     * the keyboard and neither would work.
     *
     * **A backstop rather than the path.** `l` under a roster goes to the identity picker
     * (`dev/tui/identityPicker.tsx`), which reaches every identity with the arrows and never comes here.
     * This covers a direct `devLogin()` call — the method is public — and it covers it the only way that
     * works without a prompt: the first nine on the keys, and the overflow named rather than dropped.
     */
    if (options.roster) {
      const offered = choice.logins.slice(0, MAX_KEY_CHOICES);
      pendingIdentities = offered;
      pendingWorker = worker;
      for (const line of devLoginChoiceLines(offered)) emitLine(line);
      emitLine(dim(`  ${choice.logins.length} identities seeded; name one as \`user\` in dev.json for the rest.`));
      return;
    }
    // Past nine there is no digit left to bind, so it is a prompt — and a prompt reads its own stdin, so
    // the terminal has to come out of raw mode for it and go back in after, whatever the prompt did.
    keys.stop();
    try {
      const chosen = await chooseDevLogin(choice.logins);
      if (chosen === undefined) {
        emitLine("Nothing opened.");
        return;
      }
      const selection = selectDevLogin(logins, now(), chosen);
      for (const line of selection.lines) emitLine(line);
      if (selection.login) await openIdentity(selection.login, worker);
    } finally {
      // Unless the session went away underneath the prompt. `shutdown` gave the terminal its own Ctrl-C
      // handling back; starting a reader after it would exit with raw mode on, and a shell that echoes
      // nothing is exactly what `keys.stop()` exists to prevent.
      if (!shuttingDown) startKeys();
    }
  };

  /** A digit — the identity `l` numbered, when `l` is waiting for one. Inert at every other moment. */
  /** Park or unpark one worker for this branch. See {@link DevHandle.setAutostart}. */
  const setAutostart = async (worker: string, enabled: boolean): Promise<void> => {
    if (!roster.some((entry) => entry.worker.name === worker)) {
      throw new ValidationError({
        message: `This project has no worker called ${worker}.`,
        action: `Its dev set is: ${roster.map((entry) => entry.worker.name).join(", ")}.`,
      });
    }
    const deps = options.ensureDeps ?? {};
    const registryPath = await (deps.registryPathFor ?? defaultRegistryPath)(projectDir);
    const root = await (deps.rootFor ?? registryRootFor)(projectDir);
    const named = await (deps.branchFor ?? defaultBranch)(projectDir);
    await (options.writeAutostart ?? setWorkerAutostart)({
      registryPath,
      root,
      branch: named ?? `local:${projectDir}`,
      workers: [worker],
      enabled,
    });
    raise({ event: "autostart", worker, autostart: enabled });
    const said = enabled
      ? `${worker} starts on this branch again.`
      : `${worker} no longer starts on this branch. It keeps running until this session ends.`;
    // **Recorded always, said only when there is no roster.** With an `autostart` column flipping from
    // `on` to `off` in front of you, and the row still reading `ready`, the sentence is the same fact a
    // third time — there is nothing left to guess at. `logs/dev.log` keeps it either way, because a
    // change to a file the developer cannot see belongs in the record.
    log.write(said);
    if (!options.roster) emitLine(said);
  };

  /** Every usable identity, read now. See {@link DevHandle.listIdentities}. */
  const listIdentities = async (): Promise<DevIdentity[]> => devLoginIdentities(await readDevLogins(projectDir), now());

  /** Sign in as one named identity. See {@link DevHandle.signInAs}. */
  const signInAs = async (value: string, worker?: string): Promise<void> => {
    const logins = await readDevLogins(projectDir);
    const selection = selectDevLogin(logins, now(), value);
    for (const line of selection.lines) emitLine(line);
    if (selection.login) await openIdentity(selection.login, worker);
  };

  const pickIdentity = async (key: string): Promise<void> => {
    if (pendingIdentities.length === 0) return;
    const login = pickDevLoginByKey(pendingIdentities, key);
    // Consumed either way: a digit past the end of the list is an answer to the question, and the question
    // is not asked again until `l` is.
    pendingIdentities = [];
    const worker = pendingWorker;
    pendingWorker = undefined;
    if (login) await openIdentity(login, worker);
  };

  // Scoped to `l` and the digits it hands out. A second *command* is one more entry here — `r` to restart
  // and `o` to open the app are the obvious neighbors — and neither is this issue.
  let keys: KeyReader = { active: false, stop: () => {} };
  const startKeys = () => {
    keys = readKeys({
      bindings: [
        { key: "l", run: openDevLogin },
        // Bound always, and inert until `l` has listed something: a reader's bindings are fixed when it
        // starts, so the choice is state rather than a second reader with a second raw-mode handover.
        ...DIGIT_KEYS.map((key) => ({ key, run: () => pickIdentity(key) })),
      ],
      // Raw mode takes the terminal's own Ctrl-C handling away, so the supervisor has to put it back.
      // Without this line `pithy dev` becomes unstoppable from the keyboard.
      onInterrupt: () => void shutdown("interrupted"),
      onError: (error) => emitLine(messageOf(error)),
    });
  };

  /**
   * Write a host's generated config before starting it, if it has one and this run never wrote it.
   *
   * A capability host does not live in `apps/` — its `wrangler.jsonc` is resolved from the capability's
   * committed template into `.wrangler/pithy/hosts/<capability>/` on every run, and only for the hosts
   * the run *starts*: materializing one the run will not touch is a disk write for nothing. That makes
   * starting a parked host with `r` a two-step act, because `wrangler dev` in a directory that was never
   * created fails on the spawn itself.
   *
   * A no-op for an `apps/` Worker. **Not** for a host already written: there is no such check, so a
   * second `r` on a running host rewrites its generated config and re-emits its notes. Harmless, since
   * the write is idempotent in content, but said plainly because the comment is what a later reader
   * trusts.
   */
  const materializeIfHost = async (name: string): Promise<void> => {
    const host = allHosts.find((candidate) => candidate.worker.name === name);
    // No project name means no host was materialized on the way up either — `resolveProjectName`'s
    // guesses are not stable enough to name a resource, and the full run already said so.
    if (!host || !materializeHosts || project === null) return;
    try {
      const written = await materializeHosts({
        projectDir,
        project,
        baseUrl: hostBaseUrl,
        hosts: [host],
        simulateDelivery: hostsSimulateDelivery,
      });
      for (const line of written.notes) emitLine(line);
    } catch (error) {
      // Said, never fatal: a host whose template will not resolve is one worker that does not start,
      // exactly as it is on a full run.
      emitLine(`${name}: its config could not be written. ${messageOf(error)}`);
    }
  };

  /** Workers being deliberately killed and respawned, so their exits are not read as a crash. */
  const restarting = new Set<string>();
  /** Each worker's current child's exit, so a restart can wait for the old one to actually go. */
  const exitOf = new Map<string, Promise<void>>();

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
    // Through the helper, so nothing can arm a replacement watch behind the teardown: `shuttingDown` is
    // already true above, and `armReadyWatch` reads it.
    stopReadyWatch();
    emitLine(`Stopping — ${reason}.`);
    log.write(`stopping — ${reason}`);
    for (const { child } of children) signalChild(child.pid, "SIGTERM");
    const allExited = Promise.allSettled(exits);
    const timedOut = await Promise.race([allExited.then(() => false), sleep(SHUTDOWN_GRACE_MS).then(() => true)]);
    if (timedOut) {
      emitLine("Children still alive after grace window — sending SIGKILL.");
      for (const { child } of children) signalChild(child.pid, "SIGKILL");
      // **Bounded.** A child that survives SIGKILL — an unkillable process group, a pid already reused,
      // a platform that will not deliver it — must not keep the supervisor alive on its behalf.
      const reaped = await Promise.race([allExited.then(() => true), sleep(REAP_TIMEOUT_MS).then(() => false)]);
      if (!reaped) {
        // Named, with pids, because what is left is now the operator's to deal with and they cannot act
        // on "something survived".
        const survivors = children.map(({ name, child }) => `${name}${child.pid ? ` (${child.pid})` : ""}`);
        emitLine(`Still alive after SIGKILL: ${survivors.join(", ")}. Stopping anyway — kill them by hand.`);
      }
    }
    // Bounded for the same reason: a stream that never ends is a teardown that never finishes, and the
    // log below is flushed either way.
    await Promise.race([Promise.allSettled(pipes), sleep(REAP_TIMEOUT_MS)]);
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

  // The project, before the run: every member with its pinned port and whether this branch starts it.
  raise({
    event: "roster",
    members: roster.map((entry) => ({
      worker: entry.worker.name,
      kind: entry.kind,
      port: entry.port,
      // **From the live `started`, not from the flag computed before anything was dropped.** A host
      // whose config will not resolve is spliced out of `started` above, and a roster built from the
      // earlier answer gave that worker a `building` row nothing could ever move: no spawn, no exit, and
      // the ready deadline reads `started` too. It kept a spinner under a `Ready.` banner and kept the
      // 80ms repaint going for the life of the session.
      starts: started.some((s) => s.worker.name === entry.worker.name),
      // This branch's own answer, from `dev-ports.json`. Absent means it starts — there is no state
      // where the file's silence has to be interpreted (#549).
      autostart: overrides[entry.worker.name] !== false,
    })),
    at: now(),
  });

  // Same: the roster lists every one of them, by name, with its state. The log keeps the line.
  if (!options.roster) emitLine(`Starting ${started.map((s) => s.worker.name).join(", ")}.`);

  /**
   * **Start one member of the dev set and wire it up.** Called once per worker at startup, and again by
   * {@link restart} for one of them.
   *
   * It exists as a function rather than as the body of the startup loop because a restart has to do
   * *exactly* this and nothing less: the ready state, the ready regex, the origin a host does not get,
   * the argv, both carriers of the dev vars, the delivery watch on a host's output, both streams tee'd to
   * the terminal and to `logs/dev.log`, and the exit handler. A second, shorter spawn path would be a
   * second set of those decisions, and the first one to drift would be the one nobody ran twice.
   *
   * `index` is the worker's position in `started`, and it is passed in rather than read off
   * `children.length` so **a restarted worker keeps its color**. Derived from the array length, a
   * replacement would be painted as if it were a new worker, and its rows and its log prefix would stop
   * matching mid-session.
   */
  const startWorker = ({ worker, port, origin }: (typeof started)[number], index: number): void => {
    readyState.set(worker.name, false);
    readyRegex.set(worker.name, readyRegexFor(worker));
    // A host is handed no origin of its own: `materializeHostConfigs` already wrote the app's into its
    // generated config, which is the address its callback links must carry. See `ownOriginFor`.
    const ownOrigin = ownOriginFor(worker.name, origin, hostNames);
    const { command, args } = startCommand(worker, port, ownOrigin, launchWrangler, persistTo, baseEnv, hostPorts);
    // Both carriers, from the one value above. The argv `--var` reaches a `wrangler dev`; the
    // environment reaches a custom `dev.command`, where there is no argv to append to and
    // `@pithy-sh/vite` turns it into the same binding.
    const env = childEnvFor(childEnv, ownOrigin);
    const child = spawn(command, args, { cwd: worker.dir, env, detached: hasSetsid });
    // Replaced in place on a restart, so `shutdown` signals the child that is actually running and the
    // state file names its pid.
    const seat = children.findIndex((entry) => entry.name === worker.name);
    if (seat === -1) children.push({ name: worker.name, child });
    else children[seat] = { name: worker.name, child };
    // The roster distinguishes an `apps/` Worker from a capability host, so the kind is raised with the
    // spawn rather than inferred later from a name.
    raise({
      event: "spawned",
      worker: worker.name,
      kind: hostNames.has(worker.name) ? "host" : "app",
      port,
      at: now(),
    });

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
      /**
       * **Readiness is per worker and tracked always; the *banner* is what fires once.**
       *
       * This opened with `if (bannerShown || …) return`, and the first clause was free until `r` existed:
       * once every worker had arrived, no later ready signal could matter. With a restart it is a bug —
       * a respawned worker printed `Ready on http://localhost:8791`, the line was dropped, and its row
       * stayed on `building` for the rest of the session. `showBannerIfReady` carries the once-only
       * guard itself, which is where it belongs.
       */
      if (readyState.get(worker.name)) return;
      if (readyRegex.get(worker.name)?.test(line)) {
        readyState.set(worker.name, true);
        raise({ event: "ready", worker: worker.name, at: now() });
        showBannerIfReady();
      }
    };
    const paint = workerColor(index);
    // The worker's name, so a focused roster can filter on a value rather than on a parse of the
    // `[name]` prefix this has already colorized (#670).
    const terminal = (line: string) => emitLine(line, worker.name);
    if (child.stdout) {
      pipes.push(
        teeStream({
          stream: child.stdout,
          label: worker.name,
          paint,
          sinks: { terminal, log: (l) => log.write(l), line: onLine },
        }),
      );
    }
    if (child.stderr) {
      pipes.push(
        teeStream({
          stream: child.stderr,
          label: worker.name,
          paint,
          sinks: { terminal, log: (l) => log.write(l), line: onLine },
        }),
      );
    }

    const exited = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        resolve();
        // **Whether we caused it.** A teardown exits every child and a restart exits one on purpose, so
        // neither is a failure — and the live roster only reveals a worker's output for an exit nobody
        // asked for. Without this, `q` revealed all five at once.
        raise({ event: "exited", worker: worker.name, code, expected: restarting.has(worker.name) || shuttingDown });
        // A restart kills this child on purpose, and the whole point is that the session survives it.
        if (restarting.has(worker.name)) return;
        if (!shuttingDown) void shutdown(`${worker.name} exited (${code})`);
      });
      // A spawn failure (ENOENT for a missing dev.command binary, EACCES, …) emits 'error' and never 'exit'.
      // Without this listener Node re-throws it as an uncaught error, crashing dev with a raw stack and never
      // shutting down. Handle it: report it, settle this child's exit, and tear the session down.
      child.once("error", (error) => {
        emitLine(`${worker.name} failed to start: ${error.message}`);
        log.write(`error: ${worker.name} ${error.message}`);
        resolve();
        // **A failed spawn is an exit, and has to be raised as one.** Node emits `error` and never
        // `exit`, so raising nothing left the roster holding a `building` row, spinner and all, with the
        // footer repainting for a process that does not exist. `null` is the code for the same reason a
        // signaled child reports it: there was never an exit status to report.
        raise({
          event: "exited",
          worker: worker.name,
          code: null,
          expected: restarting.has(worker.name) || shuttingDown,
        });
        if (restarting.has(worker.name)) return;
        if (!shuttingDown) void shutdown(`${worker.name} failed to start`);
      });
    });
    exits.push(exited);
    exitOf.set(worker.name, exited);
    // **Last, after the child exists**, so the deadline is measured from a worker that is actually
    // running. Here rather than after the startup loop because `restart` spawns through this same
    // function, and a watch armed in one place and not the other is the divergence this function's
    // docblock exists to prevent — the bug #684 fixed was exactly that, one field over.
    armReadyWatch();
  };

  // Indexed over the whole set, so a worker's color is its own whether it started with the run or was
  // started later by `r` — and two runs of the same project paint the same worker the same way.
  for (const entry of started)
    startWorker(
      entry,
      roster.findIndex((r) => r.worker.name === entry.worker.name),
    );

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

  /**
   * Re-record the live session.
   *
   * A restart replaces a child, so the pid in `.dev-state.json` changes — and that file is what a re-run
   * reads to reap the previous session. A stale pid there is harmless, because the reaper checks whether
   * it is alive; a **missing** one leaks a `workerd` that nothing will ever clean up.
   */
  const recordState = async (): Promise<void> => {
    await writeState(statePath, {
      pid: ownPid,
      startedAt: state.startedAt,
      childPids: children.map((c) => c.child.pid).filter((pid): pid is number => typeof pid === "number"),
      workers: Object.fromEntries(
        children.map(({ name, child }) => [
          name,
          // **From the roster, not from `started`.** A worker `r` started from parked is running — it is
          // in `children` — but it was never in the subset this run spawned, so looking it up there
          // recorded `port: 0`, which `DevState` refuses. The ZodError reached the terminal as a raw
          // issue array, and a re-run would have had no port to reap it on.
          { port: roster.find((entry) => entry.worker.name === name)?.port ?? 0, pid: child.pid ?? 0 },
        ]),
      ),
    });
  };

  /**
   * **Restart one worker, in place.** `docs/commands/dev.md` names the failure this answers: a
   * `wrangler dev` whose first build fails never rebuilds, so fixing the file and waiting is the one
   * thing that cannot work — and until now the only remedy was Ctrl-C and restarting the estate.
   *
   * The old child's **process group** is signaled, because `wrangler` spawns `workerd` beneath it and
   * only the group reaches both; then the same grace window `shutdown` uses, then SIGKILL. The
   * replacement takes the same pinned port, because a worker that moved would break every sibling that
   * was told its address before it started.
   */
  const restart = async (name: string): Promise<void> => {
    // Respawning into a teardown would leave a child nothing is waiting on and nothing will signal.
    if (shuttingDown) return;
    /**
     * **One restart per worker at a time.**
     *
     * `onRestart` fires on every keypress with no debounce, and a restart takes a grace window — so a
     * second `r` lands inside the first. Without this both calls found the same child, both awaited the
     * same exit, and both spawned: two `wrangler dev` on one pinned port, with the first replacement
     * referenced by nothing, so `shutdown` never signaled it and `.dev-state.json` never named it.
     * Ignored rather than queued: the second press meant *restart it*, which the first is already doing.
     */
    if (restarting.has(name)) return;
    const index = roster.findIndex((entry) => entry.worker.name === name);
    if (index === -1) {
      throw new ValidationError({
        message: `This project has no worker called ${name}.`,
        action: `Its dev set is: ${roster.map((entry) => entry.worker.name).join(", ")}.`,
      });
    }
    const member = roster[index];
    if (!member) return;

    restarting.add(name);
    try {
      const previous = children.find((entry) => entry.name === name);
      const gone = exitOf.get(name);
      // **Nothing to kill when nothing was running.** A worker this branch parked has no child, so `r`
      // on its row is a *start* — the only way to reach it without restarting the estate.
      if (!previous) {
        emitLine(`Starting ${name}...`);
        await materializeIfHost(name);
      }
      if (previous) {
        emitLine(`Restarting ${name}...`);
        signalChild(previous.child.pid, "SIGTERM");
        if (gone) {
          const timedOut = await Promise.race([gone.then(() => false), sleep(SHUTDOWN_GRACE_MS).then(() => true)]);
          if (timedOut) {
            signalChild(previous.child.pid, "SIGKILL");
            // **Bounded, as `shutdown`'s wait is.** A child that survives SIGKILL hung the restart
            // forever — and because the `finally` never ran, the worker stayed in `restarting`, which
            // made the exit handler swallow a later genuine crash of it.
            await Promise.race([gone, sleep(REAP_TIMEOUT_MS)]);
          }
        }
      }
      /**
       * **Re-checked after the waits, not only on entry.**
       *
       * Those awaits can span five seconds, and a `q` inside that window runs the whole teardown: it
       * signals the children of that instant, waits out the exits it snapshotted, removes
       * `.dev-state.json` and resolves `closed`. Resuming here would then spawn a child nothing is
       * signaling and rewrite the state file the teardown had just deleted — and the command exits with
       * that child still running.
       */
      if (shuttingDown) return;
      startWorker(member, index);
      // **Cleared before the state write, not after it.** `recordState` writes a file, and a
      // replacement that died inside that window was raised as an *expected* exit: the roster did not
      // reveal the output explaining it, and the shutdown was suppressed. The restart is over once the
      // child exists; the bookkeeping after it is not part of it.
      restarting.delete(name);
      await recordState();
    } finally {
      restarting.delete(name);
    }
  };

  // The identity the footer names, and only ever the email — the same omission the banner makes, for the
  // same reason: a session claim rendered as text is a session claim at rest in a scrollback, a log and a
  // screenshot (#667). With several seeded identities the footer names the one `l` would reach first;
  // which identities exist is what `--json` reports.
  const identities = devLoginIdentities(devLogins, now());
  // A name only when there is one to name: with several, `l` opens a picker and the roster says how many
  // rather than choosing for you.
  raise({
    event: "login",
    email: identities.length === 1 ? (identities[0]?.email ?? null) : null,
    count: identities.length,
  });

  return {
    workers: started.map((s) => ({ name: s.worker.name, port: s.port, origin: s.origin })),
    identities,
    ready,
    closed,
    restart,
    devLogin: openDevLogin,
    originOf: (worker: string) => roster.find((entry) => entry.worker.name === worker)?.origin,
    setAutostart,
    listIdentities,
    signInAs,
    pickIdentity,
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

/**
 * The digits `l` can hand out — derived from {@link MAX_KEY_CHOICES} rather than written out beside it.
 *
 * Nine of them, because there is no tenth digit to bind, which is the whole reason 10+ identities get a
 * prompt instead. Listing them by hand left two statements of one number, and lowering the constant would
 * have left digits bound past the end of the printed list.
 */
const DIGIT_KEYS = Array.from({ length: MAX_KEY_CHOICES }, (_, index) => String(index + 1));

/**
 * Ask which identity, for a list too long to number — `@clack/prompts`' filterable `autocomplete`.
 *
 * Imported at the point of use, as every prompt in the CLI is: `pithy dev` starts a supervisor, and a
 * session that never presses `l` should not pay to load a prompt library it never shows.
 *
 * **The label is the email and the value is the user id.** Filtering runs on what a person recognizes;
 * what comes back is what the record is keyed by. A claim is neither, and appears in neither.
 */
async function chooseDevLoginDefault(logins: readonly DevLogin[]): Promise<string | undefined> {
  const { autocomplete, isCancel } = await import("@clack/prompts");
  const chosen = await autocomplete({
    message: "Which identity?",
    options: logins.map((login) => ({ value: login.userId, label: login.email })),
  });
  return isCancel(chosen) ? undefined : String(chosen);
}
