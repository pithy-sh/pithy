// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { loadProject, requireProjectName } from "../project/config";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
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
  const capabilities = projectCapabilities(await resolveWorkers({ projectDir }));
  return { identity: { project, issue, slug }, capabilities };
}
