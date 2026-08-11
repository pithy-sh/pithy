// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { platform as osPlatform, release as osRelease } from "node:os";
import { join } from "node:path";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { type BuildReconcilePlanOptions, buildReconcilePlan, type ReconcilePlan } from "../capabilities/reconcile";
import { pithyOffline } from "../cloudflare/config";
import { type CloudflareAccess, checkCloudflareAccess, describeCloudflareAccess } from "../doctor/cloudflare";
import { checkDevPreferences, type DevPreferencesCheck, describeDevPreferences } from "../doctor/devPreferences";
import {
  checkDevSecrets,
  checkDevSecretsLocation,
  type DevSecretsCheck,
  type DevSecretsLocationCheck,
  describeDevSecrets,
  describeDevSecretsLocation,
  devSecretsHealthy,
} from "../doctor/devSecrets";
import { checkDevVars, type DevVarsCheck, describeDevVars, devVarsHealthy } from "../doctor/devVars";
import { checkDevVarsLocal, type DevVarsLocalCheck, describeDevVarsLocal } from "../doctor/devVarsLocal";
import { checkEnvironments, describeEnvironmentDrift, type EnvironmentsCheck } from "../doctor/environments";
import { buildProjectHealth, type ProjectHealth, type WorkerHealth } from "../doctor/health";
import { checkProjectName, describeProjectName, type ProjectNameCheck } from "../doctor/projectName";
import { checkSecretBindings, describeSecretBindings, type SecretBindingsCheck } from "../doctor/secretBindings";
import { checkWorkerNames, describeWorkerName, type WorkerNameCheck } from "../doctor/workerName";
import { type FetchLike, fetchLatestVersion } from "../notifier/check";
import { detectInstaller, type Installer, upgradeCommandFor } from "../notifier/installer";
import { readState, setNotifierFlag, stateDir, stateFilePath, writeState } from "../notifier/state";
import { classifyBump } from "../notifier/version";
import { readRcFile } from "../platform/rc";
import { detectShell, type ShellInfo } from "../platform/shell";
import { loadProject, type ProjectConfig, projectCloudflareAccount } from "../project/config";
import { checkOrigins, describeOriginDrift, type OriginsCheck } from "../project/domains";
import { checkExtensions, describeExtension, type ExtensionsCheck } from "../project/extensions";
import { type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { checkWorkflows, describeWorkflowDrift, type WorkflowsCheck } from "../project/workflows";
import { formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy doctor` (docs/CLI.md §5.6): the user-initiated health check. It bypasses the 24-hour notifier
 * cache for a fresh registry query, reports the full toolchain state (CLI version, shell/alias, config,
 * project capability versions) plus a `Project health` block — `pithy upgrade`'s reconcile in read-only
 * mode — and exits non-zero when a health check fails so CI can gate on drift. Toolchain state alone never
 * fails the exit. Outside a Pithy project the `Project:` line says there is no config here and every other
 * `Project*` line is omitted — including `Project name:`, because with no project there is no name question.
 *
 * The health block is **per Worker**: each Worker under `apps/` carries its own `pithy.config.ts` and
 * `wrangler.jsonc`, so each drifts on its own. Any unhealthy Worker fails the exit. `--worker <name>`
 * narrows the block to one — the same flag `migrate`, `seed`, `upgrade`, and `env` take (docs/CLI.md §1.1),
 * so CI can gate on a single Worker's health.
 */

/** The alias-block marker `pithy alias` writes — reused here to detect an installed `p.` shortcut. */
const ALIAS_MARKER = "# >>> pithy alias >>>";

/**
 * Whether the `p.` alias is installed — **three states, because a boolean cannot say "I could not tell"**
 * (#210).
 *
 * The rc file is the one thing in this report `doctor` reads out of the adopter's own shell config, and
 * an unreadable one — wrong mode, a dangling symlink, an `EIO` — used to throw out of
 * {@link buildDoctorReport} and take the entire report with it: Cloudflare reachability, the secrets
 * paths, project health, dev secrets. The least important line in the report cost every other line.
 *
 * Catching it to `false` is not the fix, and is why #203 stopped at making the failure legible.
 * `Alias: not installed` about a file nothing could read is a lie, and the adopter's next move on reading
 * it is `pithy alias` — which fails on the same file. So the third state is said out loud, and it names
 * the file, which is the only thing anybody can act on.
 */
export type AliasState = "installed" | "not-installed" | "unknown";

/** The alias line's whole answer: which state, about which file, and why when nobody could tell. */
export interface AliasStatus {
  state: AliasState;
  /** The rc file the answer is about, or `null` when no shell was detected and none was resolved. */
  rcPath: string | null;
  /**
   * Why the file would not read. Set exactly when {@link AliasStatus.state} is `unknown`.
   *
   * The refusal's own sentence — `readRcFile` owns those words (#203) — and never a byte of the file's
   * contents: an rc file is where a developer keeps `export GITHUB_TOKEN=…`.
   */
  reason: string | null;
}

/**
 * One actionable sentence from a thrown failure — `message` and `action`, never `detail`.
 *
 * `detail` is throw-site context and the HTTP codec strips it for a reason; these lines reach a terminal
 * and `--json`.
 */
function messageOf(error: unknown): string {
  if (error instanceof PithyError) return `${error.payload.message} ${error.payload.action ?? ""}`.trim();
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the rc file and answer all three ways it can go.
 *
 * No shell is `not-installed` rather than `unknown`: nothing was refused, there is simply no rc file this
 * platform's detection would write to, and `pithy alias` prints manual instructions for exactly that case.
 */
async function aliasStatus(shell: ShellInfo | null, readRc: (path: string) => Promise<string>): Promise<AliasStatus> {
  if (!shell) return { state: "not-installed", rcPath: null, reason: null };
  try {
    const contents = await readRc(shell.rcPath);
    return {
      state: contents.includes(ALIAS_MARKER) ? "installed" : "not-installed",
      rcPath: shell.rcPath,
      reason: null,
    };
  } catch (error) {
    return { state: "unknown", rcPath: shell.rcPath, reason: messageOf(error) };
  }
}

const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * Whether a version could be compared against the registry at all.
 *
 * **`unknown` exists because a boolean cannot say "I did not find out".** The registry lookup fails for
 * ordinary reasons — offline, an outage, a package not published yet — and collapsing that into
 * `upToDate: true` made `doctor` report currency it had never established. A diagnostic that answers
 * confidently when it could not check is worse than one that says nothing.
 */
export type VersionState = "current" | "outdated" | "unknown";

/** The CLI-version block of the report. */
export interface CliStatus {
  installed: string;
  latest: string | null;
  installer: Installer;
  state: VersionState;
  upgradeCommand: string;
}

/** One installed project capability's version state. */
export interface CapabilityStatus {
  name: string;
  installed: string;
  latest: string | null;
  state: VersionState;
}

/** The project-scoped portion of the report; `null` outside a Pithy project. */
export interface ProjectStatus {
  capabilities: CapabilityStatus[];
  health: ProjectHealth;
}

/** The complete doctor report — the structured source both the text and `--json` renderers project from. */
export interface DoctorReport {
  cli: CliStatus;
  shell: ShellInfo | null;
  /** Whether the `p.` alias is installed, or whether its rc file could not be read at all (#210). */
  alias: AliasStatus;
  configDir: string;
  stateFile: string;
  notifierEnabled: boolean;
  notifierDisabledBy: "env" | "state" | null;
  project: ProjectStatus | null;
  /** Set when a `pithy.config.ts` is present but could not be loaded (e.g. dependencies not installed). */
  projectLoadError: string | null;
  /** Whether the configured Cloudflare credentials actually reach the account. */
  cloudflare: CloudflareAccess;
  /**
   * Whether the configured project name still matches the names this project's resources were provisioned
   * under — `null` when the root config could not be read, so no name question arises. Set from the same
   * `loadProject` outcome as {@link DoctorReport.project} and {@link DoctorReport.projectLoadError}, which
   * is what keeps the two blocks from disputing whether there is a project here.
   */
  projectName: ProjectNameCheck | null;
  /**
   * Whether each Worker's three names still agree — its `apps/<dir>`, its deployed script name, and its
   * `WORKER` var. `null` outside a readable project, on the same `loadProject` outcome as
   * {@link DoctorReport.projectName}: with no project there are no Workers to name.
   */
  workerNames: WorkerNameCheck | null;
  /**
   * Whether every Worker's `env.<name>` stanzas are the environments the root config declares (#241), and
   * whether a declaration changed after resources were provisioned under the old names. `null` outside a
   * readable project, on the same `loadProject` outcome as the two above: with no declaration there is
   * nothing to compare a stanza to.
   */
  environments: EnvironmentsCheck | null;
  /**
   * Whether every environment this project declares names every origin it answers on (#253). `null`
   * outside a readable project, on the same `loadProject` outcome as the checks above: with no declared
   * set there is nothing to ask about.
   *
   * The question `pithy deploy` refuses on, asked without being asked — so an environment with no origin,
   * or one whose `workers.dev` subdomain nobody decided about, is findable before a deploy is attempted
   * rather than at the end of one.
   */
  origins: OriginsCheck | null;
  /**
   * Whether each declared environment's `wrangler.jsonc` stanza binds exactly the Workflows and cron its
   * Worker's app capability declares (#267). `null` outside a readable project, or one that names no
   * project — a Workflow name leads with the project, so without one there is nothing to compare.
   *
   * The one fault in this report that is otherwise **completely silent**. A declared job that was never
   * synced ships with no `workflows` entry and no `triggers.crons`: the cron never fires, and no request
   * fails, no log line appears and no probe goes red to say so.
   */
  workflows: WorkflowsCheck | null;
  /**
   * What an adopter plugged into a capability — a Better Auth plugin composed through the auth
   * capability's config is the first (#271). `null` outside a readable project, on the same
   * `loadProject` outcome as the checks above: with no Workers there is nothing composed to read.
   *
   * It reports and **never fails the exit**, and it is the only block here that is not about a fault.
   * An extension an adopter deliberately added is not drift. What it must not be is invisible: it has
   * no `package.json` for `Project capabilities:` to name it from, and it adds routes to the Worker and
   * tables to the database all the same.
   */
  extensions: ExtensionsCheck | null;
  /**
   * This project's dev-login preference file: where it goes, whether it is there, and whether it says
   * anything a seed can use. `null` outside a readable project, on the same footing as the two above.
   *
   * It sits in the report because nothing else could say it. `dev.json` is machine-local and named by
   * nothing in the checkout, and until this line doctor reported one config directory while `pithy seed`
   * read a different one — so a developer whose dev login was not working looked where doctor pointed and
   * found nothing, correctly.
   */
  devPreferences: DevPreferencesCheck | null;
  /**
   * Whether any declared `d1`-backed secret is still sitting in `.dev.vars`, and whether the secrets file
   * is readable by anyone but its owner. `null` outside a project that composes `secrets` — with no
   * registry there is no declared name, and so no misplaced one.
   *
   * It reports and never fails the exit. Every project that predates the dev secrets file has misplaced
   * secrets by definition, and an upgrade that turns a green `pithy doctor` red in CI over a file that
   * still works is a surprise rather than a diagnosis. Migration is told, not enforced.
   */
  devSecrets: DevSecretsCheck | null;
  /**
   * Whether every declared environment binds the `cf-secrets-store` secrets its Worker reads (#238).
   * `null` outside a project that composes `secrets` — with no registry there is nothing to bind.
   *
   * It reports and never fails the exit, on the same rule its neighbours follow: every project that
   * composed `secrets` and has not yet run `pithy secrets provision` is in this state, and so is every
   * project that predates the stanza existing at all. That is a step not yet taken rather than a
   * contradiction. What it must not be is silent — until this line the only thing that reported a
   * missing binding was the Worker's own 500 on its first request.
   */
  secretBindings: SecretBindingsCheck | null;
  /**
   * What is in a `.dev.vars.local` that nothing else in the project knows about — a key that exists only
   * in dev, and a key that shadows a registry secret. `null` when there is nothing to say, which is every
   * project with no `.dev.vars.local` anywhere.
   *
   * It reports and never fails the exit, for the reason {@link ./devVarsLocal} gives: both states are
   * legitimate, and neither may be invisible.
   */
  devVarsLocal: DevVarsLocalCheck | null;
  /**
   * The two `.dev.vars` questions nothing else asks: whether each Worker's generated file actually
   * carries anything, and whether the project root's hand-written one is still holding values nothing
   * reads. `null` outside a readable project, on the same footing as the checks above.
   *
   * It reports and never fails the exit, for the same reason {@link DoctorReport.devSecrets} does not:
   * every project that predates the generated file (#154) is in this state by definition, and an
   * upgrade that turns a green `pithy doctor` red in CI is a surprise rather than a diagnosis. What it
   * must not be is silent — until #178 the only thing that reported either was a 500 from a running
   * Worker naming the bindings it did not have.
   */
  devVars: DevVarsCheck | null;
  /**
   * Where this project's dev secrets file is, and whether it is there. `null` outside a project with a
   * resolvable name, on the same footing as {@link DoctorReport.devPreferences}.
   *
   * **Separate from {@link DoctorReport.devSecrets}, and reported even when that one is `null`.** That
   * check needs a registry to compare against, so a project that has not composed `secrets` yet gets no
   * answer from it — and a location is still the question an adopter has, because the file is outside
   * the checkout (#156) and nothing in the project names it. It never fails the exit and it is not a
   * term in the terse predicate: a path is not a fault. It prints in **both** forms of the report for
   * that same reason (#166) — a healthy project is the one most likely to be asking where the file is.
   */
  devSecretsFile: DevSecretsLocationCheck | null;
  os: { name: string; version: string };
  /** The runtime actually executing, which under Bun is not what `process.versions.node` reports. */
  runtime: RuntimeInfo;
  node: string;
  /**
   * Whether this run refused ambient credentials and every network call — `PITHY_OFFLINE`, or `--offline`
   * (#218).
   *
   * Carried in the report rather than read again at each renderer, because the two things it changes are
   * both *wordings*: a version state of `unknown` means "the registry did not answer" on an ordinary run
   * and "nobody asked it" on this one, and a diagnostic that reports the first when the second happened is
   * describing a network fault that does not exist. `--json` carries it for the same reason one level up —
   * a script reading `state: "unknown"` cannot otherwise tell a skipped check from a failed one.
   */
  offline: boolean;
}

/**
 * The interpreter running the CLI.
 *
 * Reporting `process.versions.node` alone is actively wrong under Bun: Bun sets it to the Node version it
 * emulates, so `doctor` would name a runtime that is not executing — the one thing a diagnostic must not do.
 * Both are kept, because the emulated level is what the `engines.node >= 22` floor is judged against.
 */
export interface RuntimeInfo {
  /** `Bun` or `Node`. */
  name: string;
  /** The runtime's own version. */
  version: string;
  /** The Node version being emulated, when the runtime is not Node itself. */
  nodeCompat: string | null;
}

/** Detect the executing runtime. `process.versions.bun` is Bun-only and absent from Node's typings. */
export function detectRuntime(versions: NodeJS.ProcessVersions = process.versions): RuntimeInfo {
  const bun = (versions as { bun?: string }).bun;
  if (bun) return { name: "Bun", version: bun, nodeCompat: versions.node };
  return { name: "Node", version: versions.node, nodeCompat: null };
}

/** Classify an installed version against what the registry returned — `unknown` when it returned nothing. */
export function versionState(installed: string, latest: string | null): VersionState {
  if (latest === null) return "unknown";
  return classifyBump(installed, latest) === "none" ? "current" : "outdated";
}

/** Map a Node platform id to a human OS name. */
function osName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

/** Options for {@link buildDoctorReport} — every environment and network dependency is injectable for tests. */
export interface DoctorReportOptions {
  projectDir: string;
  /** Narrow the health block to one Worker, by name or `apps/<dir>` basename. Every Worker when omitted. */
  worker?: string;
  installedVersion?: string;
  fetch?: FetchLike;
  now?: () => number;
  stateFile?: string;
  argv1?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  os?: { name: string; version: string };
  /** Runtime seam; defaults to {@link detectRuntime}. */
  runtime?: RuntimeInfo;
  node?: string;
  /**
   * Refuse ambient credentials and every network call. Defaults to {@link pithyOffline} over `env`.
   *
   * The flag's route in. Explicit `false` is a caller saying so and the variable does not override it —
   * the same reading `CloudflareConfigOptions.offline` takes, because the two have to agree or a run is
   * offline in one half of itself.
   */
  offline?: boolean;
  /** Shell detection seam; defaults to {@link detectShell}. */
  detectShell?: () => Promise<ShellInfo | null>;
  /** rc-file reader seam; defaults to {@link readRcFile}. */
  readRc?: (path: string) => Promise<string>;
  /** Installed-capability enumerator seam; defaults to scanning `node_modules/@pithy-sh/*`. */
  installedCapabilities?: (projectDir: string) => Promise<{ name: string; version: string }[]>;
  /** Project-config loader seam; defaults to {@link loadProject} (a `NotFoundError` marks "outside a project"). */
  loadProject?: (projectDir: string) => Promise<ProjectConfig>;
  /** Worker-set resolver seam; defaults to {@link resolveWorkers}. The health block reports one entry per Worker. */
  resolveWorkers?: (options: { projectDir: string; worker?: string }) => Promise<ResolvedWorker[]>;
  /** Health plan-builder seam, forwarded to {@link buildProjectHealth}. */
  buildPlan?: (options: BuildReconcilePlanOptions) => Promise<ReconcilePlan>;
  /** Migration-count seam for the health plan. */
  countPending?: BuildReconcilePlanOptions["countPending"];
  /**
   * Cloudflare-credential probe seam; defaults to {@link checkCloudflareAccess}. Injected so unit tests
   * never call out. It takes no project directory: the credentials are account-scoped (#182), so the
   * answer is the same in every checkout on this machine.
   */
  checkCloudflare?: () => Promise<CloudflareAccess>;
  /** Project-name probe seam; defaults to {@link checkProjectName}. Injected so unit tests never call out. */
  checkProjectName?: (projectDir: string) => Promise<ProjectNameCheck | null>;
  /** Worker-name agreement seam; defaults to {@link checkWorkerNames}. Reads files only — no account call. */
  checkWorkerNames?: (projectDir: string) => Promise<WorkerNameCheck>;
  /** Environment-declaration seam; defaults to {@link checkEnvironments}. Reads files only — no account call. */
  checkEnvironments?: (projectDir: string) => Promise<EnvironmentsCheck>;
  /** Origin-declaration seam; defaults to {@link checkOrigins}. Reads files only — no account call. */
  checkOrigins?: (projectDir: string) => Promise<OriginsCheck>;
  /** App-Workflow binding seam; defaults to {@link checkWorkflows}. Reads files only — no account call. */
  checkWorkflows?: (projectDir: string) => Promise<WorkflowsCheck>;
  /**
   * Dev-login preference seam; defaults to {@link checkDevPreferences} resolved against the same `homedir`
   * and `env` the config directory is, so the line can never name a path this report did not resolve.
   */
  checkDevPreferences?: (projectDir: string) => Promise<DevPreferencesCheck | null>;
  /** Seam: whether this project's secrets are in the file they belong in, without loading real configs. */
  checkDevSecrets?: (projectDir: string) => Promise<DevSecretsCheck | null>;
  /** Seam: whether every declared environment binds the Secrets Store entries its Worker reads. */
  checkSecretBindings?: (projectDir: string) => Promise<SecretBindingsCheck | null>;
  /** Seam: what this project's `.dev.vars.local` files carry that nothing else declares. */
  checkDevVarsLocal?: (projectDir: string) => Promise<DevVarsLocalCheck | null>;
  /**
   * Seam: whether each Worker's generated `.dev.vars` carries anything, and what the root one is
   * holding that nothing reads. Resolved against the same `homedir` and `env` every other per-project
   * path in this report is, so the file it names can never be one this report did not resolve.
   */
  checkDevVars?: (projectDir: string) => Promise<DevVarsCheck | null>;
  /**
   * Dev-secrets location seam; defaults to {@link checkDevSecretsLocation} resolved against the same
   * `homedir` and `env` the config directory is, so the line can never name a path this report did not
   * resolve — the defect #131 fixed for `dev.json`, in the file beside it.
   */
  checkDevSecretsFile?: (projectDir: string) => Promise<DevSecretsLocationCheck | null>;
}

/** Enumerate installed `@pithy-sh/*` packages (excluding the CLI itself) with their versions, name-sorted. */
export async function installedCapabilityVersions(projectDir: string): Promise<{ name: string; version: string }[]> {
  const scopeDir = join(projectDir, "node_modules", "@pithy-sh");
  let entries: string[];
  try {
    entries = await readdir(scopeDir);
  } catch {
    return [];
  }
  const found: { name: string; version: string }[] = [];
  for (const entry of entries) {
    if (entry === "cli") continue; // the CLI binary is the top block, not a project capability
    try {
      const raw = await readFile(join(scopeDir, entry, "package.json"), "utf8");
      const version = (JSON.parse(raw) as { version?: string }).version;
      if (typeof version === "string") found.push({ name: `@pithy-sh/${entry}`, version });
    } catch {
      // No package.json / unreadable — skip it.
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Build the full structured report — always querying the registry fresh (doctor bypasses the notifier cache). */
export async function buildDoctorReport(options: DoctorReportOptions): Promise<DoctorReport> {
  const installed = options.installedVersion ?? VERSION;
  const env = options.env ?? process.env;
  const argv1 = options.argv1 ?? process.argv[1] ?? "";
  const installer = detectInstaller(argv1);
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? Date.now;
  const file = options.stateFile ?? stateFilePath();
  const detect = options.detectShell ?? (() => detectShell());
  const readRc = options.readRc ?? readRcFile;
  const listCapabilities = options.installedCapabilities ?? installedCapabilityVersions;
  // The account this project belongs to, read before the probe so `doctor` reports on the credentials
  // this project's own commands resolve. Outside a project there is none, and the unnamed file is the
  // right answer — a config that will not load is what the `Project:` line is for, not this one.
  const account = await projectCloudflareAccount(options.projectDir).catch(() => null);
  // Resolved once, here, and handed down. Every consumer of it below is asking the same question, and a
  // report that computed it twice could answer differently in its own two halves.
  const offline = options.offline ?? pithyOffline(env);
  const probeCloudflare =
    options.checkCloudflare ??
    (() => checkCloudflareAccess({ ...(options.homedir ? { homedir: options.homedir } : {}), env, account, offline }));
  const probeProjectName = options.checkProjectName ?? checkProjectName;
  const probeWorkerNames = options.checkWorkerNames ?? checkWorkerNames;
  const probeEnvironments = options.checkEnvironments ?? checkEnvironments;
  const probeOrigins = options.checkOrigins ?? checkOrigins;
  const probeWorkflows = options.checkWorkflows ?? checkWorkflows;
  const probeDevPreferences =
    options.checkDevPreferences ??
    ((dir: string) => checkDevPreferences(dir, { ...(options.homedir ? { homedir: options.homedir } : {}), env }));
  const probeDevSecrets = options.checkDevSecrets ?? ((dir: string) => checkDevSecrets({ projectDir: dir }));
  const probeSecretBindings =
    options.checkSecretBindings ?? ((dir: string) => checkSecretBindings({ projectDir: dir }));
  const probeDevVarsLocal = options.checkDevVarsLocal ?? ((dir: string) => checkDevVarsLocal({ projectDir: dir }));
  const probeDevVars =
    options.checkDevVars ??
    ((dir: string) =>
      checkDevVars({
        projectDir: dir,
        paths: { ...(options.homedir ? { homedir: options.homedir } : {}), env },
      }));
  const probeDevSecretsFile =
    options.checkDevSecretsFile ??
    ((dir: string) => checkDevSecretsLocation(dir, { ...(options.homedir ? { homedir: options.homedir } : {}), env }));

  // Fresh CLI-version check, then persist it into the notifier state (installer detected once when unknown).
  //
  // **Not asked at all when offline.** This one is unauthenticated and reaches npm rather than Cloudflare,
  // so it is not the credential leak #218 is about — but a mode that says no network and then blocks for a
  // DNS timeout on a plane has told the adopter something untrue, and the state it would land in
  // (`unknown`) is the same one a registry outage produces. Skipping it keeps `unknown` meaning one thing
  // per run, which the two version lines then say in the run's own words.
  const cliLatest = offline ? null : await fetchLatestVersion("cli", { fetch: doFetch });
  const state = await readState(file);
  // Discarded on failure, like every read in this command and for the same reason (#210). The notifier
  // cache is bookkeeping for the *next* run — a config directory that will not take a write is exactly
  // the machine somebody runs `doctor` on, and losing the whole report over a file nothing in it reports
  // is the shape this command exists to not have.
  await writeState(file, {
    ...state,
    lastCheck: now(),
    latestVersion: cliLatest?.version ?? state.latestVersion,
    securityFlagged: cliLatest?.securityFlagged ?? state.securityFlagged,
    installer: state.installer === "unknown" ? installer : state.installer,
  }).catch(() => undefined);

  const cli: CliStatus = {
    installed,
    latest: cliLatest?.version ?? null,
    installer,
    state: versionState(installed, cliLatest?.version ?? null),
    upgradeCommand: upgradeCommandFor(installer),
  };

  // Shell / alias. The rc read is the only one in this report that reaches into the adopter's own shell
  // config, and it is the least important line here — so it becomes a state rather than an exception.
  const shell = await detect();
  const alias = await aliasStatus(shell, readRc);

  // Notifier state for display.
  const disabledByEnv = Boolean(env.PITHY_NO_UPDATE_NOTIFIER);
  const disabledByState = state.notifier === false;
  const notifierEnabled = !disabledByEnv && !disabledByState;
  const notifierDisabledBy = disabledByEnv ? "env" : disabledByState ? "state" : null;

  // Project block — omitted outside a Pithy project.
  let project: ProjectStatus | null = null;
  let projectLoadError: string | null = null;
  // Filled from the resolved Workers below, where the composed capabilities are already in hand — this
  // check needs no file of its own and reaches nothing.
  let extensions: ExtensionsCheck | null = null;
  const load = options.loadProject ?? loadProject;
  const resolve = options.resolveWorkers ?? resolveWorkers;
  // Set the moment the root config loads, so a `core/not_found` raised *later* (no workers under apps/)
  // is reported as a broken project rather than mistaken for "outside a project".
  let inProject = false;
  try {
    await load(options.projectDir);
    inProject = true;
    const installedCaps = await listCapabilities(options.projectDir);
    const capabilities: CapabilityStatus[] = [];
    for (const cap of installedCaps) {
      const unscoped = cap.name.replace("@pithy-sh/", "");
      const latest = offline ? null : await fetchLatestVersion(unscoped, { fetch: doFetch });
      capabilities.push({
        name: cap.name,
        installed: cap.version,
        latest: latest?.version ?? null,
        state: versionState(cap.version, latest?.version ?? null),
      });
    }
    const workers = await resolve({
      projectDir: options.projectDir,
      ...(options.worker !== undefined ? { worker: options.worker } : {}),
    });
    extensions = checkExtensions(workers.map((worker) => ({ name: worker.name, capabilities: worker.capabilities })));
    const health = await buildProjectHealth({
      projectDir: options.projectDir,
      env: "dev",
      // The same account the `Cloudflare:` block above reports on, resolved once at the top of this
      // function. A doctor that counted pending migrations against one account and named another in the
      // line beside it would be two reports in one (#234).
      account,
      workers: workers.map((worker) => ({ name: worker.name, dir: worker.dir, capabilities: worker.capabilities })),
      buildPlan: options.buildPlan,
      countPending: options.countPending,
    });
    project = { capabilities, health };
  } catch (error) {
    if (error instanceof PithyError && !inProject && error.payload.code === "core/not_found") {
      project = null; // outside a Pithy project — omit the Project* lines entirely
    } else if (error instanceof PithyError) {
      // A pithy.config.ts is present but the project could not be read — its config would not load (most often:
      // dependencies not installed), or it holds no Worker to check. Degrade to a toolchain report with an
      // actionable project line rather than aborting: a diagnostic command must still work in exactly the
      // broken-environment case it exists to diagnose. Drives a non-zero exit below.
      projectLoadError = `${error.payload.message} ${error.payload.action ?? ""}`.trim();
    } else {
      throw error; // a genuine CLI bug — keep its stack
    }
  }

  // Credentials are checked whether or not a project loaded: `.dev.vars` is read from the directory, and
  // "are my credentials right" is a question worth answering before `pithy init` as much as after.
  const cloudflare = await probeCloudflare();
  // The name is different, and it is asked only of a project whose root config actually loaded. It is not a
  // question about the directory, it is a question about a config: "is the `name` in this file still the one
  // every provisioned resource was named under". With no readable config there is no name and no question,
  // and the `Project:` block below already reports which of the two happened. Gated on the same `inProject`
  // that block is written from, so neither can contradict the other about whether a project is here.
  const projectName = inProject ? await probeProjectName(options.projectDir) : null;
  // The same question one level down, and gated the same way. `checkProjectName` asks whether this
  // project's name still names its resources; this asks whether each Worker's own three names still name
  // one Worker. Files only, so it costs nothing and answers offline.
  const workerNames = inProject ? await probeWorkerNames(options.projectDir) : null;
  // And once more, one level out: the declaration is project-wide, so with no readable config there is
  // nothing to compare each Worker's stanzas to. Files only, so it answers offline like the two above.
  const environments = inProject ? await probeEnvironments(options.projectDir) : null;
  // One level further out again, and gated the same way: an environment is declared, and now what is
  // true *about* it — where it answers — must be too. Files only, so it answers offline like the rest.
  const origins = inProject ? await probeOrigins(options.projectDir).catch(() => null) : null;
  // The same shape once more, on the other thing a `pithy.config.ts` declares and a `wrangler.jsonc` has
  // to agree with: the app capability's Workflows and cron. Files only, so it answers offline like the rest.
  const workflows = inProject ? await probeWorkflows(options.projectDir).catch(() => null) : null;
  // Gated the same way once more: `dev.json` is keyed by the project's own name, so with no readable config
  // there is no path to resolve and no file to look for. Files only, no account, no seed run.
  const devPreferences = inProject ? await probeDevPreferences(options.projectDir) : null;
  // Gated the same way, and files only: the two `.dev.` files and each Worker's registry. No account, no
  // database, no seed run — so it answers offline, in the project that is not working.
  const devSecrets = inProject ? await probeDevSecrets(options.projectDir).catch(() => null) : null;
  // The same registry, asked about the deployed environments rather than the local file. Files only once
  // more: whether a store *entry* exists is provisioning's question, and this one is whether the stanza
  // that would bind it is there at all (#238).
  const secretBindings = inProject ? await probeSecretBindings(options.projectDir).catch(() => null) : null;
  // Gated the same way, and asked separately: this one needs no registry, so it answers for a project
  // that has never composed `secrets` — which is the project most likely to be asking where the file is.
  const devSecretsFile = inProject ? await probeDevSecretsFile(options.projectDir).catch(() => null) : null;
  const devVarsLocal = inProject ? await probeDevVarsLocal(options.projectDir).catch(() => null) : null;
  // Gated the same way, and files only once more: each Worker's generated `.dev.vars` and the root's.
  // No account, no store, no seed run — which matters here more than anywhere, because the state it
  // reports is a project whose Workers cannot start.
  const devVars = inProject ? await probeDevVars(options.projectDir).catch(() => null) : null;

  return {
    cli,
    shell,
    alias,
    configDir: stateDir({ homedir: options.homedir, env }),
    stateFile: file,
    notifierEnabled,
    notifierDisabledBy,
    project,
    projectLoadError,
    cloudflare,
    projectName,
    workerNames,
    environments,
    origins,
    workflows,
    extensions,
    devPreferences,
    devSecrets,
    secretBindings,
    devSecretsFile,
    devVarsLocal,
    devVars,
    os: options.os ?? { name: osName(osPlatform()), version: osRelease() },
    runtime: options.runtime ?? detectRuntime(),
    node: options.node ?? process.versions.node,
    offline,
  };
}

/** Non-zero exit when a health check fails or the project could not load (the CI gate). Toolchain state never fails it. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.projectLoadError) return 1;
  // Configured-but-broken credentials are drift worth gating CI on. Absent ones are not: a project that has
  // not been provisioned yet is a legitimate state, and failing it would make `doctor` useless before setup.
  // `not_checked` is the same standard once more and the clearest case of it — the check did not run, so it
  // established nothing, and a caller who asked for no network did not ask for a red exit (#218).
  const cloudflare = report.cloudflare.state;
  if (cloudflare !== "ok" && cloudflare !== "unconfigured" && cloudflare !== "not_checked") return 1;
  // Listed positively, never as "anything but ok": only a fault this project's own config or wiring
  // positively establishes may gate CI. `unconfigured` (no name yet) and `could-not-check` (the wiring
  // would not read) establish nothing, and failing on either would break every run in an unprovisioned
  // project. `invalid` meets the same standard the other two do — the name is set, and no Cloudflare
  // namespace can carry it, which is why every other command already hard-fails on it.
  //
  // `drifted` and `orphaned` now meet it too, which they did not always: `drifted` used to fire on any one
  // declared name that merely had Pithy's shape, so an adopter's pre-existing `myapp-prod-db` — the ordinary
  // Cloudflare convention — turned a green CI red on the adoption path. Both are evidence-backed now.
  // `drifted` is a wholesale contradiction between this repo's own config and its own wiring, checkable
  // from files alone; `orphaned` is Pithy's own `pithy_migrations_owner` stamp naming another project. A
  // name that only *looks* like ours establishes nothing and no longer reaches either.
  //
  // A `null` check is the same standard once more: no readable config means nothing was established about
  // any name, and `doctor` outside a project — to read the CLI version, the shell, the alias — must exit 0.
  const state = report.projectName?.state;
  if (state === "invalid" || state === "drifted" || state === "orphaned") return 1;
  // Same standard once more, and it is met from local files alone: a Worker's directory and its own
  // wrangler.jsonc contradict each other about which Worker this is. Nothing is inferred about the
  // account, and `could-not-check` establishes nothing, so only `drifted` gates.
  if (report.workerNames?.state === "drifted") return 1;
  // Same standard again, and met the same way: the root config and a Worker's own wrangler.jsonc
  // contradict each other about which environments this project has. Nothing about the account is
  // inferred — an orphan is established by ids the checkout already commits — and `could-not-check`
  // establishes nothing, so only `drifted` gates.
  if (report.environments?.state === "drifted") return 1;
  // The same standard, and two of the three origin faults meet it. `workers-dev-open` is a Worker serving
  // a live origin its own config does not name, established from that config alone — and it is the
  // security half: on that origin the CSRF gate refuses the requests that establish who you are, and
  // nothing bound to the hostname applies. `unserved-origin` is the mirror image and the harder failure:
  // the config names an origin and nothing in it serves that host, so the Worker answers nowhere — which
  // is the state this command's own `workers_dev` remedy used to produce, then report as healthy (#264).
  // Both are established from the project's own files. `no-origin` is the state every freshly scaffolded
  // project is in before it has a domain, which is legitimate and universal; failing it would turn
  // `pithy doctor` red on day one for everyone and teach them to stop reading it. It is reported, loudly,
  // and `pithy deploy` is what refuses it — the moment it stops being hypothetical.
  if (report.origins?.drift.some((drift) => drift.fault !== "no-origin")) return 1;
  // The same standard, and **both** faults meet it — there is no day-one state here to spare. A project
  // that declares no Workflows has no drift to report; one that declares them and has not synced is a
  // contradiction between its own two files, checkable offline, and the only fault in this report whose
  // consequence is nothing happening at all: the cron never fires and nothing anywhere says so (#267).
  // An unwritable declaration is the same standard once more — the declaration itself is what no command
  // can act on. `could-not-check` establishes nothing and carries no drift, so it never reaches here.
  if (report.workflows && report.workflows.drift.length > 0) return 1;
  // And once more, on a file rather than a config. A `dev.json` that will not parse or names no user is a
  // fault this machine's own disk establishes: the file is there, and nothing will ever read anything out of
  // it. `absent` is the documented default — no file, no session, magic links only — so it never gates, and
  // CI (which has no `dev.json` at all) is therefore never touched by this check. The audience is the
  // developer whose dev login stopped working, which is the audience the whole check exists for.
  const preferences = report.devPreferences?.state;
  if (preferences === "unparseable" || preferences === "no-user") return 1;
  return report.project && !report.project.health.ok ? 1 : 0;
}

/** Abbreviate a home-relative path to `~/…` for display. */
function tildify(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The `Alias:` line, in all three states.
 *
 * The third one **names the file and nothing else about it** (#210). The reason `readRcFile` raised is
 * carried in `--json`, where a script can read it; here the file is the whole actionable fact, and it is
 * tilde-abbreviated like every other path in this report. What the line must never do is offer
 * `pithy alias` — that command reads the same file and fails on it — so it names the order the two things
 * have to happen in.
 */
function aliasLine(alias: AliasStatus, terse: boolean, home: string): string {
  switch (alias.state) {
    case "installed":
      return terse ? "Alias: installed" : "Alias: installed (`p.` → `pithy`)";
    case "not-installed":
      return terse ? "Alias: not installed" : "Alias: not installed (run `pithy alias`)";
    case "unknown":
      return `Alias: unknown — can't read ${tildify(alias.rcPath ?? "your shell config", home)}. Fix that first; \`pithy alias\` reads the same file.`;
  }
}

/**
 * Health lines nest under their Worker's name: a four-space indent plus a 13-wide label column, so a check's
 * content aligns at column 17 and its continuation lines sit flush beneath (docs/CLI.md §5.6).
 */
const HEALTH_LABEL = 13;
const HEALTH_INDENT = " ".repeat(4);
const HEALTH_CONT = " ".repeat(4 + HEALTH_LABEL);
function healthLine(label: string, content: string): string {
  return `${HEALTH_INDENT}${label.padEnd(HEALTH_LABEL)}${content}`;
}

/** One Worker's five check lines. Every check is shown, so a passing one still reads as checked. */
function workerHealthLines(health: WorkerHealth): string[] {
  const lines: string[] = [];

  // First, and above the rest, because it is the only one that means the Worker does not start. Binding
  // drift and a pending migration are things a running Worker has; a missing prerequisite is a
  // `createBackend` refusal at assembly, so every other line below it describes a Worker that is down.
  if (health.prerequisites.ok) {
    lines.push(healthLine("prereqs", "every composed capability has its peers ✓"));
  } else {
    health.prerequisites.missing.forEach((entry, index) => {
      lines.push(
        healthLine(
          index === 0 ? "prereqs" : "",
          `${entry.capability} requires ${entry.requires} — run: pithy add ${entry.requires}`,
        ),
      );
    });
    lines.push(`${HEALTH_CONT}This worker will not boot until they are composed.`);
  }

  if (health.config.ok) {
    lines.push(healthLine("config", "parses against every capability schema ✓"));
  } else {
    const [first, ...rest] = health.config.drift;
    lines.push(healthLine("config", `options missing from pithy.config.ts — run \`pithy upgrade\``));
    if (first) lines.push(`${HEALTH_CONT}${first.capability}: ${first.keys.join(", ")}`);
    for (const cap of rest) lines.push(`${HEALTH_CONT}${cap.capability}: ${cap.keys.join(", ")}`);
  }

  if (health.bindings.ok) {
    lines.push(healthLine("bindings", "all required bindings present ✓"));
  } else {
    health.bindings.missing.forEach((binding, index) => {
      const label = index === 0 ? "bindings" : "";
      lines.push(healthLine(label, `${binding.name} (${binding.type}) missing from wrangler.jsonc`));
      lines.push(`${HEALTH_CONT}env: ${binding.envs.join(", ")}`);
    });
  }

  if (health.migrations.ok) {
    lines.push(healthLine("migrations", "none pending ✓"));
  } else {
    lines.push(
      healthLine(
        "migrations",
        `${health.migrations.pending} pending — run: pithy migrate --env ${health.migrations.env}`,
      ),
    );
  }

  if (health.entitlements.ok) {
    lines.push(healthLine("entitlements", "no gated route without a provider ✓"));
  } else {
    // Report-only: `pithy upgrade` cannot pick a capability for the adopter, so the line names the fix.
    lines.push(healthLine("entitlements", "gated routes, no provider — run: pithy add payments"));
    for (const gate of health.entitlements.gates) lines.push(`${HEALTH_CONT}${gate}`);
  }

  return lines;
}

/**
 * The `Project health` lines — shown only when some Worker is failing a check, grouped one block per Worker.
 * A healthy Worker collapses to a single line: it was checked, and there is nothing to say about it.
 */
function healthBlock(health: ProjectHealth): string {
  const lines = ["Project health:"];
  // First, and above the Workers, because it explains a hole in every one of their blocks: a capability
  // whose manifest could not be read contributes no drift to any check below it, so a project full of
  // them read as healthy and said nothing at all (#184). No Worker owns this — manifests resolve once,
  // from the project root — so it sits at the block's top rather than inside a Worker's section.
  if (!health.manifests.ok) {
    lines.push("  manifests:");
    for (const fault of health.manifests.faults) {
      // Not `healthLine`: a package name is longer than the 13-column label the per-Worker checks use, so
      // it takes the line and its reason indents beneath it.
      lines.push(
        `${HEALTH_INDENT}${fault.package}: malformed pithy.manifest.json — reinstall it, or tell its maintainer`,
      );
      for (const line of fault.reason.split("\n")) lines.push(`${HEALTH_INDENT}  ${line}`);
    }
  }
  for (const worker of health.workers) {
    if (worker.ok) {
      lines.push(`  ${worker.worker}: healthy ✓`);
      continue;
    }
    lines.push(`  ${worker.worker}:`);
    lines.push(...workerHealthLines(worker));
  }
  return lines.join("\n");
}

/**
 * The `Worker names` lines — shown only when a stamp contradicts its directory, grouped one block per
 * Worker, on the health block's shape. A Worker whose names agree says nothing at all: there is no
 * "names fine ✓" line, because unlike a health check this has no per-Worker section to sit in.
 */
/**
 * The `Environments` lines — shown only when a Worker's stanzas and the declaration disagree, grouped one
 * block per Worker, on the health block's shape. A project whose Workers all agree says nothing at all.
 *
 * The declared set leads, because the whole finding is a comparison and a report that names only one side
 * of it makes the reader open the config to learn what it compared against.
 */
function environmentsBlock(check: EnvironmentsCheck): string {
  const lines = [`Environments: ${check.declared.join(", ")}`];
  for (const worker of [...new Set(check.drift.map((drift) => drift.worker))]) {
    lines.push(`  ${worker}:`);
    for (const drift of check.drift.filter((entry) => entry.worker === worker)) {
      lines.push(healthLine(`env.${drift.env}`, describeEnvironmentDrift(drift, check.declared)));
      if (drift.resources.length > 0) lines.push(`${HEALTH_CONT}${drift.resources.join(", ")}`);
    }
  }
  // No command is offered, and that is the point: `pithy` cannot rename a Cloudflare resource, so applying
  // a changed declaration is exactly the thing that must never happen quietly. The two edits are named.
  lines.push(`${HEALTH_INDENT}Make environments in pithy.config.ts and each Worker's env.<name> stanzas agree.`);
  return lines.join("\n");
}

/**
 * The `Origins` lines — shown only when an environment serves an origin its config does not name, grouped
 * one block per Worker, on the health block's shape (#253).
 *
 * The block offers no command of its own, on the same rule the environments block above states: which
 * hostname an environment answers on is the adopter's to declare, and whether the `workers.dev` subdomain
 * should stay open is a decision rather than a default. Each drift's own sentence names the edit and the
 * file it goes in — and exactly one of the three names a command, because exactly one has one: a route
 * missing from a `domains` declaration is derived, so `pithy worker sync` writes it (#264).
 */
function originsBlock(check: OriginsCheck): string {
  const lines = ["Origins:"];
  for (const worker of [...new Set(check.drift.map((drift) => drift.worker))]) {
    lines.push(`  ${worker}:`);
    for (const drift of check.drift.filter((entry) => entry.worker === worker)) {
      lines.push(healthLine(`env.${drift.env}`, describeOriginDrift(drift)));
    }
  }
  return lines.join("\n");
}

/**
 * The `Workflows:` lines — shown only when an environment's stanza does not bind what its Worker's app
 * capability declares (#267), grouped one block per Worker, on the same shape as the block above.
 *
 * One command answers every `unsynced-stanza` line in it, and each drift's own sentence names it — the
 * block adds no trailing remedy of its own, because the other fault has a different one: a declaration
 * that cannot be reduced to a stanza is fixed in `pithy.config.ts`, and no command can write it.
 */
function workflowsBlock(check: WorkflowsCheck): string {
  const lines = ["Workflows:"];
  for (const worker of [...new Set(check.drift.map((drift) => drift.worker))]) {
    lines.push(`  ${worker}:`);
    for (const drift of check.drift.filter((entry) => entry.worker === worker)) {
      lines.push(healthLine(`env.${drift.env}`, describeWorkflowDrift(drift)));
    }
  }
  return lines.join("\n");
}

/**
 * The `Capability extensions:` lines — what an adopter plugged into a capability, grouped per Worker.
 *
 * The only block in this report that is not a finding, and shown whenever there is anything to show
 * rather than only when something is wrong. That is deliberate: an extension is a deliberate act, so
 * there is no fault to report — and it is also the only place a composed Better Auth plugin has a name
 * outside the source of `pithy.config.ts`, which is what makes its absence from a report a problem and
 * its presence not one.
 */
function extensionsBlock(check: ExtensionsCheck): string {
  const lines = ["Capability extensions:"];
  for (const worker of [...new Set(check.extensions.map((entry) => entry.worker))]) {
    lines.push(`  ${worker}:`);
    for (const entry of check.extensions.filter((candidate) => candidate.worker === worker)) {
      lines.push(`    ${describeExtension(entry)}`);
    }
  }
  return lines.join("\n");
}

/**
 * The `Secret bindings:` lines — shown only when a declared environment does not bind a
 * `cf-secrets-store` secret its Worker reads (#238).
 *
 * Its own block rather than a line inside `Dev secrets:`, because it is about the opposite half of the
 * project: that block is the machine-local file, this is the stanza a *deployed* Worker boots against.
 * A single command answers every line in it, which is why the lines group per Worker-and-environment.
 */
function secretBindingsBlock(check: SecretBindingsCheck): string {
  return ["Secret bindings:", ...describeSecretBindings(check).map((line) => `  ${line}`)].join("\n");
}

function workerNamesBlock(check: WorkerNameCheck): string {
  const lines = ["Worker names:"];
  const workers = [...new Set(check.mismatches.map((mismatch) => mismatch.worker))];
  for (const worker of workers) {
    lines.push(`  ${worker}:`);
    for (const mismatch of check.mismatches.filter((entry) => entry.worker === worker)) {
      lines.push(healthLine(mismatch.stamp, describeWorkerName(mismatch)));
      if (mismatch.envs.length > 0) lines.push(`${HEALTH_CONT}env: ${mismatch.envs.join(", ")}`);
    }
  }
  // No command is offered to fix this one, because none of them can: the directory has already moved, and
  // `pithy worker rename` refuses a destination that exists. The fix is the two edits named above. The
  // command is named anyway, for the next rename — it moves all three at once and this block stays empty.
  lines.push(`${HEALTH_INDENT}Make wrangler.jsonc agree with the directory. Next time: pithy worker rename.`);
  return lines.join("\n");
}

/**
 * The `Project capabilities` lines — collapsed to one line when everything is current.
 *
 * The unchecked line says *why* it is unchecked. `unknown` means the registry did not answer on an
 * ordinary run and that nobody asked it on an offline one, and blaming a network that was never touched is
 * the sort of wrong a diagnostic is judged on.
 */
function capabilitiesBlock(capabilities: CapabilityStatus[], offline: boolean): string {
  if (capabilities.length === 0 || capabilities.every((cap) => cap.state === "current")) {
    return "Project capabilities: all up to date";
  }
  // Nothing is behind, but nothing was confirmed either — say which, rather than implying currency.
  if (capabilities.every((cap) => cap.state !== "outdated")) {
    return offline
      ? "Project capabilities: version check skipped (offline)"
      : "Project capabilities: version check unavailable (registry unreachable)";
  }
  const width = Math.max(...capabilities.map((cap) => cap.name.length));
  const rows = capabilities.map((cap) => {
    const suffix =
      cap.state === "current"
        ? " ✓"
        : cap.state === "unknown"
          ? " (not checked)"
          : ` (${cap.latest} available — run \`pithy upgrade\`)`;
    return `  ${cap.name.padEnd(width)}  ${cap.installed}${suffix}`;
  });
  return ["Project capabilities:", ...rows].join("\n");
}

/** Render the report as the aligned, blocked text of docs/CLI.md §5.6. Verbose vs. terse driven by overall health. */
export function renderDoctorText(report: DoctorReport, home = process.env.HOME ?? ""): string {
  const capsUpToDate = !report.project || report.project.capabilities.every((cap) => cap.state === "current");
  const healthOk = !report.project || report.project.health.ok;
  const cloudflareOk = report.cloudflare.state === "ok";
  // A name that was never asked about is not a name that failed. Someone running `doctor` outside a project
  // is asking about their toolchain, and dragging the whole report verbose to explain a project they do not
  // have would answer a question they did not put. `unconfigured` still forces verbose — there the file is
  // real and a key is missing from it, which is worth the ink.
  const projectNameOk = report.projectName === null || report.projectName.state === "ok";
  // `could-not-check` keeps its silence here rather than forcing verbose: unlike an unreadable name, an
  // unreadable `wrangler.jsonc` is already the health block's line to say, and it says it louder.
  const workerNamesOk = !report.workerNames || report.workerNames.mismatches.length === 0;
  // Same silence for `could-not-check` and the same reason: an unreadable config is the `Project:` block's
  // line, and a second block repeating it is how a report starts contradicting itself.
  const environmentsOk = !report.environments || report.environments.drift.length === 0;
  // Both origin faults keep the report verbose, even though only one of them fails the exit. An
  // environment with no origin is the thing `pithy deploy` will refuse, and a report that stayed silent
  // about it would send the adopter to that refusal with no warning — which is exactly what #253 asked
  // doctor to stop doing. Worth the ink, not worth a red CI.
  const originsOk = !report.origins || report.origins.drift.length === 0;
  // Worth the ink and worth a red CI both, unlike the origins block above: this is the fault whose whole
  // symptom is that nothing happens, so a terse report over it would be the toolchain agreeing that
  // nothing is wrong.
  const workflowsOk = !report.workflows || report.workflows.drift.length === 0;
  // A dev login is optional, so having none is a pass — the terse report is for the developer who has
  // nothing to fix, and "you could have a dev login" is not something to fix. Only the two faults speak up.
  const devPreferencesState = report.devPreferences?.state;
  const devPreferencesOk = devPreferencesState !== "unparseable" && devPreferencesState !== "no-user";
  // A misplaced secret keeps the report verbose without failing the exit: it is worth the ink, and it is
  // the state every project that predates the dev secrets file starts in. A *missing* one does not — the
  // four OAuth pairs auth declares are unset in almost every project, and treating that as a fault would
  // drag every report in the world verbose. `devSecretsHealthy` draws that line; the block still prints.
  const devSecretsOk = !report.devSecrets || devSecretsHealthy(report.devSecrets);
  // A deployed Worker that will answer every request with a missing-binding error is worth the ink for
  // the same reason, and it does not fail the exit for the same reason either — see
  // {@link DoctorReport.secretBindings}.
  const secretBindingsOk = !report.secretBindings || report.secretBindings.missing.length === 0;
  // A Worker that would start with no bindings at all is worth the ink for exactly the same reason a
  // misplaced secret is, and more so. It does not fail the exit — see {@link DoctorReport.devVars} —
  // but a report that called this project healthy is what #178 was reported about.
  const devVarsOk = !report.devVars || devVarsHealthy(report.devVars);
  // An alias nobody could read keeps the report verbose, on the same rule the `unknown` version state
  // follows: "I could not check" is information, and the terse form is the report saying there is nothing
  // to look at. It still never fails the exit — toolchain state does not (#210).
  const aliasOk = report.alias.state !== "unknown";
  // An unknown keeps the report verbose on purpose: "I could not check" is information worth surfacing.
  const terse =
    report.cli.state === "current" &&
    capsUpToDate &&
    healthOk &&
    cloudflareOk &&
    projectNameOk &&
    workerNamesOk &&
    environmentsOk &&
    originsOk &&
    workflowsOk &&
    devPreferencesOk &&
    devSecretsOk &&
    secretBindingsOk &&
    devVarsOk &&
    aliasOk &&
    !report.projectLoadError;

  const blocks: string[] = [];

  /**
   * The `Secrets:` line's content — the path, plus whatever {@link describeDevSecretsLocation} has to add.
   *
   * Built once and rendered twice, because it is the one line in the report that belongs in **both**
   * forms. Everything else here reports a fault, and the terse report exists to say nothing when nothing
   * is wrong; this reports a *location*, and "where is the file" is not a complaint. The file is outside
   * every checkout since #156 — nothing in the project names it and `ls` will not find it — so a terse
   * report that omitted it left the adopter with no way to find it at all (#166). `null` outside a
   * project with a resolvable name, where there is no path to name.
   *
   * **It names the command as well as the path**, on the same rule as `Alias: not installed (run `pithy
   * alias`)`. Knowing where a file is is not the same as having a way to open it: this one is outside the
   * checkout, so no editor's file tree reaches it and no `ls` in the project finds it. The line was the
   * one place an adopter learned the path, and the path was all it gave — leaving "resolve it yourself
   * and open it" as the workflow. `pithy secrets edit` (#157) is that step, and this is the only line in
   * the toolchain positioned to mention it.
   */
  const secretsLocation =
    report.devSecretsFile === null
      ? null
      : (() => {
          const detail = describeDevSecretsLocation(report.devSecretsFile);
          const path = tildify(report.devSecretsFile.path, home);
          return `${path} (run \`pithy secrets edit\`)${detail ? ` — ${detail}` : ""}`;
        })();

  /**
   * The `Cloudflare:` line, built once and rendered in **both** forms — the same rule `Secrets:` follows,
   * and for the same reason.
   *
   * It names the credentials file this run resolved, and "which account am I about to deploy to" is not a
   * complaint: it is a location, so it does not belong behind the not-healthy predicate. A machine holding
   * `cloudflare.leed.json` beside `cloudflare.other-co.json` cannot answer it any other way, and the run
   * that most needs the answer — everything green, about to deploy — was the one run that omitted it (#206).
   */
  const cloudflareLine = `Cloudflare: ${describeCloudflareAccess(report.cloudflare, home)}`;

  // CLI version.
  const cliLines = [`pithy ${report.cli.installed} (installed via ${report.cli.installer})`];
  if (report.cli.state === "outdated" && report.cli.latest) {
    cliLines.push(`Update available: ${report.cli.latest}`);
    cliLines.push(`Run: ${report.cli.upgradeCommand}`);
  } else if (report.cli.state === "unknown") {
    // Same distinction the capabilities line draws, and it is drawn here first because this is the line
    // everybody reads: skipped is a decision somebody made, unreachable is a network that failed.
    cliLines.push(
      report.offline ? "Version check skipped (offline)." : "Version check unavailable (registry unreachable).",
    );
  } else {
    cliLines.push("Up to date.");
  }
  blocks.push(cliLines.join("\n"));

  // Shell / alias.
  const shellName = report.shell ? report.shell.kind : "unknown";
  const shellLine =
    terse || !report.shell ? `Shell: ${shellName}` : `Shell: ${shellName} (${tildify(report.shell.rcPath, home)})`;
  blocks.push([shellLine, aliasLine(report.alias, terse, home)].join("\n"));

  // Config / State / Notifier — verbose only.
  if (!terse) {
    let notifier: string;
    if (report.notifierEnabled) {
      notifier = "enabled (PITHY_NO_UPDATE_NOTIFIER to disable)";
    } else if (report.notifierDisabledBy === "env") {
      notifier = "disabled (PITHY_NO_UPDATE_NOTIFIER set)";
    } else {
      notifier = "disabled (pithy doctor --enable-notifier to re-enable)";
    }
    // The dev-login line belongs in this block and nowhere else. It is the same question the two lines above
    // it answer — where does the CLI keep this, and what is in it — and it is here because it used not to be
    // resolvable from them: `dev.json` lived under a second, unrelated config root, so this block named a
    // directory that did not contain it. One root, one block.
    const paths = [`Config dir: ${tildify(report.configDir, home)}`, `State file: ${tildify(report.stateFile, home)}`];
    if (report.devPreferences) {
      const path = tildify(report.devPreferences.path, home);
      paths.push(`Dev login:  ${path} — ${describeDevPreferences(report.devPreferences)}`);
    }
    // Beside the other two paths rather than in the findings block below, because it answers the same
    // question they do. The terse report has no paths block to sit in, so it gets the line on its own,
    // in this same position — see `secretsLocation` above.
    if (secretsLocation !== null) paths.push(`Secrets:    ${secretsLocation}`);
    blocks.push([...paths, `Notifier:   ${notifier}`].join("\n"));
  } else if (secretsLocation !== null) {
    // Unpadded, because there is nothing here to align it against: the terse report carries this line
    // and no other path. Same position in the report either way, so the two forms read as one document.
    blocks.push(`Secrets: ${secretsLocation}`);
  }

  // Project. Three states across two fields, and all three are said out loud: the config loaded, it is
  // present but would not load, or there is none here. The third used to print nothing while the
  // `Project name:` line spoke for it — and got it wrong, advising a key be added to a file that did not
  // exist. Stated here, once, by the block whose subject it is.
  if (report.projectLoadError) {
    blocks.push(["Project: pithy.config.ts found", `  could not load — ${report.projectLoadError}`].join("\n"));
  } else if (report.project) {
    blocks.push(
      ["Project: pithy.config.ts found", capabilitiesBlock(report.project.capabilities, report.offline)].join("\n"),
    );
    if (!report.project.health.ok) blocks.push(healthBlock(report.project.health));
  } else {
    blocks.push("Project: no pithy.config.ts here — run `pithy init`, or change to a project directory");
  }

  // Cloudflare credentials, on every run. See `cloudflareLine` above for why this one is not gated on
  // the report having something to complain about.
  blocks.push(cloudflareLine);

  // The project name, reconciled against what is provisioned. Its own block rather than a second
  // Cloudflare line: the credentials answer "can I reach the account", this answers "is what I would
  // find there still mine". Absent when the config could not be read — the `Project:` line above has
  // already said so, and this line has no name to reconcile.
  if (!terse && report.projectName) blocks.push(`Project name: ${describeProjectName(report.projectName)}`);

  // The Workers' own names, and only when they disagree. A Worker whose three stamps agree has nothing to
  // report — the block is the finding, the way `Project health` is.
  if (report.workerNames && report.workerNames.mismatches.length > 0) {
    blocks.push(workerNamesBlock(report.workerNames));
  }

  // The environment declaration, and only when a Worker disagrees with it. The block is the finding.
  if (report.environments && report.environments.drift.length > 0) {
    blocks.push(environmentsBlock(report.environments));
  }

  // Where each declared environment answers, and only when one of them serves an origin nothing named.
  // Beside the environments block because it is the same argument one level down: an environment is
  // declared, and now what is true about it must be too.
  if (report.origins && report.origins.drift.length > 0) blocks.push(originsBlock(report.origins));

  // And what each declared environment runs, when its stanza does not bind what the app declares. Beside
  // the origins block for the same reason that one sits beside the environments block: the same argument
  // about the same environment, one declaration further in.
  if (report.workflows && report.workflows.drift.length > 0) blocks.push(workflowsBlock(report.workflows));

  // And what an adopter plugged into a capability. Beside the blocks above because it is the same
  // subject — what this project actually composes — and unlike them it prints when there is nothing
  // wrong, because there is nothing here that can be wrong. Terse runs skip it: it is not a fault, and
  // `--terse` is the form that reports only faults.
  if (!terse && report.extensions && report.extensions.extensions.length > 0) {
    blocks.push(extensionsBlock(report.extensions));
  }

  // Dev secrets, and only when something is wrong with them. The block is the finding: a project whose
  // secrets are in the file they belong in needs no line saying so, and every project that predates
  // the dev secrets file needs one every run until it moves them. Nothing here fails the exit — see
  // {@link DoctorReport.devSecrets}.
  if (report.devSecrets || report.devVars || report.devVarsLocal) {
    const lines = [
      // First in the block, because it is the loudest thing there is to say about a dev environment:
      // that Worker answers every request with a missing-binding error, and the lines below it are
      // usually why. Everything else here is a value in the wrong file; this one is a Worker with none.
      ...(report.devVars ? describeDevVars(report.devVars) : []),
      ...(report.devSecrets ? describeDevSecrets(report.devSecrets) : []),
      // In the same block, because it is the same question asked of the file beside it: what is in a
      // git-ignored file that nothing else in the project knows about.
      ...(report.devVarsLocal ? describeDevVarsLocal(report.devVarsLocal) : []),
    ];
    if (lines.length > 0) blocks.push(["Dev secrets:", ...lines.map((line) => `  ${line}`)].join("\n"));
  }

  // The same registry asked about the deployed environments. After `Dev secrets:` because a developer
  // reads this report about the project in front of them first, and a deploy second.
  if (report.secretBindings && report.secretBindings.missing.length > 0) {
    blocks.push(secretBindingsBlock(report.secretBindings));
  }

  // OS / runtime. Named explicitly, because under Bun `report.node` is an emulated compatibility level
  // rather than the interpreter — reporting it alone would name a runtime that is not running.
  const runtime =
    report.runtime.nodeCompat === null
      ? `${report.runtime.name} ${report.runtime.version}`
      : `${report.runtime.name} ${report.runtime.version} (Node ${report.runtime.nodeCompat} compat)`;
  blocks.push([`OS:      ${report.os.name} ${report.os.version}`, `Runtime: ${runtime}`].join("\n"));

  return `\n${blocks.join("\n\n")}`;
}

/** The `--json` mirror of every block (agents can't read aligned columns). Health failures still drive the exit. */
export function renderDoctorJson(report: DoctorReport): Record<string, unknown> {
  return {
    cli: report.cli,
    shell: report.shell?.kind ?? null,
    // An object rather than the string it used to be, because the answer is tri-state now and a third
    // string would leave a script no way to reach the file the third state is about (#210). `state` is
    // `installed`, `not-installed`, or `unknown`; `rcPath` is the file, absolute here like every other
    // path in this payload; `reason` is the refusal's own sentence, and `null` on the two known states.
    alias: report.alias,
    configDir: report.configDir,
    stateFile: report.stateFile,
    notifier: report.notifierEnabled ? "enabled" : "disabled",
    // Whether this run refused ambient credentials and the network (#218). Unconditional like every key
    // here, and a boolean rather than an absence, because the question a script asks of this payload is
    // "was that check actually run" — and `false` is as much of an answer as `true`.
    offline: report.offline,
    project: report.projectLoadError
      ? { present: true, loadError: report.projectLoadError }
      : report.project
        ? {
            present: true,
            capabilities: report.project.capabilities,
            health: report.project.health,
          }
        : null,
    cloudflare: {
      state: report.cloudflare.state,
      missing: report.cloudflare.missing,
      tokenStatus: report.cloudflare.tokenStatus,
      credentialSplit: report.cloudflare.credentialSplit,
      // The resolved file, absolute here rather than tilde-abbreviated, on the same rule as every other
      // path in this payload: `--json` is read by agents and scripts, which need a path they can open.
      configPath: report.cloudflare.configPath ?? null,
      accountName: report.cloudflare.accountName ?? null,
      accountMismatch: report.cloudflare.accountMismatch ?? null,
      // Beside `configPath` because the two are only useful together: the path is the file this run
      // resolved, and this is whether the credentials actually came out of it (#218).
      credentialSource: report.cloudflare.credentialSource ?? null,
      detail: describeCloudflareAccess(report.cloudflare),
    },
    // `null` alongside a `null` project: one fact, one shape, both keys agreeing that there is no project
    // here to name. An agent reading this never sees a name verdict for a directory that has no config.
    projectName: report.projectName
      ? {
          state: report.projectName.state,
          project: report.projectName.project,
          misnamed: report.projectName.misnamed,
          detail: describeProjectName(report.projectName),
        }
      : null,
    // Same `null` discipline: no project, no Workers, no verdict. Each mismatch carries its own sentence
    // so an agent fixing it never has to reproduce the wording from the fields.
    workerNames: report.workerNames
      ? {
          state: report.workerNames.state,
          mismatches: report.workerNames.mismatches.map((mismatch) => ({
            ...mismatch,
            detail: describeWorkerName(mismatch),
          })),
        }
      : null,
    // Same `null` discipline once more, and each drift carries its own sentence — the remedy for an
    // orphan is not the remedy for a disagreement, and a consumer must not have to work out which.
    environments: report.environments
      ? {
          state: report.environments.state,
          declared: report.environments.declared,
          drift: report.environments.drift.map((drift) => ({
            ...drift,
            detail: describeEnvironmentDrift(drift, report.environments?.declared ?? []),
          })),
        }
      : null,
    // Same `null` discipline once more, and each drift carries its own sentence: the remedy for "no
    // origin at all" is not the remedy for "workers.dev is open beside your domain", and a consumer must
    // not have to work out which from a fault name.
    origins: report.origins
      ? {
          state: report.origins.state,
          drift: report.origins.drift.map((drift) => ({ ...drift, detail: describeOriginDrift(drift) })),
        }
      : null,
    // Same `null` discipline, and each drift carries both sides of the comparison as well as its own
    // sentence: a consumer fixing this needs to know what the stanza binds *and* what the declaration
    // says, and reconstructing either from a fault name is not something a payload should ask for.
    workflows: report.workflows
      ? {
          state: report.workflows.state,
          drift: report.workflows.drift.map((drift) => ({ ...drift, detail: describeWorkflowDrift(drift) })),
        }
      : null,
    // Same `null` discipline, and each entry carries its own sentence so an agent never has to
    // reproduce the wording from the fields. Never a fault, so nothing here is a `state`.
    extensions: report.extensions
      ? {
          extensions: report.extensions.extensions.map((entry) => ({ ...entry, detail: describeExtension(entry) })),
        }
      : null,
    // The path is absolute here, not tilde-abbreviated: `--json` is read by agents and scripts, which need
    // a path they can open, not one a human recognises. The same `null` discipline as the two above.
    devPreferences: report.devPreferences
      ? { ...report.devPreferences, detail: describeDevPreferences(report.devPreferences) }
      : null,
    // Same `null` discipline, and each finding carries its own sentence so an agent fixing it never has to
    // reproduce the wording from the fields. `mode` is octal-formatted here for the same reason: `420` is
    // not a permission anybody recognises.
    devSecretsFile: report.devSecretsFile,
    devSecrets: report.devSecrets
      ? {
          path: report.devSecrets.path,
          misplaced: report.devSecrets.misplaced,
          missing: report.devSecrets.missing,
          undeclared: report.devSecrets.undeclared,
          mode: report.devSecrets.mode === null ? null : report.devSecrets.mode.toString(8),
          unreadable: report.devSecrets.unreadable,
          // The Workers this project has that nobody could ask what they declare (#208). Carried here
          // because a `devSecrets` object with no targets and a `null` one used to be the same answer,
          // and an agent reading either had no way to tell "no secrets" from "nothing loaded".
          unresolvable: report.devSecrets.unresolvable,
          detail: describeDevSecrets(report.devSecrets),
        }
      : null,
    // Same `null` discipline once more, and each finding carries its own sentence: one command writes
    // every one of them, and an agent must not have to reconstruct which from a binding name.
    secretBindings: report.secretBindings
      ? {
          state: report.secretBindings.state,
          missing: report.secretBindings.missing,
          detail: describeSecretBindings(report.secretBindings),
        }
      : null,
    devVarsLocal: report.devVarsLocal
      ? { ...report.devVarsLocal, detail: describeDevVarsLocal(report.devVarsLocal) }
      : null,
    // Names only, never a value — the same discipline as its neighbour. The whole `root` classification
    // is carried rather than only the findings, because an agent asking "what is in that file and what
    // reads it" is asking the question the classification *is*, and a filtered list answers half of it.
    devVars: report.devVars ? { ...report.devVars, detail: describeDevVars(report.devVars) } : null,
    os: `${report.os.name} ${report.os.version}`,
    runtime: report.runtime,
    node: report.node,
  };
}

export default defineCommand({
  meta: { name: "doctor", description: "Check the toolchain, project, and for a new CLI version" },
  args: {
    worker: { type: "string", description: "Check only this worker (default: every worker under apps/)" },
    "disable-notifier": { type: "boolean", default: false, description: "Turn off the update notifier (persisted)" },
    "enable-notifier": { type: "boolean", default: false, description: "Turn the update notifier back on" },
    // No `default: false`. An unpassed flag has to stay absent so `PITHY_OFFLINE` can answer, and citty's
    // default would make every run an explicit "not offline" that overrode the variable.
    offline: { type: "boolean", description: "Use no ambient credentials and make no network call" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      if (args["disable-notifier"] && args["enable-notifier"]) {
        throw new ValidationError({
          message: "Pass either --disable-notifier or --enable-notifier, not both.",
          action: "Choose one.",
        });
      }
      const file = stateFilePath();
      if (args["disable-notifier"]) await setNotifierFlag(file, false);
      if (args["enable-notifier"]) await setNotifierFlag(file, true);

      const report = await buildDoctorReport({
        projectDir: process.cwd(),
        stateFile: file,
        ...(args.worker ? { worker: args.worker } : {}),
        ...(args.offline === undefined ? {} : { offline: args.offline }),
      });
      const output = args.json ? formatJsonLine(renderDoctorJson(report)) : renderDoctorText(report);
      process.stdout.write(`${output}\n`);

      const code = doctorExitCode(report);
      if (code !== 0) process.exit(code);
    }),
});

// Re-export the shared plan-builder reference so a test can assert the engine is shared with upgrade.
export { buildReconcilePlan };
