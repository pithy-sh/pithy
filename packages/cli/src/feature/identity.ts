import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
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
