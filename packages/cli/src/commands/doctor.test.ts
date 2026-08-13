// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
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
          deployedAs: "acme-api",
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
          undeclaredMigrations: [],
          entitlementGap: [],
          missingPrerequisites: [],
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
        "    prereqs      every composed capability has its peers ✓",
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
        "    prereqs      every composed capability has its peers ✓",
        "    config       parses against every capability schema ✓",
        "    bindings     all required bindings present ✓",
        "    migrations   2 pending — run: pithy migrate --env dev",
        "    entitlements no gated route without a provider ✓",
      ].join("\n"),
    );
  });

  /**
   * #282. Nothing was pending, so the line read `none pending ✓` — about a database `pithy migrate`
   * refused to touch. The two directions are two different faults with two different remedies, so the
   * undeclared one gets its own sentence rather than a second number on the pending line.
   */
  test("a migration the ledger records and the project no longer declares gets its own line and remedy", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "1.2.0" }],
        buildPlan: planStub({
          ...cleanPlan,
          undeclaredMigrations: [{ database: "app", binding: "DB", name: "0250_audit_0002_tenant" }],
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      [
        "    migrations   DB records 0250_audit_0002_tenant. This project no longer declares it.",
        "                 Nothing migrates until the ledger and the declaration agree. This is the local dev store, so wiping it is cheap: delete .wrangler/state, then run pithy migrate --env dev again.",
      ].join("\n"),
    );
    expect(doctorExitCode(report)).toBe(1);
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
        "Cloudflare: reachable (token active)",
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
        "Cloudflare: reachable (token active)",
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
    expect(report.project?.health.workers[0]?.migrations).toEqual({
      ok: false,
      pending: 3,
      undeclared: [],
      env: "dev",
    });
    expect(doctorExitCode(report)).toBe(1);
  });

  /**
   * #264. A declared origin with nothing serving it is the one this command's own remedy produced: it
   * told an adopter to close `workers.dev` beside a domain whose route had never been written, then
   * reported the result — a Worker reachable at no address — as healthy, exit 0.
   */
  test("non-zero when a declared origin has nothing serving it, and the block names the route", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkOrigins: async () => ({
          state: "drifted",
          drift: [
            {
              worker: "board",
              env: "prod",
              fault: "unserved-origin",
              origin: "https://app.example.com",
              source: "declaration",
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("no route in env.prod serves it");
    expect(text).toContain("pithy worker sync");
    // The remedy that caused the fault must not be the remedy printed for it.
    expect(text).not.toContain('Set "workers_dev": false in env.prod');
  });

  /** Still the day-one state of every project, and still not a red exit. */
  test("zero when the only origin fault is an environment with no origin at all", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkOrigins: async () => ({
          state: "drifted",
          drift: [{ worker: "board", env: "staging", fault: "no-origin", origin: null }],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  /**
   * #267. The only fault in this report whose whole symptom is that nothing happens: a job declared,
   * `pithy worker sync` never run, and the cron that would have fired it never written. The block has to
   * name both sides of the comparison — what is declared and what is bound — because the reader is being
   * told about a table in a file they believed already matched.
   */
  test("non-zero when a stanza does not bind what the app declares, and the block names both sides", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkWorkflows: async () => ({
          state: "drifted",
          drift: [
            {
              worker: "board",
              env: "prod",
              fault: "unsynced-stanza",
              declared: {
                workflows: [{ binding: "DIGEST", name: "replay-prod-board-digest", class_name: "DigestWorkflow" }],
                crons: ["0 4 * * *"],
              },
              bound: { workflows: [], crons: [] },
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("DIGEST → replay-prod-board-digest");
    expect(text).toContain("cron 0 4 * * *");
    expect(text).toContain("env.prod binds nothing");
    expect(text).toContain("pithy worker sync");
  });

  /**
   * #271. A Better Auth plugin an adopter composed adds routes to the Worker and tables to the
   * database, and has no `package.json` for `Project capabilities:` to name it from. It is not a fault
   * — so it prints without one, and it never gates.
   */
  test("a composed extension is named, with the tables it brought, and never fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () =>
          [
            {
              name: "board",
              dir: "/p/apps/board",
              capabilities: [
                {
                  name: "auth",
                  requiredBindings: [],
                  extensions: [{ kind: "better-auth-plugin", id: "organization", tables: ["organization", "member"] }],
                } as unknown as Capability,
              ],
            },
          ] as unknown as ResolvedWorker[],
        buildPlan: planStub(cleanPlanFor("board")),
      }),
    );

    expect(doctorExitCode(report)).toBe(0);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Capability extensions:");
    expect(text).toContain("auth: organization (better-auth-plugin), tables organization, member.");
    expect(renderDoctorJson(report)).toMatchObject({
      extensions: { extensions: [expect.objectContaining({ id: "organization", worker: "board" })] },
    });
  });

  test("a project that composes no extension prints no block about it", async () => {
    const report = await buildDoctorReport(baseOptions());
    expect(report.extensions).toEqual({ extensions: [] });
    expect(renderDoctorText(report, "/home/u")).not.toContain("Capability extensions:");
  });

  /** Nothing was established, so nothing gates — the same standard every other check here is held to. */
  test("zero when the workflow declaration could not be checked at all", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkWorkflows: async () => ({ state: "could-not-check", drift: [] }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
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
    expect(json.alias).toEqual({ state: "installed", rcPath: "/home/u/.zshrc", reason: null });
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
      readLedger: async () => ({ pending: 0, undeclared: [] }),
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
    expect(text).toContain(
      "Cloudflare: not configured (set CLOUDFLARE_API_TOKEN in ~/.config/pithy/cloudflare.json, or the environment)",
    );
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
        "Cloudflare: reachable (token active); credentials come from two places — cloudflare.json sets CLOUDFLARE_API_TOKEN, the environment supplies CLOUDFLARE_ACCOUNT_ID — set the whole pair in one of them",
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

  test("a clean setup still prints the line, because it names the account, not a complaint", async () => {
    // The terse report exists to say nothing when nothing is wrong. This line is not a finding — it is a
    // location, and the run most likely to be about to deploy is the one where everything else is green
    // (#206). Same rule the `Secrets:` line follows.
    const report = await buildDoctorReport(healthyOptions());
    expect(renderDoctorText(report, "/home/u")).toContain("Cloudflare:");
  });

  test("the resolved file is tilde-abbreviated, exactly as every other path in the report is", async () => {
    const report = await buildDoctorReport(
      healthyOptions({
        checkCloudflare: async () => ({
          state: "ok" as const,
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
          configPath: "/home/u/.config/pithy/cloudflare.leed.json",
          accountName: "leed",
          accountMismatch: null,
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("~/.config/pithy/cloudflare.leed.json");
    expect(text).not.toContain("/home/u/.config/pithy/cloudflare.leed.json");
  });

  test("--json carries the resolved file, the account name, and any mismatch", async () => {
    const report = await buildDoctorReport(
      healthyOptions({
        checkCloudflare: async () => ({
          state: "ok" as const,
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
          configPath: "/home/u/.config/pithy/cloudflare.leed.json",
          accountName: "leed",
          accountMismatch: null,
        }),
      }),
    );
    // Absolute here, not abbreviated: an agent reading this needs a path it can open.
    expect(renderDoctorJson(report).cloudflare).toMatchObject({
      configPath: "/home/u/.config/pithy/cloudflare.leed.json",
      accountName: "leed",
      accountMismatch: null,
    });
  });

  test("--json reports null for each of those when nothing named a file", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(renderDoctorJson(report).cloudflare).toMatchObject({
      configPath: null,
      accountName: null,
      accountMismatch: null,
    });
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

/**
 * `PITHY_OFFLINE` (#218). `doctor` is the command people run when something is wrong, including on a
 * machine that is not theirs — so it is the one that must be able to answer without reaching anything.
 */
describe("offline", () => {
  /** A registry stub that fails the test rather than answering: nothing may query npm in this mode. */
  function forbiddenFetch(): FetchLike {
    return (async () => {
      throw new Error("nothing may reach the network when the caller has said offline");
    }) as unknown as FetchLike;
  }

  test("the variable puts the whole report offline, with no flag and no seam", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ env: { PITHY_OFFLINE: "1" }, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    expect(report.offline).toBe(true);
    expect(report.cloudflare.state).toBe("not_checked");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("the option forces it with no variable set, which is what --offline passes", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    expect(report.offline).toBe(true);
    expect(report.cloudflare.state).toBe("not_checked");
  });

  test("the registry is not queried either — a diagnostic that claims offline may not phone npm", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("unreachable");
    }) as unknown as FetchLike;
    const report = await buildDoctorReport(healthyOptions({ offline: true, fetch, checkCloudflare: undefined }));
    expect(fetch).not.toHaveBeenCalled();
    expect(report.cli.latest).toBeNull();
    expect(report.cli.state).toBe("unknown");
  });

  test("the version lines say skipped, not unreachable — the registry was never asked", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Version check skipped (offline).");
    expect(text).toContain("Project capabilities: version check skipped (offline)");
    expect(text).not.toContain("registry unreachable");
  });

  test("the Cloudflare line says what was not done, and never reads as a pass", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Cloudflare: not checked — offline (PITHY_OFFLINE or --offline)",
    );
  });

  test("--json carries the mode, so an agent can tell a skipped check from a passing one", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    const json = renderDoctorJson(report) as { offline: boolean; cloudflare: { state: string } };
    expect(json.offline).toBe(true);
    expect(json.cloudflare.state).toBe("not_checked");
  });

  test("an ordinary run is untouched — `offline` is false and every check still runs", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(report.offline).toBe(false);
    expect(renderDoctorJson(report).offline).toBe(false);
    expect(report.cli.latest).toBe("1.3.0");
    expect(renderDoctorText(report, "/home/u")).not.toContain("PITHY_OFFLINE");
  });

  test("a not-checked Cloudflare state never fails the exit — nothing was established", () => {
    const report = { cloudflare: { state: "not_checked" }, project: null } as unknown as DoctorReport;
    expect(doctorExitCode(report)).toBe(0);
  });

  test("--json names where the credentials came from, on every run", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "ok",
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
          configPath: "/home/u/.config/pithy/cloudflare.json",
          accountName: null,
          accountMismatch: null,
          credentialSource: "environment",
        }),
      }),
    );
    expect(renderDoctorJson(report).cloudflare).toMatchObject({ credentialSource: "environment" });
    expect(renderDoctorText(report, "/home/u")).toContain(
      "credentials from the environment, not ~/.config/pithy/cloudflare.json",
    );
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

/**
 * The `.dev.vars` files, and the state #178 was reported from: a project whose Worker was getting
 * nothing while `doctor` called it healthy. Reported, never gated — but never silent either.
 */
describe("dev vars", () => {
  const devVars =
    (over: Partial<DoctorReport["devVars"] & object> = {}) =>
    async () => ({
      root: [],
      empty: [],
      minted: [],
      devJsonSecrets: [],
      devConfigPath: "/home/u/.config/pithy/acme/dev.json",
      unresolvable: [],
      ...over,
    });

  test("an empty generated file names the Worker and drags the report verbose", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkDevVars: devVars({ empty: [{ worker: "board", file: "apps/board/.dev.vars" }] }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Dev secrets:");
    expect(text).toContain("board has no dev values");
    expect(text).toContain("apps/board/.dev.vars");
    // Worth the ink, not worth a red CI: every project that predates the generated file starts here.
    expect(doctorExitCode(report)).toBe(0);
    expect(text).toContain("Config dir:");
  });

  test("a key nothing reads is named, and so is a credential left in the checkout beside it", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkDevVars: devVars({
          root: [
            { key: "CLOUDFLARE_API_TOKEN", state: "credential", workers: [] },
            { key: "LEFTOVER_FROM_2024", state: "unread", workers: [] },
          ],
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("LEFTOVER_FROM_2024 is in .dev.vars and nothing reads it");
    // #182 moved the credentials to `<config>/cloudflare.json`, so this copy is a live token in a
    // checkout that nothing reads. It was the one silent class here; it is not any more.
    expect(text).toContain("CLOUDFLARE_API_TOKEN is in .dev.vars, which nothing reads now");
  });

  test("a healthy project says nothing and stays terse", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkDevVars: devVars() }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).not.toContain("Dev secrets:");
    expect(text).not.toContain("Config dir:");
  });

  test("outside a project the question is never asked", async () => {
    const probe = vi.fn(devVars());
    const report = await buildDoctorReport(
      harness.healthyOptions({ loadProject: undefined, checkDevVars: probe as DoctorReportOptions["checkDevVars"] }),
    );
    expect(report.devVars).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  test("--json carries the whole classification, names only", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkDevVars: devVars({
          root: [{ key: "SECRETS_ENCRYPTION_KEYS", state: "binding", workers: ["board"] }],
          empty: [{ worker: "board", file: "apps/board/.dev.vars" }],
        }),
      }),
    );
    const json = renderDoctorJson(report) as { devVars: { root: unknown[]; empty: unknown[]; detail: string[] } };
    expect(json.devVars.root).toHaveLength(1);
    expect(json.devVars.empty).toHaveLength(1);
    expect(json.devVars.detail.join("\n")).toContain("SECRETS_ENCRYPTION_KEYS");
  });
});

/**
 * The `Secrets:` line, which is a **location** rather than a finding — the one line in the report that
 * nothing else in the toolchain could tell you. The file is outside every checkout since #156, so a
 * report that omits it leaves an adopter with no way to find it at all, and "where is it" is not a
 * complaint the terse report is entitled to suppress (#166).
 */
describe("dev secrets file", () => {
  const location =
    (over: Partial<DoctorReport["devSecretsFile"] & object> = {}) =>
    async () => ({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      present: true,
      orphans: [],
      ...over,
    });

  test("prints in the verbose report, beside the other config paths", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevSecretsFile: location() }));
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Secrets:    ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`)",
    );
  });

  /**
   * The command, not only the path. The file is outside the checkout, so nothing an adopter can browse
   * leads to it and this line is the only place the toolchain names either one (#186).
   */
  test("names the command that opens it, in both forms of the report", async () => {
    const verbose = await buildDoctorReport(baseOptions({ checkDevSecretsFile: location() }));
    const terse = await buildDoctorReport(harness.healthyOptions({ checkDevSecretsFile: location() }));
    for (const report of [verbose, terse]) {
      expect(renderDoctorText(report, "/home/u")).toContain("(run `pithy secrets edit`)");
    }
  });

  test("prints in the terse report too — a healthy project is the one most likely to be asking", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkDevSecretsFile: location() }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Secrets: ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`)",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities: all up to date",
        "",
        "Cloudflare: reachable (token active)",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
    // A path is not a fault: naming it must not gate CI, and must not drag the rest of the report out.
    expect(doctorExitCode(report)).toBe(0);
    expect(text).not.toContain("Config dir:");
  });

  /**
   * The rename trail, in the only report that can carry it. `devSecretsFile` is deliberately not a term
   * in the terse predicate, so a project whose *only* anomaly is a renamed or duplicated config directory
   * renders terse — and before #166 that put the trail out of reach in exactly the case it was written for.
   */
  test("a renamed project's trail prints in the terse report", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevSecretsFile: location({ present: false, orphans: ["acme-old"] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Secrets: ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`) — no file yet; secrets exist for acme-old — a renamed project leaves its old name here",
    );
  });

  test("outside a project there is no line at all — no config, no name to key a path on", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkDevSecretsFile: async () => null }));
    expect(report.devSecretsFile).toBeNull();
    expect(renderDoctorText(report, "/home/u")).not.toContain("Secrets:");
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

/**
 * The finding `pithy doctor` did not report.
 *
 * `availableManifests` skipped a manifest that was present and invalid exactly as it skips a package that
 * ships none, so the capability was absent from every check the health block runs and the block said the
 * project was healthy. Doctor is one of the three commands an adopter runs when a capability has gone
 * missing, and it was one of the three that stayed silent (#184).
 */
describe("manifest faults in the health block", () => {
  /** Install a manifest the schema refuses into the report's own project directory. */
  async function installBrokenManifest(): Promise<void> {
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "audit");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "audit",
        package: "@pithy-sh/audit",
        requiredBindings: [],
        configOptions: [{ key: "content-type", default: "x", describe: "Not a bare key." }],
      }),
    );
  }

  test("names the package and the reason, and fails the exit", async () => {
    await installBrokenManifest();
    const report = await buildDoctorReport(healthyOptions({ buildPlan: planStub(cleanPlan) }));

    expect(report.project?.health.manifests.ok).toBe(false);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("@pithy-sh/audit");
    expect(text).toContain("malformed pithy.manifest.json");
    expect(text).toContain("configOptions[0].key");
    // The Worker itself is clean; the project is not, and CI can gate on it.
    expect(report.project?.health.workers.every((worker) => worker.ok)).toBe(true);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("a package that ships no manifest is still skipped in silence", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "cli"), { recursive: true });
    const report = await buildDoctorReport(healthyOptions({ buildPlan: planStub(cleanPlan) }));
    expect(report.project?.health.manifests).toEqual({ ok: true, faults: [] });
    expect(doctorExitCode(report)).toBe(0);
  });
});

/**
 * One optional line's failure must not cost every other line (#210).
 *
 * `doctor` deliberately discards read failures — a diagnostic has to work in the environment it
 * diagnoses — and the shell rc read was the one that did not follow the rule. An unreadable `~/.bashrc`
 * threw out of `buildDoctorReport` and the whole report went with it: Cloudflare reachability, the
 * secrets paths, project health, dev secrets. The least important line in the report took the other
 * twenty with it.
 *
 * Catching it to `false` is not the fix and is why #203 left it alone: `Alias: not installed` about a
 * file nothing could read is a lie, and the adopter's next move is `pithy alias`, which fails on the
 * same file. The field is tri-state, and the third state names the file.
 */
describe("one unreadable file must not cost the whole report (#210)", () => {
  /** The refusal `readRcFile` raises for a file that is there and will not open. */
  const unreadableRc = async (path: string): Promise<string> => {
    throw new ConflictError({
      message: `Can't read ${path}.`,
      action: "Fix the file's permissions, or add the Pithy alias to your shell config yourself.",
      detail: `EACCES while reading ${path}`,
    });
  };

  test("an unreadable rc file produces a report, not an exception", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));

    // Everything the crash used to take with it is still here.
    expect(report.cloudflare.state).toBe("ok");
    expect(report.project).not.toBeNull();
    expect(report.os).toEqual({ name: "macOS", version: "14.5" });
  });

  test("the alias status is unknown, and names the file — never 'not installed'", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));

    expect(report.alias.state).toBe("unknown");
    expect(report.alias.rcPath).toBe("/home/u/.zshrc");
    expect(report.alias.reason).toContain("Can't read /home/u/.zshrc.");

    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Alias: unknown — can't read ~/.zshrc");
    expect(text).not.toContain("Alias: not installed");
  });

  test("an unknown alias keeps the report verbose — 'I could not check' is worth the ink", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));
    // The terse report drops the rc path from the `Shell:` line. A state nobody established must not
    // be reported in the form that says there is nothing to look at.
    expect(renderDoctorText(report, "/home/u")).toContain("Shell: zsh (~/.zshrc)");
  });

  test("--json carries the third state, and the two ordinary ones keep their shape", async () => {
    const unknown = renderDoctorJson(await buildDoctorReport(healthyOptions({ readRc: unreadableRc })));
    expect(unknown.alias).toEqual({
      state: "unknown",
      rcPath: "/home/u/.zshrc",
      reason: expect.stringContaining("Can't read /home/u/.zshrc."),
    });

    const installed = renderDoctorJson(await buildDoctorReport(healthyOptions()));
    expect(installed.alias).toEqual({ state: "installed", rcPath: "/home/u/.zshrc", reason: null });

    const absent = renderDoctorJson(await buildDoctorReport(healthyOptions({ readRc: async () => "" })));
    expect(absent.alias).toEqual({ state: "not-installed", rcPath: "/home/u/.zshrc", reason: null });
  });

  test("an alias nobody could read never fails the exit — toolchain state never does", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));
    expect(doctorExitCode(report)).toBe(0);
  });

  /**
   * The general case, which is the point rather than the rc file. `doctor` also *writes* one file — the
   * notifier cache — and a config directory it cannot write to is exactly the machine somebody runs
   * `doctor` on. That write is bookkeeping for the next run; it must not cost this one its report.
   */
  test("a config directory that cannot be written still produces a report", async () => {
    const readOnly = join(dir, "read-only");
    await mkdir(readOnly, { recursive: true });
    await chmod(readOnly, 0o500);
    try {
      const report = await buildDoctorReport(healthyOptions({ stateFile: join(readOnly, "state.json") }));
      expect(report.cli.installed).toBe("1.3.0");
      expect(report.project).not.toBeNull();
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  /**
   * Every file the real checks read, made unreadable one at a time against a real scaffold.
   *
   * The rule is not "doctor should catch more" — it is that no single read may cost every other line, and
   * the only way to know that is to break each of them. Every seam here is the real function: stubbing
   * them would test the stubs.
   */
  test("no single unreadable file in a real project prevents the report", async () => {
    const projectDir = join(dir, "unreadable");
    await scaffoldProject({ targetDir: projectDir, appName: "replay", worker: "board" });
    const worker = join(projectDir, "apps", "board");
    await writeFile(join(projectDir, ".dev.vars"), "OLD_FLAG=1\n");
    await writeFile(join(worker, ".dev.vars.local"), "LOCAL_ONLY=1\n");

    const files = [
      join(projectDir, ".dev.vars"),
      join(worker, ".dev.vars.local"),
      join(worker, "wrangler.jsonc"),
      join(worker, "pithy.worker.jsonc"),
      join(worker, "pithy.config.ts"),
      join(projectDir, "pithy.config.ts"),
    ];

    for (const file of files) {
      await chmod(file, 0o000);
      try {
        const report = await buildDoctorReport(
          baseOptions({
            projectDir,
            buildPlan: planStub(cleanPlanFor("board")),
            resolveWorkers: undefined,
            // The real name check too — it reads every `wrangler.jsonc` in the project, and with no
            // credentials resolved (`NO_ACCOUNT`) it never reaches an account. Only the Cloudflare probe
            // stays stubbed, because that one is the network.
            checkProjectName: undefined,
          }),
        );
        expect(report.os, `${file} took the report with it`).toEqual({ name: "macOS", version: "14.5" });
      } finally {
        await chmod(file, 0o644);
      }
    }
  });
});

/**
 * A Worker nobody could ask, in the report (#208).
 *
 * The `Dev secrets:` block used to disappear entirely when every `pithy.config.ts` failed to import: the
 * lossy target list answered `[]`, `checkDevSecrets` read that as "no Worker composes secrets" and
 * returned `null`, and the report went quiet in the one state it was written for. Same shape as #166 —
 * a line that vanishes in the report that needed it.
 */
describe("a Worker nobody could ask, in the report (#208)", () => {
  const broken = [
    { name: "replay-board", dir: "/p/apps/board", reason: "apps/board/pithy.config.ts would not import. Fix it." },
  ];

  const options = () =>
    harness.healthyOptions({
      checkDevVars: async () => ({
        root: [{ key: "MYSTERY_KEY", state: "unclassified" as const, workers: [] }],
        empty: [],
        minted: [],
        devJsonSecrets: [],
        devConfigPath: "/home/u/.config/pithy/acme/dev.json",
        unresolvable: broken,
      }),
      checkDevSecrets: async () => ({
        path: "/home/u/.config/pithy/acme/secrets.jsonc",
        misplaced: [],
        missing: [],
        bootstrapMissing: [],
        malformed: [],
        undeclared: [],
        mode: null,
        unreadable: null,
        unresolvable: broken,
      }),
    });

  test("the block prints, names the Worker, and never says the value can go", async () => {
    const text = renderDoctorText(await buildDoctorReport(options()), "/home/u");

    expect(text).toContain("Dev secrets:");
    expect(text).toContain("replay-board's pithy.config.ts would not import");
    expect(text).toContain("MYSTERY_KEY is in .dev.vars, and nothing here can say what reads it");
    expect(text).not.toContain("Delete it.");
  });

  test("the rest of the report is still there — a diagnostic reports, it does not refuse", async () => {
    const report = await buildDoctorReport(options());
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Cloudflare: reachable");
    expect(text).toContain("Project: pithy.config.ts found");
    expect(text).toContain("OS:      macOS 14.5");
    // Reported, never gated: an unloadable Worker config is the `Project:` block's to fail the exit on.
    expect(doctorExitCode(report)).toBe(0);
  });

  test("--json tells 'no Worker composes secrets' from 'nothing would load'", async () => {
    const named = renderDoctorJson(await buildDoctorReport(options())) as {
      devSecrets: { unresolvable: { name: string }[] };
      devVars: { unresolvable: { name: string }[] };
    };
    expect(named.devSecrets.unresolvable.map((worker) => worker.name)).toEqual(["replay-board"]);
    expect(named.devVars.unresolvable.map((worker) => worker.name)).toEqual(["replay-board"]);

    // The project with no secrets keeps the shape it always had: one `null`, one fact.
    const quiet = renderDoctorJson(
      await buildDoctorReport(harness.healthyOptions({ checkDevSecrets: async () => null })),
    );
    expect(quiet.devSecrets).toBeNull();
  });
});

/**
 * Every fault the human report shows, in `--json` (#325).
 *
 * `unreadable` became the loader's sentence in #323 and the projection passed it through unchanged, so a
 * CI script gating on `unreadable === true` stopped firing and read a broken secrets file as healthy — a
 * non-empty string is not `false`, it is merely not `true`. `malformed` and `bootstrapMissing` were never
 * projected at all, and `malformed` is the one that flips the exit.
 */
describe("--json carries every dev-secrets fault the text block prints (#325)", () => {
  const faulty = () =>
    harness.healthyOptions({
      checkDevSecrets: async () => ({
        path: "/home/u/.config/pithy/acme/secrets.jsonc",
        misplaced: [],
        missing: [],
        bootstrapMissing: ["SECRETS_ENCRYPTION_KEYS"],
        malformed: [{ name: "auth-google-credentials", reason: "auth-google-credentials is not the shape it needs." }],
        undeclared: [],
        mode: null,
        unreadable: null,
        unresolvable: [],
      }),
    });

  test("a malformed value is in the payload, and so is the bootstrap key nobody minted", async () => {
    const json = renderDoctorJson(await buildDoctorReport(faulty())) as {
      devSecrets: { malformed: { name: string; reason: string }[]; bootstrapMissing: string[]; healthy: boolean };
    };

    expect(json.devSecrets.malformed.map((one) => one.name)).toEqual(["auth-google-credentials"]);
    expect(json.devSecrets.malformed[0]?.reason).toContain("not the shape it needs");
    expect(json.devSecrets.bootstrapMissing).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
  });

  /**
   * The one field a script can gate on without knowing which faults exist. `unreadable === true` was that
   * field and stopped being it silently; this one is computed from `devSecretsHealthy`, the same function
   * the text renderer draws the fault line from, so the two cannot come to two answers.
   */
  test("`healthy` answers the whole question, and agrees with what the text report says", async () => {
    const broken = await buildDoctorReport(faulty());
    const brokenJson = renderDoctorJson(broken) as { devSecrets: { healthy: boolean } };
    expect(brokenJson.devSecrets.healthy).toBe(false);
    expect(renderDoctorText(broken, "/home/u")).toContain("Dev secrets:");

    const fine = await buildDoctorReport(
      harness.healthyOptions({
        checkDevSecrets: async () => ({
          path: "/home/u/.config/pithy/acme/secrets.jsonc",
          misplaced: [],
          missing: [],
          bootstrapMissing: [],
          malformed: [],
          undeclared: [],
          mode: null,
          unreadable: null,
          unresolvable: [],
        }),
      }),
    );
    expect((renderDoctorJson(fine) as { devSecrets: { healthy: boolean } }).devSecrets.healthy).toBe(true);
    expect(renderDoctorText(fine, "/home/u")).not.toContain("Dev secrets:");
  });

  /** A file that will not parse: the sentence is carried, and it is truthy, so a `if (…unreadable)` gate fires. */
  test("an unreadable file carries its sentence and reads as a fault", async () => {
    const json = renderDoctorJson(
      await buildDoctorReport(
        harness.healthyOptions({
          checkDevSecrets: async () => ({
            path: "/home/u/.config/pithy/acme/secrets.jsonc",
            misplaced: [],
            missing: [],
            bootstrapMissing: [],
            malformed: [],
            undeclared: [],
            mode: null,
            unreadable: "secrets.jsonc is not valid JSONC at line 3.",
            unresolvable: [],
          }),
        }),
      ),
    ) as { devSecrets: { unreadable: string | null; healthy: boolean } };

    expect(json.devSecrets.unreadable).toContain("line 3");
    expect(json.devSecrets.healthy).toBe(false);
  });
});
