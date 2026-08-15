// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { ReconcilePlan } from "../capabilities/reconcile";
import type { DoctorReportOptions } from "../commands/doctor";
import type { BuildPlan } from "../doctor/health";
import type { FetchLike } from "../notifier/check";
import type { ShellInfo } from "../platform/shell";
import type { ProjectConfig } from "../project/config";
import type { ResolvedWorker } from "../project/workerScope";

/**
 * Shared scaffolding for building a `DoctorReport` — every environment and network seam stubbed, so a
 * suite states only the scenario it is about.
 *
 * Extracted so there is exactly one way to construct a report. `commands/doctor.test.ts` asserts what the
 * renderer prints; `commands/doctorDocs.test.ts` asserts that `docs/CLI.md` prints the same thing. Two
 * builders would let the doc pin drift from the suite it is meant to hold the doc against — the pin would
 * still pass while describing a report the CLI no longer produces.
 */

/** A `fetch` mapping each package's registry URL to a canned latest version. */
export function registryFetch(versions: Record<string, string>): FetchLike {
  return vi.fn(async (url: string) => {
    const match = url.match(/@pithy-sh%2F([^/]+)\/latest/);
    const name = match?.[1] ?? "";
    const version = versions[name];
    if (!version) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version }) };
  });
}

/**
 * A clean plan for one Worker.
 *
 * `deployedAs` is derived rather than echoed, so every fixture built here has a directory and a deployed
 * name that differ. A harness that set both to `worker` would let code reading the wrong one pass.
 */
export const cleanPlanFor = (worker: string): ReconcilePlan => ({
  worker,
  deployedAs: `acme-${worker}`,
  env: "dev",
  perCapability: [],
  ejectedSkipped: [],
  ledger: { state: "read", pending: 0, undeclared: [] },
  entitlementGap: [],
  missingPrerequisites: [],
  missingVersionMetadata: false,
});

/** A plan builder that stamps the requested Worker's name onto a fixed plan. */
export const planStub = (plan: ReconcilePlan): BuildPlan =>
  vi.fn(async (options) => ({ ...plan, worker: options.worker ?? plan.worker }));

/** A plan builder keyed by Worker — for a project whose Workers differ. */
export const planStubPer = (plans: Record<string, ReconcilePlan>): BuildPlan =>
  vi.fn(async (options) => plans[options.worker ?? ""] ?? cleanPlanFor(options.worker ?? ""));

/** The Worker set doctor's resolver seam returns; `ResolvedWorker` is satisfied structurally. */
export const workerSet = (...names: string[]) =>
  names.map((name) => ({ name, dir: `/p/apps/${name}`, capabilities: [] }) as unknown as ResolvedWorker);

/** The shell every fixture reports — installed alias included, so the alias line is a constant. */
export const zsh: ShellInfo = { kind: "zsh", rcPath: "/home/u/.zshrc", aliasSyntax: "alias p.='pithy'" };

/** The loaded root config every fixture reports. */
export const config: ProjectConfig = { name: "pithy-app" };

/** A throwaway directory per test, plus the two option builders every doctor suite starts from. */
export interface DoctorHarness {
  /** The temp project directory. A getter: `beforeEach` makes a new one for every test. */
  readonly dir: string;
  /** The notifier state file inside it. */
  readonly stateFile: string;
  /** A project present, fresh registry, deterministic env/os/runtime — the verbose starting point. */
  baseOptions(overrides?: Partial<DoctorReportOptions>): DoctorReportOptions;
  /** Nothing to report: current CLI, current capabilities, alias installed — the terse starting point. */
  healthyOptions(overrides?: Partial<DoctorReportOptions>): DoctorReportOptions;
}

/**
 * Registers the per-test temp directory and returns the option builders. Call it once at module or
 * `describe` scope; `dir` is a getter because each test gets a fresh directory, so a plain value captured
 * at import would go stale after the first test.
 */
export function doctorHarness(): DoctorHarness {
  let dir = "";
  let stateFile = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-doctor-"));
    stateFile = join(dir, "state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function baseOptions(overrides: Partial<DoctorReportOptions> = {}): DoctorReportOptions {
    return {
      projectDir: dir,
      installedVersion: "1.2.0",
      stateFile,
      argv1: "/home/u/.bun/bin/pithy",
      env: {},
      homedir: "/home/u",
      os: { name: "macOS", version: "14.5" },
      runtime: { name: "Node", version: "22.10.0", nodeCompat: null },
      node: "22.10.0",
      // Injected so the unit suite never reaches Cloudflare; the live probe is exercised by its own module.
      checkCloudflare: async () => ({
        state: "ok" as const,
        missing: [],
        tokenStatus: "active",
        credentialSplit: null,
      }),
      // Same reason: unstubbed, every test here would list the real account's D1 and R2.
      checkProjectName: async () => ({ state: "ok" as const, project: "pithy-app", misnamed: [] }),
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
      buildPlan: planStub(cleanPlanFor("api")),
      ...overrides,
    };
  }

  return {
    get dir(): string {
      return dir;
    },
    get stateFile(): string {
      return stateFile;
    },
    baseOptions,
    healthyOptions(overrides: Partial<DoctorReportOptions> = {}): DoctorReportOptions {
      return baseOptions({
        installedVersion: "1.3.0",
        argv1: "/opt/homebrew/bin/pithy",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
        installedCapabilities: async () => [
          { name: "@pithy-sh/core", version: "1.2.0" },
          { name: "@pithy-sh/auth", version: "1.2.0" },
          { name: "@pithy-sh/leaderboard", version: "1.2.0" },
        ],
        ...overrides,
      });
    },
  };
}
