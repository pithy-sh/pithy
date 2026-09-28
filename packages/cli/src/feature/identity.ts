// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { canonicalIssue, type FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { MAX_ISSUE_DIGITS } from "@pithy-sh/core/src/naming/limits";
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

/**
 * `feature/<digits>-<kebab-slug>` — the branch shape `pithy feature` owns.
 *
 * The digit bound is `MAX_ISSUE_DIGITS`, the same term {@link canonicalIssue}'s own guard is built from,
 * so a branch this accepts is one the naming layer accepts too. Stated here rather than left to throw
 * later: `feature/1234567890-x` is not a branch this command owns, and saying so at the parse is one
 * refusal instead of a refusal several account lookups in.
 */
const FEATURE_BRANCH = new RegExp(`^feature/([0-9]{1,${MAX_ISSUE_DIGITS}})-([a-z0-9]+(?:-[a-z0-9]+)*)$`);

/**
 * Parse a branch name into a feature identity, or null when it is not a `feature/<issue>-<slug>` branch.
 *
 * **The issue is canonical, and so is the branch it reports (#660).** `feature/012-x` and `feature/12-x`
 * are one feature — {@link canonicalIssue} has settled that for resource *names* since #643, because
 * `f012` and `f12` would otherwise collide on the rate-limit namespaces every feature shares. The branch
 * did not go through it, so teardown's remote half addressed feature 12 while its local half looked for a
 * `feature/012-x` registry key and a `.worktrees/012-x` directory: one command, two features, and the
 * half that leaks is the quiet one. Both halves read this, so both read one string.
 */
export function parseFeatureBranch(branch: string): FeatureBranchIdentity | null {
  const match = FEATURE_BRANCH.exec(branch);
  if (!match) return null;
  const [, digits, slug] = match;
  if (!digits || !slug) return null;
  const issue = canonicalIssue(digits);
  return { issue, slug, branch: `feature/${issue}-${slug}` };
}

/** Where a branch name came from: read off the checkout, or handed to the CLI as `--branch`. */
export type BranchSource = "checkout" | "flag";

/**
 * The refusal a name that is not `feature/<issue>-<slug>` earns, per source — one table, two rows.
 *
 * Two `throw` sites is how the two paths would come to disagree about what a feature is called, or about
 * how they say a name is not one. Only the preposition and the remedy vary, and only because only those
 * are about *where the name came from*: the inferred path read a checkout and the operator has to move,
 * while `--branch` was handed a string and the operator has to fix it. The diagnosis itself is one
 * sentence with one subject — the name — because there is one parser above it.
 */
const NOT_A_FEATURE_BRANCH: Record<BranchSource, { message: (branch: string) => string; action: string }> = {
  checkout: {
    message: (branch) => `Not on a feature branch (${branch}).`,
    action: "Run this from inside a feature worktree, or create one with pithy feature create.",
  },
  flag: {
    message: (branch) => `Not a feature branch (${branch}).`,
    action: "Pass --branch feature/<issue>-<slug>, e.g. --branch feature/69-media-cli.",
  },
};

/**
 * A branch name's feature identity, or the refusal — {@link parseFeatureBranch} plus the `null` case,
 * which is the layer every caller that cannot proceed without an identity wants.
 *
 * **One gate for both paths (#660).** `pithy feature destroy --branch <name>` names the feature a merged
 * pull request's runner cannot infer, and it reaches the identity through this, exactly as
 * {@link deriveIdentityFromBranch} does. A second derivation beside this one is a second opinion about
 * what `feature/12-x` means, and the two would be found to differ by whichever resource was left behind.
 *
 * **Before anything is deleted.** Teardown calls this first, so a malformed name costs nothing.
 */
export function requireFeatureBranch(branch: string, source: BranchSource): FeatureBranchIdentity {
  const identity = parseFeatureBranch(branch);
  if (identity) return identity;
  const refusal = NOT_A_FEATURE_BRANCH[source];
  throw new ValidationError({ message: refusal.message(branch), action: refusal.action });
}

/**
 * Derive the feature identity from the current git branch — the source of truth for `provision`, and for
 * a `destroy` that was not told which feature to tear down. Fails with an actionable error when the
 * checkout is not on a `feature/<issue>-<slug>` branch.
 *
 * **A checkout is not the only way to know (#660).** `destroy` also takes `--branch`, for the caller that
 * has no worktree and no branch — a runner on `pull_request: closed`, where the branch is already deleted
 * and `refs/pull/<n>/head` is detached. That path goes through {@link requireFeatureBranch} too.
 */
export async function deriveIdentityFromBranch(
  cwd: string,
  git: GitRunner = defaultGit,
): Promise<FeatureBranchIdentity> {
  return requireFeatureBranch(await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd), "checkout");
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
 *
 * **`branch` names the feature instead of inferring it — `#660`.** `pithy feature destroy --branch` is for
 * the caller that has neither a worktree nor a branch, which is every merged pull request: the branch is
 * deleted and `refs/pull/<n>/head` checks out detached, so `--abbrev-ref HEAD` answers `HEAD`. With a name
 * in hand the checkout's branch is **not read at all** — the git seam below is never reached — and the
 * name goes through {@link requireFeatureBranch}, the parser the inferred path uses.
 *
 * **The project is the checkout's either way**, which is what keeps `--branch` from reaching another
 * project's resources: it names a feature *of this project*, and every resource name teardown recomputes
 * starts with the name this repository states.
 */
export async function branchIdentityWithoutWorkers(
  projectDir: string,
  options: { branch?: string | undefined; git?: GitRunner | undefined } = {},
): Promise<FeatureIdentity> {
  // First, and before the config is even opened: a malformed name costs nothing, which is what "refused
  // before anything is deleted" means on a command whose next step deletes infrastructure.
  const { issue, slug } =
    options.branch === undefined
      ? await deriveIdentityFromBranch(projectDir, options.git)
      : requireFeatureBranch(options.branch, "flag");
  const project = requireProjectName(await loadProject(projectDir));
  return { project, issue, slug };
}
