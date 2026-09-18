// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareVersions } from "../notifier/version";
import { packageDirFrom } from "../project/kitResolve";
import { alreadyProvided } from "../project/packageManager";
import {
  admits,
  candidateVersions,
  crossesBreakingBoundary,
  type DeclaredSpec,
  declaredSpecs,
  type LeftAloneReason,
  newestAdmitted,
  PACKAGES_LATEST_COMMAND,
  parseRange,
  rewriteRange,
} from "./ranges";
import { fetchPackument, type Packument, type RegistryFetch } from "./registry";

/**
 * What `pithy upgrade --packages` would do to each `@pithy-sh/*` declaration, decided before anything is
 * written.
 *
 * **Per manifest, never per package.** The root and each `apps/*` manifest can declare one package with two
 * ranges, and each range is its own fact: rewriting one from the other's answer is how a Worker's pin gets
 * moved behind its back. So every entry below carries the manifest it came from.
 *
 * **A move rewrites the floor.** `^0.2.0` → `^0.2.3` is what makes the lockfile move: a bare reinstall under
 * an unchanged range is free to keep the version it already resolved, and does.
 */

/** One declaration this run rewrites. */
export interface PackageMove {
  /** The package: `@pithy-sh/auth`. */
  name: string;
  /** The manifest, relative to the project root. */
  manifest: string;
  /** The field that declares it. */
  field: DeclaredSpec["field"];
  /** The range as it was. */
  from: string;
  /** The range as it is written. */
  to: string;
  /** The version the new range is expected to install. */
  target: string;
}

/** One declaration whose `latest` is outside its range, and not moved there without `--latest`. */
export interface PackageHeld {
  name: string;
  manifest: string;
  /** The range as declared. */
  range: string;
  /** The version installed where this manifest resolves it, or `null` when nothing is. */
  installed: string | null;
  /** `dist-tags.latest`. */
  latest: string;
  /** `breaking` across a major, or a minor under 0.x; `outside-range` for any other gap. */
  reason: "breaking" | "outside-range";
  /** The command that moves it. */
  command: string;
}

/** One declaration this command does not touch. */
export interface PackageLeftAlone {
  name: string;
  manifest: string;
  /** The spec as written. */
  spec: string;
  reason: LeftAloneReason;
}

/** The whole plan. */
export interface PackagePlan {
  moves: PackageMove[];
  held: PackageHeld[];
  leftAlone: PackageLeftAlone[];
}

/** What the pure planner is handed. */
export interface PlanInput {
  /** Every declaration, from {@link declaredSpecs}. */
  specs: readonly DeclaredSpec[];
  /** The packument of every managed, unlinked package among them. */
  packuments: ReadonlyMap<string, Packument>;
  /** `--latest`: move held entries to `latest`. */
  latest: boolean;
  /** Whether a declaration's package is a checkout linked in. */
  isLinked: (spec: DeclaredSpec) => boolean;
  /** The version installed where a declaration's manifest resolves it. */
  installed: (spec: DeclaredSpec) => string | null;
}

/** Decide every declaration. Pure: every fact it reads is handed in. */
export function planPackages(input: PlanInput): PackagePlan {
  const plan: PackagePlan = { moves: [], held: [], leftAlone: [] };
  for (const spec of input.specs) {
    const range = parseRange(spec.spec);
    if (!range) {
      plan.leftAlone.push({
        name: spec.name,
        manifest: spec.manifest,
        spec: spec.spec,
        reason: "not-a-registry-range",
      });
      continue;
    }
    if (input.isLinked(spec)) {
      plan.leftAlone.push({ name: spec.name, manifest: spec.manifest, spec: spec.spec, reason: "linked" });
      continue;
    }
    const packument = input.packuments.get(spec.name);
    if (!packument) continue; // the caller refuses a missing packument before planning; nothing to decide here
    const latest = packument["dist-tags"].latest;
    const move = (target: string) =>
      plan.moves.push({
        name: spec.name,
        manifest: spec.manifest,
        field: spec.field,
        from: spec.spec,
        to: rewriteRange(range, target),
        target,
      });
    // Held only when latest is *ahead* of the floor. A range declared past latest is the adopter's own,
    // and "move back to latest" is not a thing anyone asked for.
    const beyond = !admits(range, latest) && compareVersions(latest, range.floor) > 0;
    if (beyond && input.latest) {
      move(latest);
      continue;
    }
    const target = newestAdmitted(range, candidateVersions({ latest, versions: packument.versions }));
    if (target !== null && compareVersions(target, range.floor) > 0) move(target);
    if (beyond) {
      plan.held.push({
        name: spec.name,
        manifest: spec.manifest,
        range: spec.spec,
        installed: input.installed(spec),
        latest,
        reason: crossesBreakingBoundary(range.floor, latest) ? "breaking" : "outside-range",
        command: PACKAGES_LATEST_COMMAND,
      });
    }
  }
  return plan;
}

/** The version of `name` a manifest's directory resolves, walking up the `node_modules` chain. */
export async function installedVersionFrom(dir: string, name: string): Promise<string | null> {
  const home = packageDirFrom(dir, name);
  if (!home) return null;
  try {
    const version = (JSON.parse(await readFile(join(home, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** A plan read from the project and the registry, or the registry's refusal to answer. */
export type PackagePlanRead =
  | {
      state: "read";
      specs: DeclaredSpec[];
      plan: PackagePlan;
      /** Every packument fetched, by name. The template report reads the ui-react and cli ones. */
      packuments: Map<string, Packument>;
    }
  | {
      state: "unavailable";
      specs: DeclaredSpec[];
      /** What was decided without the registry. Nothing moves or is held when it did not answer. */
      plan: PackagePlan;
    };

/**
 * Read every declaration, fetch each managed package's packument once, and plan.
 *
 * **One packument that fails makes the whole step unavailable.** A plan built from the packages that
 * answered would move some of a fixed group and not the rest, and a report that looked complete.
 */
export async function readPackagePlan(options: {
  projectDir: string;
  latest: boolean;
  fetch?: RegistryFetch;
}): Promise<PackagePlanRead> {
  const specs = await declaredSpecs(options.projectDir);
  const dirOf = (spec: DeclaredSpec) => join(options.projectDir, dirname(spec.manifest));
  // **Judged at the project root, the way every other caller of `alreadyProvided` judges it.** Asked of a
  // Worker's directory it is wrong under bun's isolated layout: `apps/<w>/node_modules/@pithy-sh/<pkg>` is a
  // link into `<root>/node_modules/.bun`, which is outside the Worker's own `node_modules`, so every package
  // bun installed there read as a checkout and was left alone. Scaffolds are workspaces; a checkout linked
  // in is linked at the root.
  const linked = new Set<DeclaredSpec>();
  for (const spec of specs) {
    if (parseRange(spec.spec) === null) continue;
    if (await alreadyProvided(options.projectDir, spec.name)) linked.add(spec);
  }
  const installed = new Map<DeclaredSpec, string | null>();
  for (const spec of specs) installed.set(spec, await installedVersionFrom(dirOf(spec), spec.name));

  const names = [
    ...new Set(specs.filter((spec) => parseRange(spec.spec) !== null && !linked.has(spec)).map((s) => s.name)),
  ];
  const fetched = await Promise.all(
    names.map(
      async (name) => [name, await fetchPackument(name, options.fetch ? { fetch: options.fetch } : {})] as const,
    ),
  );
  const input = (packuments: Map<string, Packument>): PlanInput => ({
    specs,
    packuments,
    latest: options.latest,
    isLinked: (spec) => linked.has(spec),
    installed: (spec) => installed.get(spec) ?? null,
  });
  if (fetched.some(([, doc]) => doc === null)) {
    // Only what needs no registry: the entries left alone.
    const plan = planPackages(input(new Map()));
    return { state: "unavailable", specs, plan: { moves: [], held: [], leftAlone: plan.leftAlone } };
  }
  const packuments = new Map(fetched.map(([name, doc]) => [name, doc as Packument]));
  return { state: "read", specs, plan: planPackages(input(packuments)), packuments };
}
