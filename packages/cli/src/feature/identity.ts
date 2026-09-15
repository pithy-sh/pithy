// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { resolveWorkerSetFor, resolveWorkersFor } from "../project/composeFor";
import { loadProject, requireProjectName } from "../project/config";
import { type CapabilitySet, capabilitySetOf, projectCapabilities, type WorkerSet } from "../project/workerScope";
import { defaultGit, type GitRunner } from "./worktree";

/** A feature's identity as read from its branch: the issue number, the slug, and the full branch name. */
export interface FeatureBranchIdentity {
  /** The issue number as a string, e.g. "69". */
  issue: string;
  /** The kebab-case slug, e.g. "media-cli". */
  slug: string;
  /** The full branch, `feature/<issue>-<slug>`. */
  branch: string;
}

/** `feature/<digits>-<kebab-slug>` — the branch shape `pithy feature` owns. */
const FEATURE_BRANCH = /^feature\/(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Parse a branch name into a feature identity, or null when it is not a `feature/<issue>-<slug>` branch. */
export function parseFeatureBranch(branch: string): FeatureBranchIdentity | null {
  const match = FEATURE_BRANCH.exec(branch);
  if (!match) return null;
  const [, issue, slug] = match;
  if (!issue || !slug) return null;
  return { issue, slug, branch };
}

/**
 * Derive the feature identity from the current git branch — the source of truth for `provision` and
 * `destroy`, which take no positional args and run from within the worktree. Fails with an actionable
 * error when the checkout is not on a `feature/<issue>-<slug>` branch.
 */
export async function deriveIdentityFromBranch(
  cwd: string,
  git: GitRunner = defaultGit,
): Promise<FeatureBranchIdentity> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const identity = parseFeatureBranch(branch);
  if (!identity) {
    throw new ValidationError({
      message: `Not on a feature branch (${branch}).`,
      action: "Run this from inside a feature worktree, or create one with pithy feature create.",
    });
  }
  return identity;
}

/**
 * Resolve the feature identity (project + issue + slug) from the current branch and the root config, plus
 * the capabilities the feature spans.
 *
 * The two come from different places, deliberately. **Identity** is project-wide policy and lives in the
 * root `pithy.config.ts`. **Capabilities** are per Worker (`apps/<name>/pithy.config.ts`), so they are
 * unioned: a feature provisions one resource per binding name for the whole feature — two Workers that both
 * declare `DB` deliberately share one database — and the migrate/seed it runs must cover every table any
 * Worker owns.
 *
 * **Reached only once an operator has said `--feature` or run `pithy feature`.** The branch names a
 * feature; it never decides that this run is one.
 */
export async function branchIdentity(
  projectDir: string,
): Promise<{ identity: FeatureIdentity; capabilities: Capability[] }> {
  const { issue, slug } = await deriveIdentityFromBranch(projectDir);
  const config = await loadProject(projectDir);
  // Never guessed: this name is the first segment of every resource name, and the only key teardown has
  // to find them again. A fallback that differs between a worktree and a clone would make destroy
  // recompute names that match nothing, delete nothing, and exit 0 — a silent leak.
  const project = requireProjectName(config);
  // Composed for the feature environment, which is the one these capabilities are provisioned into (#595).
  const capabilities = projectCapabilities(await resolveWorkersFor(FEATURE_ENVIRONMENT, { projectDir }));
  return { identity: { project, issue, slug }, capabilities };
}

/**
 * The capabilities a feature's teardown deletes by — **composed for the environment {@link branchIdentity}
 * composed them for**, or why that set is unknowable (#455).
 *
 * Teardown reconciles resources by recomputed name and removes Secrets Store entries by recomputed name,
 * both from this set, and the manifest records neither the entries nor a resource created before it was
 * written. So a capability composed for `feature` alone and not here is one whose resources and live
 * credentials outlive a `destroy` that exits 0 (#595). The set differs from provision's in one way only,
 * and on purpose: an unknowable one is reported rather than thrown, so `--local-only` can still run.
 */
export async function featureCapabilitySet(projectDir: string): Promise<CapabilitySet> {
  return capabilitySetOf(await featureWorkerSet(projectDir));
}

/**
 * The Workers a feature's teardown works from, composed for `feature` — one resolution for both halves.
 *
 * `destroy` needs the Workers themselves as well as their capabilities: the capabilities name the
 * resources and the Secrets Store entries, and the Workers name the scripts (#592). Resolving them twice
 * would let the two disagree, and resolving either unstamped would miss a capability a config composes
 * only for deployed environments (#595). So this is the one resolution, and {@link featureCapabilitySet}
 * is derived from it rather than beside it.
 */
export function featureWorkerSet(projectDir: string): Promise<WorkerSet> {
  return resolveWorkerSetFor(FEATURE_ENVIRONMENT, { projectDir });
}

/**
 * The feature's identity without loading a single Worker config — `#454`.
 *
 * {@link branchIdentity} answers identity *and* capabilities, and the capabilities come from every
 * `apps/<name>/pithy.config.ts`. That is right for `provision`, which cannot act without knowing what it
 * is acting on. It is wrong for `destroy`, whose local half — free the port block, prune the worktree —
 * needs none of it, and which is most needed in exactly the state where a Worker config will not load.
 *
 * A `feature create` that failed partway used to leave a worktree whose config threw, and `destroy` threw
 * on the same config before it reached the teardown. The one command that removes the worktree and frees
 * the port block was unavailable in the state it exists for, and the block leaked: the registry kept a
 * branch that no longer existed, and the way out was editing `<config>/dev-ports.json` by hand.
 *
 * The project name still comes from the **root** config, which is project identity and holds no
 * capabilities — so it loads when a Worker's does not, and teardown keeps deriving resource names the same
 * way it always did rather than guessing them.
 */
export async function branchIdentityWithoutWorkers(projectDir: string): Promise<FeatureIdentity> {
  const { issue, slug } = await deriveIdentityFromBranch(projectDir);
  const project = requireProjectName(await loadProject(projectDir));
  return { project, issue, slug };
}
