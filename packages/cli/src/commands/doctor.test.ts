// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildReconcilePlan, type ReconcilePlan } from "../capabilities/reconcile";
import type { BuildPlan } from "../doctor/health";
import type { FetchLike } from "../notifier/check";
import { readState, writeState } from "../notifier/state";
import type { ShellInfo } from "../platform/shell";
import type { ProjectConfig } from "../project/config";
import { scaffoldProject } from "../project/scaffold";
import type { ResolvedWorker } from "../project/workerScope";
import doctor, {
  buildDoctorReport,
  type DoctorReport,
  type DoctorReportOptions,
  doctorExitCode,
  installedCapabilityVersions,
  renderDoctorJson,
  renderDoctorText,
} from "./doctor";

/** A `fetch` mapping each package's registry URL to a canned latest version. */
function registryFetch(versions: Record<string, string>): FetchLike {
  return vi.fn(async (url: string) => {
    const match = url.match(/@pithy-sh%2F([^/]+)\/latest/);
    const name = match?.[1] ?? "";
    const version = versions[name];
    if (!version) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version }) };
  });
}

/** A clean plan for one Worker. */
const cleanPlanFor = (worker: string): ReconcilePlan => ({
  worker,
  env: "dev",
  perCapability: [],
  ejectedSkipped: [],
  pendingMigrations: 0,
  entitlementGap: [],
});
const cleanPlan = cleanPlanFor("api");

/** A plan builder that stamps the requested Worker's name onto a fixed plan. */
const planStub = (plan: ReconcilePlan): BuildPlan =>
  vi.fn(async (options) => ({ ...plan, worker: options.worker ?? plan.worker }));

/** A plan builder keyed by Worker — for a project whose Workers differ. */
const planStubPer = (plans: Record<string, ReconcilePlan>): BuildPlan =>
  vi.fn(async (options) => plans[options.worker ?? ""] ?? cleanPlanFor(options.worker ?? ""));

/** The Worker set doctor's resolver seam returns; `ResolvedWorker` is satisfied structurally. */
const workerSet = (...names: string[]) =>
  names.map((name) => ({ name, dir: `/p/apps/${name}`, capabilities: [] }) as unknown as ResolvedWorker);

const zsh: ShellInfo = { kind: "zsh", rcPath: "/home/u/.zshrc", aliasSyntax: "alias p.='pithy'" };
const config: ProjectConfig = { name: "pithy-app" };

let dir: string;
let stateFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-doctor-"));
  stateFile = join(dir, "state.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Base options: a project present, fresh registry, deterministic env/os/node. */
function baseOptions(overrides: Partial<DoctorReportOptions> = {}): DoctorReportOptions {
  return {
    projectDir: dir,
    installedVersion: "1.2.0",
    stateFile,
    argv1: "/home/u/.bun/bin/pithy",
    env: {},
    homedir: "/home/u",
    os: { name: "macOS", version: "14.5" },
    node: "22.10.0",
    now: () => 1_000,
    fetch: registryFetch({ cli: "1.3.0" }),
    detectShell: async () => zsh,
    readRc: async () => "# >>> pithy alias >>>\nalias p.='pithy'\n# <<< pithy alias <<<\n",
    loadProject: async () => config,
    resolveWorkers: async () => workerSet("api"),
    installedCapabilities: async () => [
      { name: "@pithy-sh/core", version: "1.2.0" },
      { name: "@pithy-sh/auth", version: "1.1.8" },
      { name: "@pithy-sh/leaderboard", version: "1.2.0" },
    ],
    buildPlan: planStub(cleanPlan),
    ...overrides,
  };
}

describe("installedCapabilityVersions", () => {
  test("empty when there is no node_modules/@pithy-sh", async () => {
    expect(await installedCapabilityVersions(dir)).toEqual([]);
  });

  test("reads versions and excludes the CLI package itself", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const packages: [string, string][] = [
      ["core", "1.2.0"],
      ["auth", "1.1.8"],
      ["cli", "1.3.0"],
    ];
    for (const [name, version] of packages) {
      const pkg = join(dir, "node_modules", "@pithy-sh", name);
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: `@pithy-sh/${name}`, version }));
    }
    expect(await installedCapabilityVersions(dir)).toEqual([
      { name: "@pithy-sh/auth", version: "1.1.8" },
      { name: "@pithy-sh/core", version: "1.2.0" },
    ]);
  });
});

describe("buildDoctorReport — cache bypass and state", () => {
  test("always queries the registry even when the cache is fresh", async () => {
    // Pre-seed a fresh state; doctor must still fetch.
    await writeState(stateFile, { lastCheck: 1_000, latestVersion: "1.2.0", installer: "bun", notifier: true });
    const fetch = registryFetch({ cli: "1.3.0" });
    await buildDoctorReport(baseOptions({ fetch }));
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/@pithy-sh%2Fcli/latest", expect.anything());
  });

  test("persists the fresh check into the state file", async () => {
    await buildDoctorReport(baseOptions({ now: () => 9_999 }));
    const state = await readState(stateFile);
    expect(state.lastCheck).toBe(9_999);
    expect(state.latestVersion).toBe("1.3.0");
    expect(state.installer).toBe("bun");
  });
});

describe("buildDoctorReport — project detection", () => {
  test("outside a project → project is null", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    expect(report.project).toBeNull();
  });

  test("a present-but-unloadable config degrades to a toolchain report and fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new InternalError({ message: "Could not load pithy.config.ts.", action: "Run bun install." });
        },
      }),
    );
    expect(report.project).toBeNull();
    expect(report.projectLoadError).toBe("Could not load pithy.config.ts. Run bun install.");
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain("could not load — Could not load pithy.config.ts.");
  });

  test("a project with no workers is a broken project, not 'outside a project'", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () => {
          throw new NotFoundError({ message: "No workers here.", action: "Run pithy worker add <name>." });
        },
      }),
    );
    expect(report.projectLoadError).toBe("No workers here. Run pithy worker add <name>.");
    expect(doctorExitCode(report)).toBe(1);
  });

  test("inside a project → capabilities carry installed vs latest", async () => {
    const report = await buildDoctorReport(
      baseOptions({ fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }) }),
    );
    expect(report.project?.capabilities).toEqual([
      { name: "@pithy-sh/core", installed: "1.2.0", latest: "1.2.0", upToDate: true },
      { name: "@pithy-sh/auth", installed: "1.1.8", latest: "1.2.0", upToDate: false },
      { name: "@pithy-sh/leaderboard", installed: "1.2.0", latest: "1.2.0", upToDate: true },
    ]);
  });
});

describe("renderDoctorText", () => {
  test("outdated layout matches docs/CLI.md §5.6 exactly", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.2.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
        buildPlan: planStub({
          worker: "api",
          env: "dev",
          ejectedSkipped: [],
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [],
              missingBindings: [
                { env: "staging", name: "MEDIA_BUCKET", type: "r2" },
                { env: "production", name: "MEDIA_BUCKET", type: "r2" },
              ],
            },
          ],
          pendingMigrations: 2,
          entitlementGap: [],
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.2.0 (installed via bun)",
        "Update available: 1.3.0",
        "Run: bun update -g @pithy-sh/cli",
        "",
        "Shell: zsh (~/.zshrc)",
        "Alias: installed (`p.` → `pithy`)",
        "",
        "Config dir: ~/.config/pithy",
        `State file: ${report.stateFile}`,
        "Notifier:   enabled (PITHY_NO_UPDATE_NOTIFIER to disable)",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities:",
        "  @pithy-sh/core         1.2.0 ✓",
        "  @pithy-sh/auth         1.1.8 (1.2.0 available — run `pithy upgrade`)",
        "  @pithy-sh/leaderboard  1.2.0 ✓",
        "",
        "Project health:",
        "  api:",
        "    config       parses against every capability schema ✓",
        "    bindings     MEDIA_BUCKET (r2) missing from wrangler.jsonc",
        "                 env: staging, production",
        "    migrations   2 pending — run: pithy migrate --env dev",
        "    entitlements no gated route without a provider ✓",
        "",
        "OS:   macOS 14.5",
        "Node: 22.10.0",
      ].join("\n"),
    );
  });

  test("health groups per worker; a healthy one collapses to a line, an unhealthy one lists its checks", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "1.2.0" }],
        resolveWorkers: async () => workerSet("api", "collab"),
        buildPlan: planStubPer({
          api: cleanPlanFor("api"),
          collab: { ...cleanPlanFor("collab"), pendingMigrations: 2 },
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      [
        "Project health:",
        "  api: healthy ✓",
        "  collab:",
        "    config       parses against every capability schema ✓",
        "    bindings     all required bindings present ✓",
        "    migrations   2 pending — run: pithy migrate --env dev",
        "    entitlements no gated route without a provider ✓",
      ].join("\n"),
    );
  });

  test("an entitlement gap names the gating files and the command that fixes it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "1.2.0" }],
        buildPlan: planStub({ ...cleanPlan, entitlementGap: ["src/routes/reports.ts", "src/routes/team.ts"] }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      [
        "    entitlements gated routes, no provider — run: pithy add payments",
        "                 src/routes/reports.ts",
        "                 src/routes/team.ts",
      ].join("\n"),
    );
  });

  test("up-to-date layout is terser and omits the config/health blocks", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        argv1: "/opt/homebrew/bin/pithy",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
        installedCapabilities: async () => [
          { name: "@pithy-sh/core", version: "1.2.0" },
          { name: "@pithy-sh/auth", version: "1.2.0" },
          { name: "@pithy-sh/leaderboard", version: "1.2.0" },
        ],
        readRc: async () => "# >>> pithy alias >>>\nalias p.='pithy'\n# <<< pithy alias <<<\n",
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities: all up to date",
        "",
        "OS:   macOS 14.5",
        "Node: 22.10.0",
      ].join("\n"),
    );
  });

  test("outside a project omits every Project line", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        argv1: "/opt/homebrew/bin/pithy",
        fetch: registryFetch({ cli: "1.3.0" }),
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).not.toContain("Project:");
    expect(text).not.toContain("Project capabilities");
    expect(text).not.toContain("Project health");
  });
});

describe("doctorExitCode", () => {
  test("0 when all health checks pass", async () => {
    const report = await buildDoctorReport(baseOptions());
    expect(doctorExitCode(report)).toBe(0);
  });

  test("non-zero when the config health check fails", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlan,
          perCapability: [
            {
              name: "auth",
              missingBindings: [],
              missingConfigKeys: [{ key: "basePath", default: "/auth", describe: "x" }],
            },
          ],
        }),
      }),
    );
    expect(report.project?.health.workers[0]?.config.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("non-zero when any one worker is unhealthy, even with the rest healthy", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () => workerSet("api", "collab", "web"),
        buildPlan: planStubPer({ collab: { ...cleanPlanFor("collab"), pendingMigrations: 1 } }),
      }),
    );
    expect(report.project?.health.workers.map((worker) => worker.ok)).toEqual([true, false, true]);
    expect(report.project?.health.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("zero when every worker is healthy", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () => workerSet("api", "collab"),
        buildPlan: planStubPer({}),
      }),
    );
    expect(report.project?.health.workers).toHaveLength(2);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("non-zero when the bindings health check fails", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlan,
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [],
              missingBindings: [{ env: "staging", name: "MEDIA_BUCKET", type: "r2" }],
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("non-zero when migrations are pending", async () => {
    const report = await buildDoctorReport(
      baseOptions({ buildPlan: planStub({ ...cleanPlan, pendingMigrations: 3 }) }),
    );
    expect(report.project?.health.workers[0]?.migrations).toEqual({ ok: false, pending: 3, env: "dev" });
    expect(doctorExitCode(report)).toBe(1);
  });

  test("outside a project, health never fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("renderDoctorJson", () => {
  test("mirrors every block", async () => {
    const report: DoctorReport = await buildDoctorReport(
      baseOptions({ fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }) }),
    );
    const json = renderDoctorJson(report);
    expect(json.cli).toMatchObject({ installed: "1.2.0", latest: "1.3.0", installer: "bun", upToDate: false });
    expect(json.shell).toBe("zsh");
    expect(json.alias).toBe("installed");
    expect(json.notifier).toBe("enabled");
    expect(json.os).toBe("macOS 14.5");
    expect(json.node).toBe("22.10.0");
    expect((json.project as { present: boolean }).present).toBe(true);
  });
});

describe("notifier opt-out reflected in the report", () => {
  test("state notifier:false shows disabled and survives the doctor state write", async () => {
    await writeState(stateFile, { lastCheck: 0, latestVersion: null, installer: "bun", notifier: false });
    const report = await buildDoctorReport(baseOptions());
    expect(report.notifierEnabled).toBe(false);
    expect(report.notifierDisabledBy).toBe("state");
    // A doctor run refreshes the version fields but must not clobber the opt-out flag (persists across runs).
    expect((await readState(stateFile)).notifier).toBe(false);
    await buildDoctorReport(baseOptions());
    expect((await readState(stateFile)).notifier).toBe(false);
  });

  test("PITHY_NO_UPDATE_NOTIFIER shows disabled via env", async () => {
    const report = await buildDoctorReport(baseOptions({ env: { PITHY_NO_UPDATE_NOTIFIER: "1" } }));
    expect(report.notifierEnabled).toBe(false);
    expect(report.notifierDisabledBy).toBe("env");
  });
});

describe("--worker", () => {
  test("the command declares the flag docs/CLI.md §1.1 gives every fan-out command", () => {
    const args = doctor.args as Record<string, { type: string }>;
    expect(args.worker).toMatchObject({ type: "string" });
  });

  test("threads the name to the resolver, and passes none when the flag is absent", async () => {
    const seen: { projectDir: string; worker?: string }[] = [];
    const resolveWorkers = async (options: { projectDir: string; worker?: string }) => {
      seen.push(options);
      return workerSet("api");
    };

    await buildDoctorReport(baseOptions({ resolveWorkers }));
    await buildDoctorReport(baseOptions({ worker: "api", resolveWorkers }));
    expect(seen).toEqual([{ projectDir: dir }, { projectDir: dir, worker: "api" }]);
  });

  test("narrows the exit gate — an unrelated unhealthy worker no longer fails the run", async () => {
    const all = workerSet("api", "collab");
    const resolveWorkers = async ({ worker }: { projectDir: string; worker?: string }) =>
      worker === undefined ? all : all.filter((candidate) => candidate.name === worker);
    const buildPlan = planStubPer({ collab: { ...cleanPlanFor("collab"), pendingMigrations: 2 } });

    const whole = await buildDoctorReport(baseOptions({ resolveWorkers, buildPlan }));
    expect(whole.project?.health.workers.map((worker) => worker.worker)).toEqual(["api", "collab"]);
    expect(doctorExitCode(whole)).toBe(1);

    const narrowed = await buildDoctorReport(baseOptions({ worker: "api", resolveWorkers, buildPlan }));
    expect(narrowed.project?.health.workers.map((worker) => worker.worker)).toEqual(["api"]);
    expect(doctorExitCode(narrowed)).toBe(0);
  });
});

/**
 * The health block end to end — the real reconcile engine against real `apps/<name>/` files, with only the
 * migration count stubbed. Capabilities install **once** at the project root and are wired per Worker, so a
 * package installed for one Worker must never show up as another's drift.
 */
describe("project health — installed is not composed (regression)", () => {
  let projectDir: string;
  let api: string;
  let web: string;

  const composes = (...names: string[]): Capability[] => names.map((name) => ({ name, requiredBindings: [] }));

  /** A Worker as the resolver seam returns it; `ResolvedWorker` is satisfied structurally. */
  const worker = (name: string, workerDir: string, capabilities: Capability[]) =>
    ({ name, dir: workerDir, capabilities }) as unknown as ResolvedWorker;

  /** Doctor with the real reconcile engine — the plan builder is not stubbed. */
  function realEngine(workers: ResolvedWorker[]): DoctorReportOptions {
    return baseOptions({
      projectDir,
      resolveWorkers: async () => workers,
      buildPlan: undefined,
      countPending: async () => 0,
    });
  }

  beforeEach(async () => {
    projectDir = join(dir, "project");
    await scaffoldProject({ targetDir: projectDir, appName: "doctor-test" });
    api = join(projectDir, "apps", "api");
    web = join(projectDir, "apps", "web");
    await cp(api, web, { recursive: true });
    // `pithy add auth --worker api`: one install at the project root, wired into api alone.
    const pkgDir = join(projectDir, "node_modules", "@pithy-sh", "auth");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [
          { type: "d1", name: "DB" },
          { type: "kv", name: "SESSIONS" },
        ],
      }),
    );
  });

  test("a worker composing nothing is healthy and exits zero", async () => {
    const report = await buildDoctorReport(realEngine([worker("web", web, [])]));
    expect(report.project?.health.workers[0]?.bindings).toEqual({ ok: true, missing: [] });
    expect(report.project?.health.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("the worker that does compose it still reports its drift", async () => {
    const report = await buildDoctorReport(realEngine([worker("api", api, composes("auth"))]));
    expect(report.project?.health.workers[0]?.bindings.missing.map((binding) => binding.name)).toEqual([
      "DB",
      "SESSIONS",
    ]);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("across both workers, only the composing one is unhealthy", async () => {
    const report = await buildDoctorReport(realEngine([worker("api", api, composes("auth")), worker("web", web, [])]));
    expect(report.project?.health.workers.map((entry) => [entry.worker, entry.ok])).toEqual([
      ["api", false],
      ["web", true],
    ]);
  });
});

describe("shared engine", () => {
  test("the doctor command re-exports the same buildReconcilePlan upgrade uses", async () => {
    const { defaultBuildPlan } = await import("../doctor/health");
    expect(defaultBuildPlan).toBe(buildReconcilePlan);
  });
});
