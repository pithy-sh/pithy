import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { platform as osPlatform, release as osRelease } from "node:os";
import { join } from "node:path";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { type BuildReconcilePlanOptions, buildReconcilePlan, type ReconcilePlan } from "../capabilities/reconcile";
import { buildProjectHealth, type ProjectHealth, type WorkerHealth } from "../doctor/health";
import { type FetchLike, fetchLatestVersion } from "../notifier/check";
import { detectInstaller, type Installer, upgradeCommandFor } from "../notifier/installer";
import { readState, setNotifierFlag, stateDir, stateFilePath, writeState } from "../notifier/state";
import { classifyBump } from "../notifier/version";
import { readRcFile } from "../platform/rc";
import { detectShell, type ShellInfo } from "../platform/shell";
import { loadProject, type ProjectConfig } from "../project/config";
import { type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy doctor` (docs/CLI.md §5.6): the user-initiated health check. It bypasses the 24-hour notifier
 * cache for a fresh registry query, reports the full toolchain state (CLI version, shell/alias, config,
 * project capability versions) plus a `Project health` block — `pithy upgrade`'s reconcile in read-only
 * mode — and exits non-zero when a health check fails so CI can gate on drift. Toolchain state alone never
 * fails the exit. Outside a Pithy project the `Project*` lines are omitted.
 *
 * The health block is **per Worker**: each Worker under `apps/` carries its own `pithy.config.ts` and
 * `wrangler.jsonc`, so each drifts on its own. Any unhealthy Worker fails the exit. `--worker <name>`
 * narrows the block to one — the same flag `migrate`, `seed`, `upgrade`, and `env` take (docs/CLI.md §1.1),
 * so CI can gate on a single Worker's health.
 */

/** The alias-block marker `pithy alias` writes — reused here to detect an installed `p.` shortcut. */
const ALIAS_MARKER = "# >>> pithy alias >>>";

const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** The CLI-version block of the report. */
export interface CliStatus {
  installed: string;
  latest: string | null;
  installer: Installer;
  upToDate: boolean;
  upgradeCommand: string;
}

/** One installed project capability's version state. */
export interface CapabilityStatus {
  name: string;
  installed: string;
  latest: string | null;
  upToDate: boolean;
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
  aliasInstalled: boolean;
  configDir: string;
  stateFile: string;
  notifierEnabled: boolean;
  notifierDisabledBy: "env" | "state" | null;
  project: ProjectStatus | null;
  /** Set when a `pithy.config.ts` is present but could not be loaded (e.g. dependencies not installed). */
  projectLoadError: string | null;
  os: { name: string; version: string };
  node: string;
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
  node?: string;
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

  // Fresh CLI-version check, then persist it into the notifier state (installer detected once when unknown).
  const cliLatest = await fetchLatestVersion("cli", { fetch: doFetch });
  const state = await readState(file);
  await writeState(file, {
    ...state,
    lastCheck: now(),
    latestVersion: cliLatest?.version ?? state.latestVersion,
    securityFlagged: cliLatest?.securityFlagged ?? state.securityFlagged,
    installer: state.installer === "unknown" ? installer : state.installer,
  });

  const cli: CliStatus = {
    installed,
    latest: cliLatest?.version ?? null,
    installer,
    upToDate: cliLatest ? classifyBump(installed, cliLatest.version) === "none" : true,
    upgradeCommand: upgradeCommandFor(installer),
  };

  // Shell / alias.
  const shell = await detect();
  const aliasInstalled = shell ? (await readRc(shell.rcPath)).includes(ALIAS_MARKER) : false;

  // Notifier state for display.
  const disabledByEnv = Boolean(env.PITHY_NO_UPDATE_NOTIFIER);
  const disabledByState = state.notifier === false;
  const notifierEnabled = !disabledByEnv && !disabledByState;
  const notifierDisabledBy = disabledByEnv ? "env" : disabledByState ? "state" : null;

  // Project block — omitted outside a Pithy project.
  let project: ProjectStatus | null = null;
  let projectLoadError: string | null = null;
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
      const latest = await fetchLatestVersion(unscoped, { fetch: doFetch });
      capabilities.push({
        name: cap.name,
        installed: cap.version,
        latest: latest?.version ?? null,
        upToDate: latest ? classifyBump(cap.version, latest.version) === "none" : true,
      });
    }
    const workers = await resolve({
      projectDir: options.projectDir,
      ...(options.worker !== undefined ? { worker: options.worker } : {}),
    });
    const health = await buildProjectHealth({
      projectDir: options.projectDir,
      env: "dev",
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

  return {
    cli,
    shell,
    aliasInstalled,
    configDir: stateDir({ homedir: options.homedir, env }),
    stateFile: file,
    notifierEnabled,
    notifierDisabledBy,
    project,
    projectLoadError,
    os: options.os ?? { name: osName(osPlatform()), version: osRelease() },
    node: options.node ?? process.versions.node,
  };
}

/** Non-zero exit when a health check fails or the project could not load (the CI gate). Toolchain state never fails it. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.projectLoadError) return 1;
  return report.project && !report.project.health.ok ? 1 : 0;
}

/** Abbreviate a home-relative path to `~/…` for display. */
function tildify(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
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

/** One Worker's four check lines. Every check is shown, so a passing one still reads as checked. */
function workerHealthLines(health: WorkerHealth): string[] {
  const lines: string[] = [];

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

/** The `Project capabilities` lines — collapsed to one line when everything is current. */
function capabilitiesBlock(capabilities: CapabilityStatus[]): string {
  if (capabilities.length === 0 || capabilities.every((cap) => cap.upToDate)) {
    return "Project capabilities: all up to date";
  }
  const width = Math.max(...capabilities.map((cap) => cap.name.length));
  const rows = capabilities.map((cap) => {
    const suffix = cap.upToDate || !cap.latest ? " ✓" : ` (${cap.latest} available — run \`pithy upgrade\`)`;
    return `  ${cap.name.padEnd(width)}  ${cap.installed}${suffix}`;
  });
  return ["Project capabilities:", ...rows].join("\n");
}

/** Render the report as the aligned, blocked text of docs/CLI.md §5.6. Verbose vs. terse driven by overall health. */
export function renderDoctorText(report: DoctorReport, home = process.env.HOME ?? ""): string {
  const capsUpToDate = !report.project || report.project.capabilities.every((cap) => cap.upToDate);
  const healthOk = !report.project || report.project.health.ok;
  const terse = report.cli.upToDate && capsUpToDate && healthOk && !report.projectLoadError;

  const blocks: string[] = [];

  // CLI version.
  const cliLines = [`pithy ${report.cli.installed} (installed via ${report.cli.installer})`];
  if (!report.cli.upToDate && report.cli.latest) {
    cliLines.push(`Update available: ${report.cli.latest}`);
    cliLines.push(`Run: ${report.cli.upgradeCommand}`);
  } else {
    cliLines.push("Up to date.");
  }
  blocks.push(cliLines.join("\n"));

  // Shell / alias.
  const shellName = report.shell ? report.shell.kind : "unknown";
  const shellLine =
    terse || !report.shell ? `Shell: ${shellName}` : `Shell: ${shellName} (${tildify(report.shell.rcPath, home)})`;
  const aliasLine = report.aliasInstalled
    ? terse
      ? "Alias: installed"
      : "Alias: installed (`p.` → `pithy`)"
    : terse
      ? "Alias: not installed"
      : "Alias: not installed (run `pithy alias`)";
  blocks.push([shellLine, aliasLine].join("\n"));

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
    blocks.push(
      [
        `Config dir: ${tildify(report.configDir, home)}`,
        `State file: ${tildify(report.stateFile, home)}`,
        `Notifier:   ${notifier}`,
      ].join("\n"),
    );
  }

  // Project.
  if (report.projectLoadError) {
    blocks.push(["Project: pithy.config.ts found", `  could not load — ${report.projectLoadError}`].join("\n"));
  } else if (report.project) {
    blocks.push(["Project: pithy.config.ts found", capabilitiesBlock(report.project.capabilities)].join("\n"));
    if (!report.project.health.ok) blocks.push(healthBlock(report.project.health));
  }

  // OS / Node.
  blocks.push([`OS:   ${report.os.name} ${report.os.version}`, `Node: ${report.node}`].join("\n"));

  return `\n${blocks.join("\n\n")}`;
}

/** The `--json` mirror of every block (agents can't read aligned columns). Health failures still drive the exit. */
export function renderDoctorJson(report: DoctorReport): Record<string, unknown> {
  return {
    cli: report.cli,
    shell: report.shell?.kind ?? null,
    alias: report.aliasInstalled ? "installed" : "not installed",
    configDir: report.configDir,
    stateFile: report.stateFile,
    notifier: report.notifierEnabled ? "enabled" : "disabled",
    project: report.projectLoadError
      ? { present: true, loadError: report.projectLoadError }
      : report.project
        ? {
            present: true,
            capabilities: report.project.capabilities,
            health: report.project.health,
          }
        : null,
    os: `${report.os.name} ${report.os.version}`,
    node: report.node,
  };
}

export default defineCommand({
  meta: { name: "doctor", description: "Check the toolchain, project, and for a new CLI version" },
  args: {
    worker: { type: "string", description: "Check only this worker (default: every worker under apps/)" },
    "disable-notifier": { type: "boolean", default: false, description: "Turn off the update notifier (persisted)" },
    "enable-notifier": { type: "boolean", default: false, description: "Turn the update notifier back on" },
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
      });
      const output = args.json ? formatJsonLine(renderDoctorJson(report)) : renderDoctorText(report);
      process.stdout.write(`${output}\n`);

      const code = doctorExitCode(report);
      if (code !== 0) process.exit(code);
    }),
});

// Re-export the shared plan-builder reference so a test can assert the engine is shared with upgrade.
export { buildReconcilePlan };
