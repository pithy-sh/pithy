// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ReleaseRecord } from "./records";

/**
 * The bootstrap release — the one that cannot run in CI, and the only one that ever will not.
 *
 * npm configures trusted publishing **per package, on a package that already exists**. A package that
 * has never been published has no settings page to attach a publisher to, and `npm trust` refuses for
 * the same reason. So the first version of each package has to be published some other way, once, and
 * `.github/workflows/release.yml` takes over permanently afterwards.
 *
 * This is that once. It runs the identical sequence the workflow runs — snapshot, version, build,
 * publish, tag, push — against `npm login`'s two-hour session rather than a stored token, so nothing
 * outlives the afternoon and there is no credential to rotate or leak.
 *
 * ## What is different from CI, and why
 *
 * **No provenance.** It is generated from a CI build's OIDC identity and a laptop has none. The
 * publish is run with `NPM_CONFIG_PROVENANCE=false`, because npm otherwise fails the publish rather
 * than skipping the attestation. `0.1.0` carries none; every release after it does.
 *
 * **A confirmation.** A published version is permanent — npm allows unpublishing for 72 hours and then
 * never lets the name-and-version be reused. So the plan is printed and the run stops for a yes.
 *
 * **A dry run that puts the tree back.** `changeset version` rewrites every manifest and writes the
 * CHANGELOGs; `--dry-run` does all of that, prints what would ship, and then restores. The restore is
 * `git restore -- .` plus deleting exactly the changelogs this run created — which is only safe
 * because {@link preflight} refuses to start on a tree with anything uncommitted in it.
 */

/** What {@link preflight} needs to know about the checkout, gathered by the entry script. */
export interface PreflightInputs {
  /** The current branch. */
  branch: string;
  /**
   * `git status --porcelain` lines, or `null` when git could not be asked.
   *
   * **`null` is its own refusal, not an empty tree.** This is the one input guarding an irreversible
   * operation — the dry run restores the worktree — and it was the only one that failed *open*: the
   * entry script's `capture()` returns `null` on any non-zero exit, and reading that as "no lines"
   * is indistinguishable from "nothing is dirty". A held `.git/index.lock`, an interrupted rebase or
   * a permissions error on `.git` would have reported a clean tree and destroyed uncommitted work.
   */
  dirty: string[] | null;
  /** Whether `git fetch` reached the remote. False is its own refusal — see {@link preflight}. */
  fetched: boolean;
  /** How many commits `origin/main` is ahead. Meaningless, and unread, when `fetched` is false. */
  behind: number;
  /** Who `npm whoami` reports, or null when nobody is logged in. */
  npmUser: string | null;
  /** The GitHub token `changeset version` needs, or null. */
  githubToken: string | null;
  /** How many changesets are waiting. */
  changesets: number;
}

/**
 * Everything wrong with this checkout, as sentences.
 *
 * **Every problem at once.** A release is run rarely and irreversibly, and finding the six things wrong
 * one run at a time is how somebody ends up publishing from the wrong branch on the seventh.
 *
 * **A dry run is held to less, because it does less.** It publishes nothing and pushes nothing, so the
 * branch, the remote and an npm session are all irrelevant to it — and requiring them would block the
 * one command whose entire purpose is finding out what a release would do before committing to any of
 * it. What a dry run *does* need is the two things it shares with a real one: a token, because
 * `changeset version` will not run without it, and something to release. And it needs the clean tree
 * hardest of all, because it is the mode that restores.
 */
export function preflight(inputs: PreflightInputs, options: { publishing: boolean } = { publishing: true }): string[] {
  const problems: string[] = [];

  if (options.publishing && inputs.branch !== "main") {
    problems.push(`On branch ${inputs.branch}. A release is cut from main. Switch with \`git switch main\`.`);
  }

  // The dry run's restore is `git restore -- .`, which discards every uncommitted change in the tree.
  // Refusing here is what makes that safe rather than destructive — so an unanswerable question is a
  // refusal too, never an assumption that there was nothing to lose.
  if (inputs.dirty === null) {
    problems.push(
      "Could not read the working tree state. A release restores the tree, and that is only safe once nothing uncommitted is in it, so it will not start on an answer git did not give.",
    );
  } else if (inputs.dirty.length > 0) {
    problems.push(
      `The tree has uncommitted changes in ${inputs.dirty.length} files. Commit or stash them — a dry run restores the tree and would discard them.`,
    );
  }

  // An unreachable remote is not an up-to-date checkout. Left as "0 behind", an offline laptop reads
  // as current and publishes a tree that main has moved past.
  if (!options.publishing) {
    // Neither question is asked of a dry run: it publishes nothing, so a stale tree costs nothing.
  } else if (!inputs.fetched) {
    problems.push("Could not reach origin. A release cannot confirm this tree is current, so it will not start.");
  } else if (inputs.behind > 0) {
    problems.push(
      `${inputs.behind} commits behind origin/main. Pull first — releasing a stale tree publishes code nobody reviewed against what is on main.`,
    );
  }

  if (options.publishing && inputs.npmUser === null) {
    problems.push("Not logged in to npm. Run `npm login` — it issues a two-hour session, not a stored token.");
  }

  if (inputs.githubToken === null) {
    problems.push(
      "No GITHUB_TOKEN. `@changesets/changelog-github` attributes every changeset through the GitHub API and `changeset version` exits 1 without one. Run with `GITHUB_TOKEN=$(gh auth token)`.",
    );
  }

  if (inputs.changesets === 0) {
    problems.push("There are no changesets, so there is nothing to release.");
  }

  return problems;
}

/** The plan, as the operator reads it before saying yes. One line per package, then a count. */
export function describePlan(records: ReleaseRecord[]): string {
  if (records.length === 0) return "Nothing would ship. No package's version changed.";

  const width = Math.max(...records.map((record) => record.package.length));
  const lines = records.map((record) => {
    const name = record.package.padEnd(width);
    const flag = record.security ? "  [security]" : "";
    return `  ${name}  ${record.version}  (${record.bump})${flag}`;
  });

  const flagged = records.filter((record) => record.security).length;
  const majors = records.filter((record) => record.bump === "major").length;
  const summary = [
    `${records.length} packages`,
    `${flagged} security-relevant`,
    ...(majors === 0 ? [] : [`${majors} major`]),
  ].join(", ");

  return `${lines.join("\n")}\n\n${summary}.`;
}

/**
 * The changelogs this run created, and only those.
 *
 * A set difference rather than a glob: deleting a `CHANGELOG.md` that was already committed is not
 * something the tree can be restored from, and a released package has one.
 */
export function generatedChangelogs(before: string[], after: string[]): string[] {
  const existed = new Set(before);
  return after.filter((path) => !existed.has(path));
}
