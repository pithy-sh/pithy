// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSemver } from "@pithy-sh/core/src/semver/semver";
import { compareVersions, parseVersion } from "../notifier/version";
import type { PackageManager } from "../project/packageManager";

/**
 * The version ranges `pithy upgrade --packages` moves, and the one rule both it and `pithy doctor` read.
 *
 * **Three shapes are managed, and nothing else is.** `^x.y.z`, `~x.y.z` and an exact `x.y.z` are what
 * `pithy add` writes and what an adopter types by hand, and for each of them "the newest version this admits"
 * and "the same range, one floor higher" are both unambiguous. Every other spec — `workspace:*`, a `link:`,
 * a git URL, a tag, `>=`, `||`, an x-range — is either not a registry range at all or one whose rewrite
 * would be a guess about intent, so it is reported and left exactly as written.
 *
 * **The boundary is the kit's convention, not npm's.** A caret over `0.x` admits patches only (`^0.2.0` is
 * `<0.3.0`), because the kit treats a `0.x` minor as breaking. That is what npm's caret does too, which is
 * why the default move never crosses a boundary: the range already stops there. {@link crossesBreakingBoundary}
 * is that same rule stated once, so the hold and doctor's note cannot disagree about it.
 */

/** The operator a managed range carries. The empty string is an exact pin. */
export type RangeOperator = "^" | "~" | "";

/** A managed range, split into the operator it keeps and the floor it moves. */
export interface ManagedRange {
  /** `^`, `~`, or `""` for an exact pin. */
  operator: RangeOperator;
  /** The lowest version the range admits, as written: `0.2.0`. */
  floor: string;
}

/** Why a declared spec is left alone. */
export type LeftAloneReason = "not-a-registry-range" | "linked";

/** One `@pithy-sh/*` declaration in one manifest. */
export interface DeclaredSpec {
  /** The package, scoped: `@pithy-sh/auth`. */
  name: string;
  /** The manifest it is declared in, relative to the project root: `package.json`, `apps/board/package.json`. */
  manifest: string;
  /** The field that declares it. */
  field: "dependencies" | "devDependencies";
  /** The spec as written. */
  spec: string;
}

const MANAGED = /^([\^~]?)(\d+\.\d+\.\d+)$/;

/** A managed range, or `null` for every spec this command leaves alone. */
export function parseRange(spec: string): ManagedRange | null {
  const match = MANAGED.exec(spec);
  if (!match) return null;
  const floor = match[2] ?? "";
  // A floor the semver grammar refuses (a leading zero) is not one this command can move honestly.
  const parsed = parseSemver(floor);
  if (!parsed || parsed.prerelease !== null) return null;
  return { operator: (match[1] ?? "") as RangeOperator, floor };
}

/** Why a spec is unmanaged, or `null` when it is managed. Linked packages are decided elsewhere. */
export function unmanagedReason(spec: string): LeftAloneReason | null {
  return parseRange(spec) === null ? "not-a-registry-range" : null;
}

/** Whether `version` is a stable release, as opposed to a prerelease or not a version at all. */
export function isStable(version: string): boolean {
  const parsed = parseSemver(version);
  return parsed !== null && parsed.prerelease === null;
}

/** Whether `range` admits `version`. A prerelease is never admitted. */
export function admits(range: ManagedRange, version: string): boolean {
  if (!isStable(version)) return false;
  const floor = parseVersion(range.floor);
  const to = parseVersion(version);
  if (!floor || !to) return false;
  if (compareVersions(version, range.floor) < 0) return false;
  if (range.operator === "") return compareVersions(version, range.floor) === 0;
  if (range.operator === "~") return to.major === floor.major && to.minor === floor.minor;
  // Caret: the leftmost non-zero part is fixed.
  if (floor.major > 0) return to.major === floor.major;
  if (floor.minor > 0) return to.major === 0 && to.minor === floor.minor;
  return to.major === 0 && to.minor === 0 && to.patch === floor.patch;
}

/** The slice of a packument {@link candidateVersions} reads. */
export interface CandidateSource {
  /** `dist-tags.latest`. */
  latest: string;
  /** Every published version, with its deprecation notice when it has one. */
  versions: Record<string, { deprecated?: string | undefined }>;
}

/**
 * The versions a move may land on, oldest first: stable, not deprecated, and no newer than `latest`.
 *
 * `latest` is the ceiling because it is the publisher's statement of what is ready. A version above it —
 * published under `next`, or a mistake being walked back — is one nobody asked this command to install.
 */
export function candidateVersions(source: CandidateSource): string[] {
  return Object.entries(source.versions)
    .filter(([version, meta]) => isStable(version) && !meta.deprecated && compareVersions(version, source.latest) <= 0)
    .map(([version]) => version)
    .sort(compareVersions);
}

/** The newest candidate `range` admits, or `null`. */
export function newestAdmitted(range: ManagedRange, candidates: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of candidates) {
    if (admits(range, version) && (best === null || compareVersions(version, best) > 0)) best = version;
  }
  return best;
}

/**
 * Whether going from `from` to `to` crosses a breaking boundary: a new major, or a new minor while the
 * major is 0. An unparseable pair crosses nothing — there is nothing to measure.
 */
export function crossesBreakingBoundary(from: string, to: string): boolean {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return false;
  if (a.major !== b.major) return true;
  return a.major === 0 && a.minor !== b.minor;
}

/** The same range with its floor moved to `version`. The operator is kept, so a pin stays a pin. */
export function rewriteRange(range: ManagedRange, version: string): string {
  return `${range.operator}${version}`;
}

/** The two fields a manifest declares packages in, in the order they are read. */
const FIELDS = ["dependencies", "devDependencies"] as const;

/** One manifest's `@pithy-sh/*` declarations, or none when it is missing or will not parse. */
async function manifestSpecs(path: string, manifest: string): Promise<DeclaredSpec[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof doc !== "object" || doc === null) return [];
  const specs: DeclaredSpec[] = [];
  for (const field of FIELDS) {
    const block = (doc as Record<string, unknown>)[field];
    if (typeof block !== "object" || block === null) continue;
    for (const [name, spec] of Object.entries(block)) {
      if (name.startsWith("@pithy-sh/") && typeof spec === "string") specs.push({ name, manifest, field, spec });
    }
  }
  return specs;
}

/**
 * Every `@pithy-sh/*` declaration in the root `package.json` and each `apps/*` manifest — `@pithy-sh/cli`
 * included, because the issue is every `@pithy-sh/*` dependency and the CLI is one. Root first, then the
 * Workers in name order, so a report reads the same on every machine.
 */
export async function declaredSpecs(projectDir: string): Promise<DeclaredSpec[]> {
  const specs = await manifestSpecs(join(projectDir, "package.json"), "package.json");
  let workers: string[] = [];
  try {
    workers = (await readdir(join(projectDir, "apps"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No `apps/` — nothing more is declared.
  }
  for (const worker of workers) {
    const manifest = `apps/${worker}/package.json`;
    specs.push(...(await manifestSpecs(join(projectDir, "apps", worker, "package.json"), manifest)));
  }
  return specs;
}

/** Why doctor names no command for one outdated package. */
export type NoCommandReason =
  /** Declared in no manifest `--packages` reads: the copy is transitive. */
  | "not-declared"
  /** Declared in a shape `--packages` leaves alone. {@link PackageAdvice.declaredAs} names it. */
  | "not-a-registry-range"
  /** A checkout linked in at the root, which `--packages` leaves alone. */
  | "linked"
  /** `latest` is deprecated, and no move lands on a deprecated version. */
  | "deprecated"
  /** `latest` is a prerelease, which no range admits. */
  | "prerelease";

/** What doctor recommends for one outdated package. */
export interface PackageAdvice {
  /** The command that clears the line, or `null` when no command does. */
  command: string | null;
  /** The unmanaged spec that put it out of reach, or `null`. */
  declaredAs: string | null;
  /** Why `command` is `null`, or `null` when it is not. */
  reason: NoCommandReason | null;
}

/** The facts about one package, beyond its declarations, that decide what clears its line. */
export interface PackageFacts {
  /** Whether the root's copy is a checkout linked in — what `--packages` judges by `alreadyProvided`. */
  linked: boolean;
  /** Whether the version `latest` names is deprecated. */
  latestDeprecated: boolean;
  /** The project's package manager, for the install that settles a stale `node_modules`. */
  packageManager: PackageManager;
}

/** The command that moves every managed range to wherever `latest` is. */
export const PACKAGES_COMMAND = "pithy upgrade --packages";
/** The command that moves them across a boundary. */
export const PACKAGES_LATEST_COMMAND = "pithy upgrade --packages --latest";

/**
 * **The command that actually clears doctor's line for one package, or `null` when none does.**
 *
 * `specs` is every declaration of that one package. Each `null` is a case `--packages` would leave the line
 * where it is, so naming it would be the recommendation #634 was filed about: nothing declared (the copy is
 * transitive, and the package that pulls it in is the one to move), an unmanaged spec or a linked checkout
 * (both left alone), and a `latest` no move lands on (deprecated, or a prerelease).
 *
 * Otherwise it is the plan's own rule, per range. A range whose floor is already at `latest` has nothing to
 * move: the manifest says `latest` and `node_modules` does not, and the install is what settles it. A range
 * behind `latest` is moved by `--packages` when it admits `latest` and by `--latest` when it does not — and
 * either move installs, which settles any stale range beside it.
 */
export function packageCommand(specs: readonly DeclaredSpec[], latest: string, facts: PackageFacts): PackageAdvice {
  const none = (reason: NoCommandReason, declaredAs: string | null = null): PackageAdvice => ({
    command: null,
    declaredAs,
    reason,
  });
  if (specs.length === 0) return none("not-declared");
  const unmanaged = specs.find((spec) => parseRange(spec.spec) === null);
  if (unmanaged) return none("not-a-registry-range", unmanaged.spec);
  if (facts.linked) return none("linked");
  if (!isStable(latest)) return none("prerelease");
  if (facts.latestDeprecated) return none("deprecated");
  const behind = specs
    .map((spec) => parseRange(spec.spec))
    .filter((range): range is ManagedRange => range !== null && compareVersions(range.floor, latest) < 0);
  const command =
    behind.length === 0
      ? `${facts.packageManager} install`
      : behind.every((range) => admits(range, latest))
        ? PACKAGES_COMMAND
        : PACKAGES_LATEST_COMMAND;
  return { command, declaredAs: null, reason: null };
}
