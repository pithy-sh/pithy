// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";
import {
  detectPackageManager,
  type InstallRunner,
  type PackageManager,
  runPackageManager,
} from "../project/packageManager";
import { withRollback } from "../project/rollback";
import { pathExists } from "../project/scaffold";
import {
  installedVersionFrom,
  type PackageHeld,
  type PackageLeftAlone,
  type PackageMove,
  readPackagePlan,
} from "./plan";
import type { RegistryFetch } from "./registry";
import { type TemplateSection, templateSections } from "./templates";

/**
 * `pithy upgrade --packages`, end to end up to the reconcile: plan, report the templates, write, install
 * once, and check that what was asked for is what landed.
 *
 * **The template report is read before the install**, because the install is what replaces the versions it
 * compares from. **The writes and the install are one rollback scope**: a failed install puts every
 * `package.json` and the lockfile back byte for byte, so the adopter is never left holding ranges that name
 * versions their `node_modules` does not have.
 *
 * **What landed is read back, not assumed.** A package manager can resolve something other than the range
 * asked for — a peer constraint, an override, a stale store — and exit 0. A range that says `^0.2.3` over a
 * `node_modules` holding 0.2.0 is the state doctor would then report as outdated with no command to clear
 * it, which is the whole defect this issue is about, one layer down.
 */

/** A move whose target is not what the manifest's directory resolves after the install. */
export interface PackageMismatch {
  name: string;
  manifest: string;
  /** The version the rewritten range was expected to install. */
  expected: string;
  /** What is installed there now, or `null` when nothing is. */
  installed: string | null;
}

/** The `packages` block of `pithy upgrade --json`, and what the text report renders. */
export interface PackagesReport {
  /** `unavailable` when any packument would not read. Nothing is written or installed then. */
  state: "read" | "unavailable";
  packageManager: PackageManager;
  /** Whether the install ran. False on a dry run, with nothing to move, and when unavailable. */
  installed: boolean;
  /** Whether this run reconciled the Workers afterwards. False when `@pithy-sh/cli` itself moved. */
  reconciled: boolean;
  moves: PackageMove[];
  held: PackageHeld[];
  leftAlone: PackageLeftAlone[];
  mismatches: PackageMismatch[];
  templates: TemplateSection[];
}

/** What the step hands back to `runUpgrade`. */
export interface PackageStepResult {
  report: PackagesReport;
  /** The version `@pithy-sh/cli` was moved to and installed, or `null`. Set only on a real run. */
  cliMoved: string | null;
}

/**
 * The lockfiles a rollback can restore. `bun.lockb` is not among them: it is binary, and `withRollback`
 * snapshots text, so restoring it would write back a corrupted copy of the thing it was protecting.
 */
const TEXT_LOCKFILES = ["bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"] as const;

/** Rewrite each moved entry, one write per manifest, then install once at the root, all under one rollback. */
async function applyMoves(options: {
  projectDir: string;
  packageManager: PackageManager;
  moves: readonly PackageMove[];
  runInstall: InstallRunner;
}): Promise<void> {
  const { projectDir, packageManager: pm } = options;
  // Every file planned before any is written.
  const writes = new Map<string, string>();
  for (const manifest of new Set(options.moves.map((move) => move.manifest))) {
    const path = join(projectDir, manifest);
    const doc = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const move of options.moves.filter((entry) => entry.manifest === manifest)) {
      const block = doc[move.field];
      if (block) block[move.name] = move.to;
    }
    writes.set(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
  const lockfiles: string[] = [];
  for (const name of TEXT_LOCKFILES) {
    if (await pathExists(join(projectDir, name))) lockfiles.push(join(projectDir, name));
  }

  let installing = false;
  try {
    await withRollback({ root: projectDir, paths: [...writes.keys(), ...lockfiles] }, async () => {
      for (const [path, content] of writes) await writeFileAtomic(path, content);
      installing = true;
      await options.runInstall(pm, ["install"], projectDir);
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (!installing) {
      throw new InternalError(
        {
          message: "A package.json could not be written. Nothing changed.",
          action: "Check the files' permissions.",
          detail,
        },
        { cause },
      );
    }
    throw new InternalError(
      {
        message: `${pm} install failed. package.json files restored.`,
        action: `Run ${pm} install to settle node_modules.`,
        detail,
      },
      { cause },
    );
  }
}

/** Every move whose manifest's directory does not now resolve its target. */
async function mismatches(projectDir: string, moves: readonly PackageMove[]): Promise<PackageMismatch[]> {
  const out: PackageMismatch[] = [];
  for (const move of moves) {
    const installed = await installedVersionFrom(join(projectDir, dirname(move.manifest)), move.name);
    if (installed !== move.target) {
      out.push({ name: move.name, manifest: move.manifest, expected: move.target, installed });
    }
  }
  return out;
}

/** Plan, report the templates, and — unless this is a dry run — write, install and verify. */
export async function runPackageStep(options: {
  projectDir: string;
  latest: boolean;
  dryRun: boolean;
  fetch?: RegistryFetch;
  runInstall?: InstallRunner;
}): Promise<PackageStepResult> {
  const packageManager = await detectPackageManager(options.projectDir);
  const read = await readPackagePlan({
    projectDir: options.projectDir,
    latest: options.latest,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const report: PackagesReport = {
    state: read.state,
    packageManager,
    installed: false,
    reconciled: false,
    moves: read.plan.moves,
    held: read.plan.held,
    leftAlone: read.plan.leftAlone,
    mismatches: [],
    templates: [],
  };
  if (read.state === "unavailable") return { report, cliMoved: null };

  report.templates = await templateSections({
    projectDir: options.projectDir,
    plan: read.plan,
    packuments: read.packuments,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (options.dryRun || read.plan.moves.length === 0) return { report, cliMoved: null };

  await applyMoves({
    projectDir: options.projectDir,
    packageManager,
    moves: read.plan.moves,
    runInstall: options.runInstall ?? runPackageManager,
  });
  report.installed = true;
  report.mismatches = await mismatches(options.projectDir, read.plan.moves);
  const cli = read.plan.moves.filter((move) => move.name === "@pithy-sh/cli").map((move) => move.target);
  return { report, cliMoved: cli[0] ?? null };
}
