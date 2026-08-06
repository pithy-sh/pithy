// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildReconcilePlan } from "../capabilities/reconcile";
import type { FetchLike } from "../notifier/check";
import { readState, writeState } from "../notifier/state";
import { scaffoldProject } from "../project/scaffold";
import type { ResolvedWorker } from "../project/workerScope";
import {
  cleanPlanFor,
  doctorHarness,
  planStub,
  planStubPer,
  registryFetch,
  workerSet,
} from "../test-utils/doctorHarness";
import doctor, {
  buildDoctorReport,
  type DoctorReport,
  type DoctorReportOptions,
  detectRuntime,
  doctorExitCode,
  installedCapabilityVersions,
  renderDoctorJson,
  renderDoctorText,
  versionState,
} from "./doctor";

const harness = doctorHarness();
const { baseOptions, healthyOptions } = harness;
const cleanPlan = cleanPlanFor("api");

// The harness makes a fresh directory per test; these mirror it for the tests that address it directly.
let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = harness.dir;
  stateFile = harness.stateFile;
});

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
      { name: "@pithy-sh/core", installed: "1.2.0", latest: "1.2.0", state: "current" },
      { name: "@pithy-sh/auth", installed: "1.1.8", latest: "1.2.0", state: "outdated" },
      { name: "@pithy-sh/leaderboard", installed: "1.2.0", latest: "1.2.0", state: "current" },
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
                { env: "prod", name: "MEDIA_BUCKET", type: "r2" },
              ],
            },
          ],
          pendingMigrations: 2,
          entitlementGap: [],
          missingVersionMetadata: false,
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
        "                 env: staging, prod",
        "    migrations   2 pending — run: pithy migrate --env dev",
        "    entitlements no gated route without a provider ✓",
        "",
        "Cloudflare: reachable (token active)",
        "",
        "Project name: pithy-app — every resource name matches",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
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
    const report = await buildDoctorReport(healthyOptions());
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
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
  });

  /**
   * Outside a project the `Project:` block states the one fact — there is no config here — and every other
   * project line is gone, including `Project name:`. Two lines answering the same question is how the
   * previous doctor defects happened: the name line used to advise adding a key to a file that did not
   * exist, while the block whose job that is printed nothing at all.
   */
  test("no pithy.config.ts here — the Project line says so, and no other line answers a project question", async () => {
    const probe = vi.fn(async () => ({ state: "ok" as const, project: "pithy-app", misnamed: [] }));
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        argv1: "/opt/homebrew/bin/pithy",
        fetch: registryFetch({ cli: "1.3.0" }),
        // The real loader, against a temp directory with no config — the case the defect was reported from.
        loadProject: undefined,
        checkProjectName: probe,
      }),
    );
    // The name question is never asked, so nothing can answer it wrongly.
    expect(report.projectName).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    // Terse: someone running doctor outside a project is asking about their toolchain, and it is fine.
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Project: no pithy.config.ts here — run `pithy init`, or change to a project directory",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
    // Checking the CLI version, the shell, or the alias from anywhere is legitimate and never a fault.
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a project that loaded but names nothing still says where to set the name", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkProjectName: async () => ({ state: "unconfigured", project: null, misnamed: [] }) }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Project: pithy.config.ts found");
    // The advice is correct here and only here: the file exists, and it is missing a key.
    expect(text).toContain(
      "Project name: not set (add `name` to pithy.config.ts — every resource name derives from it)",
    );
    expect(doctorExitCode(report)).toBe(0);
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
    expect(json.cli).toMatchObject({ installed: "1.2.0", latest: "1.3.0", installer: "bun", state: "outdated" });
    expect(json.shell).toBe("zsh");
    expect(json.alias).toBe("installed");
    expect(json.notifier).toBe("enabled");
    expect(json.os).toBe("macOS 14.5");
    expect(json.node).toBe("22.10.0");
    expect((json.project as { present: boolean }).present).toBe(true);
  });

  test("outside a project both project keys are null — the same fact, stated once", async () => {
    const report = await buildDoctorReport(baseOptions({ loadProject: undefined }));
    const json = renderDoctorJson(report);
    expect(json.project).toBeNull();
    expect(json.projectName).toBeNull();
  });

  test("a project that names nothing keeps the unconfigured state and its detail line", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkProjectName: async () => ({ state: "unconfigured", project: null, misnamed: [] }) }),
    );
    const json = renderDoctorJson(report) as { projectName: { state: string; project: null; detail: string } };
    expect(json.projectName.state).toBe("unconfigured");
    expect(json.projectName.project).toBeNull();
    expect(json.projectName.detail).toContain("add `name` to pithy.config.ts");
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
    // A copied Worker is a second Worker, so it carries the first one's script name and `WORKER` var —
    // which is precisely the drift `checkWorkerNames` now fails the exit on. Stamped for the directory it
    // was copied into, the way `pithy worker add` would have written it.
    const copied = join(web, "wrangler.jsonc");
    await writeFile(
      copied,
      (await readFile(copied, "utf8")).replaceAll("doctor-test-api", "doctor-test-web").replaceAll('"api"', '"web"'),
    );
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

describe("cloudflare credentials", () => {
  test("a reachable account reports its token status and does not fail the exit", async () => {
    const report = await buildDoctorReport(baseOptions());
    expect(report.cloudflare).toEqual({ state: "ok", missing: [], tokenStatus: "active", credentialSplit: null });
    expect(doctorExitCode(report)).toBe(0);
  });

  test("unconfigured credentials never fail the exit — an unprovisioned project is legitimate", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "unconfigured",
          missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a rejected token fails the exit, so CI gates on it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "token_invalid",
          missing: [],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("a live token pointed at the wrong account fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "account_unreachable",
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("the text report names only the missing key, not both", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "unconfigured",
          missing: ["CLOUDFLARE_API_TOKEN"],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Cloudflare: not configured (set CLOUDFLARE_API_TOKEN in .dev.vars)");
    expect(text).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("a split credential group is reported even though the credentials are reachable", async () => {
    const split = { fromFile: ["CLOUDFLARE_API_TOKEN"], fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"] };
    const report = await buildDoctorReport(
      healthyOptions({
        checkCloudflare: async () => ({ state: "ok", missing: [], tokenStatus: "active", credentialSplit: split }),
      }),
    );
    // The whole report stays terse — the split earns its one line, and nothing else is dragged out with
    // it. `Project name:` is the neighbouring verbose-only block, and it is still absent.
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
        "Cloudflare: reachable (token active); credentials come from two places — .dev.vars sets CLOUDFLARE_API_TOKEN, the environment supplies CLOUDFLARE_ACCOUNT_ID — set the whole pair in one of them",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
    // A warning, not a gate — the pair may well work, and only an established fault fails the exit.
    expect(doctorExitCode(report)).toBe(0);

    const json = renderDoctorJson(report) as { cloudflare: { credentialSplit: unknown } };
    expect(json.cloudflare.credentialSplit).toEqual(split);
  });

  test("a clean, unsplit setup keeps the Cloudflare line out of the terse report entirely", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(renderDoctorText(report, "/home/u")).not.toContain("Cloudflare:");
  });

  test("--json carries the state and a human detail line", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "token_invalid",
          missing: [],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    const json = renderDoctorJson(report) as { cloudflare: { state: string; detail: string } };
    expect(json.cloudflare.state).toBe("token_invalid");
    expect(json.cloudflare.detail).toContain("CLOUDFLARE_API_TOKEN rejected");
  });
});

describe("project name", () => {
  /** A misnamed resource, as the probe reports one. `owner` is the only field that proves anything. */
  const misnamed = (name: string, provisioned: boolean | null, owner: string | null = null) => ({
    name,
    project: "oldname",
    kind: "d1" as const,
    worker: "api",
    env: "prod",
    binding: "DB",
    provisioned,
    owner,
  });

  /** The two names a wholesale rename leaves — drift is plural by construction. */
  const renamed = [misnamed("oldname-prod-db", null), misnamed("oldname-dev-db", null)];

  test("a matching name does not fail the exit and stays out of the terse report", async () => {
    const report = await buildDoctorReport(baseOptions({ installedVersion: "1.3.0" }));
    expect(report.projectName?.state).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("no name yet never fails the exit — an unconfigured project is legitimate", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkProjectName: async () => ({ state: "unconfigured", project: null, misnamed: [] }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("could-not-check never fails the exit — nothing was established either way", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "could-not-check", project: "pithy-app", misnamed: [] }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a name that is set but illegal fails the exit — every other command already refuses it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "invalid", project: "2026-launch", misnamed: [] }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Project name: ");
    expect(text).toContain("2026-launch");
    expect(text).not.toContain("not set");
  });

  test("--json carries the invalid state and the name that was actually set", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "invalid", project: "2026-launch", misnamed: [] }),
      }),
    );
    const json = renderDoctorJson(report) as { projectName: { state: string; project: string; detail: string } };
    expect(json.projectName.state).toBe("invalid");
    expect(json.projectName.project).toBe("2026-launch");
    expect(json.projectName.detail).toContain("2026-launch");
  });

  test("a wholesale rename fails the exit, so CI gates on it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "drifted", project: "pithy-app", misnamed: renamed }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain('Project name: 2 resource names this project declares lead with "oldname"');
    // Drift has established no ownership, so it never reaches for the word.
    expect(text).not.toContain("orphan");
  });

  test("orphaned resources fail the exit and the text names the stamp that proved it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({
          state: "orphaned",
          project: "pithy-app",
          misnamed: [misnamed("oldname-prod-db", true, "oldname")],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain('Project name: 1 resource is stamped "oldname" by pithy migrate');
    expect(text).toContain("pithy-app will never find it again");
    // Never, on any path, does doctor tell an adopter to delete a live resource.
    expect(text).not.toContain("delete");
  });

  test("--json carries the state, the misnamed resources, and a human detail line", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({
          state: "orphaned",
          project: "pithy-app",
          misnamed: [misnamed("oldname-prod-db", true, "oldname")],
        }),
      }),
    );
    const json = renderDoctorJson(report) as {
      projectName: {
        state: string;
        project: string;
        misnamed: { name: string; provisioned: boolean | null; owner: string | null }[];
        detail: string;
      };
    };
    expect(json.projectName.state).toBe("orphaned");
    expect(json.projectName.project).toBe("pithy-app");
    expect(json.projectName.misnamed[0]?.name).toBe("oldname-prod-db");
    // The evidence travels with the finding, so an agent can tell proof from inference.
    expect(json.projectName.misnamed[0]?.owner).toBe("oldname");
    expect(json.projectName.detail).toContain("stamped");
  });
});

describe("dev login", () => {
  const prefs =
    (over: Partial<DoctorReport["devPreferences"] & object> = {}) =>
    async () => ({
      state: "absent" as const,
      path: "/home/u/.config/pithy/acme/dev.json",
      user: null,
      ...over,
    });

  test("names the resolved path, tilde-abbreviated, beside the other config paths", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevPreferences: prefs() }));
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Dev login:  ~/.config/pithy/acme/dev.json — none yet; sign-in stays magic-link only",
    );
  });

  test("no file never fails the exit — a magic-link-only project is the documented default", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevPreferences: prefs() }));
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a healthy file names its user and still does not fail the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkDevPreferences: prefs({ state: "ok", user: "ada@example.com" }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Dev login:  ~/.config/pithy/acme/dev.json — names ada@example.com");
    // Doctor runs no seed, so it must never imply it checked the roster.
    expect(text).not.toContain("seeded");
  });

  test("a file that will not parse fails the exit and drags the report verbose", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevPreferences: prefs({ state: "unparseable" }) }),
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain("Dev login:  ~/.config/pithy/acme/dev.json — will not parse");
  });

  test("a file naming no user fails the exit too", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevPreferences: prefs({ state: "no-user" }) }),
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain('no "user"');
  });

  test("a healthy file keeps the terse report terse — it has nothing to say", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevPreferences: prefs({ state: "ok", user: "ada@example.com" }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Dev login:");
  });

  test("outside a project there is no line at all — no config, no per-project path", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevPreferences: async () => null }));
    expect(report.devPreferences).toBeNull();
    expect(renderDoctorText(report, "/home/u")).not.toContain("Dev login:");
    expect((renderDoctorJson(report) as { devPreferences: unknown }).devPreferences).toBeNull();
  });

  test("--json carries the absolute path, the state, and the user the file names", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkDevPreferences: prefs({ state: "ok", user: "ada@example.com" }) }),
    );
    const json = renderDoctorJson(report) as {
      devPreferences: { state: string; path: string; user: string | null; detail: string };
    };
    expect(json.devPreferences).toEqual({
      state: "ok",
      path: "/home/u/.config/pithy/acme/dev.json",
      user: "ada@example.com",
      detail: "names ada@example.com",
    });
  });
});

describe("worker names", () => {
  /** The hand-rename the dashboard did: `apps/board`, still deploying and stamping as `api`. */
  const handRenamed = {
    state: "drifted" as const,
    mismatches: [
      { worker: "board", stamp: "name" as const, declared: "acme-api", expected: "acme-board", envs: [] },
      {
        worker: "board",
        stamp: "vars.WORKER" as const,
        declared: "api",
        expected: "board",
        envs: ["dev", "staging", "prod"],
      },
    ],
  };

  test("agreeing names stay out of the terse report and do not fail the exit", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(report.workerNames?.state).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
    expect(renderDoctorText(report, "/home/u")).not.toContain("Worker names:");
  });

  test("a hand-rename fails the exit, so CI catches the stamp nobody remembered", async () => {
    const report = await buildDoctorReport(baseOptions({ checkWorkerNames: async () => handRenamed }));
    expect(doctorExitCode(report)).toBe(1);
    // Pinned whole, on the health block's columns: a diagnostic's layout is what makes it readable at a
    // glance, and every other block here is pinned the same way.
    expect(renderDoctorText(report, "/home/u")).toContain(
      [
        "Worker names:",
        "  board:",
        "    name         deploys as acme-api, not acme-board",
        "    vars.WORKER  stamps events as api, not board",
        "                 env: dev, staging, prod",
        "    Make wrangler.jsonc agree with the directory. Next time: pithy worker rename.",
      ].join("\n"),
    );
  });

  test("could-not-check never fails the exit — an unreadable config establishes nothing", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkWorkerNames: async () => ({ state: "could-not-check", mismatches: [] }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("outside a project there are no workers to name", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    expect(report.workerNames).toBeNull();
    expect(renderDoctorJson(report).workerNames).toBeNull();
  });

  test("--json carries every mismatch, so an agent can fix them without parsing columns", async () => {
    const report = await buildDoctorReport(baseOptions({ checkWorkerNames: async () => handRenamed }));
    const json = renderDoctorJson(report) as {
      workerNames: { state: string; mismatches: { worker: string; stamp: string; detail: string }[] };
    };
    expect(json.workerNames.state).toBe("drifted");
    expect(json.workerNames.mismatches).toHaveLength(2);
    expect(json.workerNames.mismatches[0]?.detail).toBe("deploys as acme-api, not acme-board");
  });
});

describe("runtime reporting", () => {
  test("Bun is named as the runtime, with the Node level it emulates", () => {
    expect(detectRuntime({ bun: "1.1.38", node: "22.6.0" } as unknown as NodeJS.ProcessVersions)).toEqual({
      name: "Bun",
      version: "1.1.38",
      nodeCompat: "22.6.0",
    });
  });

  test("plain Node reports itself with no compat level", () => {
    expect(detectRuntime({ node: "22.10.0" } as unknown as NodeJS.ProcessVersions)).toEqual({
      name: "Node",
      version: "22.10.0",
      nodeCompat: null,
    });
  });

  test("the report names the interpreter rather than the emulated Node version", async () => {
    const report = await buildDoctorReport(
      baseOptions({ runtime: { name: "Bun", version: "1.1.38", nodeCompat: "22.6.0" } }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain("Runtime: Bun 1.1.38 (Node 22.6.0 compat)");
  });
});

describe("version checks that could not run", () => {
  /** A registry that answers nothing — offline, an outage, or a package not published yet. */
  const silentRegistry: FetchLike = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  })) as FetchLike;

  test("an unreachable registry is unknown, never current", async () => {
    const report = await buildDoctorReport(baseOptions({ fetch: silentRegistry }));
    expect(report.cli.state).toBe("unknown");
    expect(report.project?.capabilities.every((cap) => cap.state === "unknown")).toBe(true);
  });

  test("the report says the check was unavailable rather than claiming currency", async () => {
    const report = await buildDoctorReport(baseOptions({ fetch: silentRegistry }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Version check unavailable (registry unreachable).");
    expect(text).toContain("Project capabilities: version check unavailable (registry unreachable)");
    expect(text).not.toContain("Up to date.");
    expect(text).not.toContain("all up to date");
  });

  test("not knowing never fails the exit — it is absence of information, not drift", async () => {
    const report = await buildDoctorReport(baseOptions({ fetch: silentRegistry }));
    expect(doctorExitCode(report)).toBe(0);
  });

  test("versionState classifies each case", () => {
    expect(versionState("1.2.0", null)).toBe("unknown");
    expect(versionState("1.2.0", "1.2.0")).toBe("current");
    expect(versionState("1.2.0", "1.3.0")).toBe("outdated");
  });
});
