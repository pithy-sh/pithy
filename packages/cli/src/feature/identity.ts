// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { loadProject, requireProjectName } from "../project/config";
import { projectCapabilities, type ResolveOptions, resolveWorkers } from "../project/workerScope";
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

/**
 * The capabilities the feature spans, or `null` when a Worker config will not load — `#454`.
 *
 * `null` is not "none": it is *unknowable from here*, and the caller has to tell the two apart. An empty
 * array would let `destroy` report a clean remote teardown having deleted nothing, which is the silent
 * leak the command's own guard exists to prevent.
 */
export async function projectCapabilitiesOrNull(
  projectDir: string,
  seams: Omit<ResolveOptions, "projectDir"> = {},
): Promise<Capability[] | null> {
  try {
    return projectCapabilities(await resolveWorkers({ projectDir, ...seams }));
  } catch (error) {
    /*
      **A project with no Workers is `[]`, not unknowable.** `resolveWorkers` throws `core/not_found` for
      exactly that — an empty `apps/`, or one holding only dev-only processes with no `pithy.config.ts` —
      and nothing was ever named, so the reconcile pass has nothing to recompute and the manifest pass
      still runs. Swallowed into `null`, destroy refused with a diagnosis that was not true: *this
      project's Worker configuration will not load*, pointing at a file that does not exist, and a CI
      teardown failed on it.

      `core/not_found` also covers "no `pithy.config.ts` here", which is not this — but `destroy` cannot
      reach this call without the root config, because {@link branchIdentityWithoutWorkers} loads it
      first and throws its own error. Every other caller is welcome to the same reading: no Workers
      resolved means no capabilities, and a config that *threw* is the only thing nobody here can answer.
    */
    if (error instanceof PithyError && error.payload.code === "core/not_found") return [];
    return null;
  }
}
