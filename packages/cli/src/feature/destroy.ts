// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { partialWriteReport } from "@pithy-sh/secrets/src/cli/partialWrite";
import type { CliAuditEmit } from "../audit/cliAudit";
import type { ProvisionWorker } from "../provision/environment";
import type { FeatureIndexes, ResourceProvisioners, WorkerScripts, WorkflowDefinitions } from "../provision/resources";
import type { SecretsStore } from "../provision/store";
import { devConfigPath } from "./devConfig";
import { manifestPath } from "./manifest";
import { freePortBlock, portsRegistryPath, resolveMainRepoRoot } from "./ports";
import { type DeprovisionedResource, deletedBeforeFailure, deprovisionFeature } from "./provision";
import { defaultGit, type FeatureRecord, featureNames, type GitRunner, teardownWorktree } from "./worktree";

/**
 * `pithy feature destroy` — the teardown half, run from within the worktree. It reverses both remote and
 * local, in order: delete the feature's Worker scripts and Cloudflare resources (the manifest's record,
 * then every name recomputed from the identity), free the feature's port block, and finally prune the
 * worktree the Linux-safe way. Every step is idempotent, so a
 * partial-failed provision or a half-torn-down feature still tears down to zero, exiting 0. It is exactly
 * what the merge-to-main CI job runs headlessly.
 */

/** The structured outcome of `pithy feature destroy` — the `--json` payload and the human summary source. */
export interface DestroyReport {
  /** The command that produced the report. */
  command: "feature.destroy";
  /**
   * Every Worker script and Cloudflare resource deleted (manifest + reconcile). Empty when nothing remained
   * or remote was skipped.
   */
  deleted: DeprovisionedResource[];
  /** Whether the remote teardown ran (false when no provisioners were available, e.g. no CF credentials). */
  remote: boolean;
  /**
   * Whether the feature's port block was freed — **whether there was one**, since #660.
   *
   * It was the literal `true`, which is a claim about a registry nobody had read. A CI runner holds no
   * block at all (the registry is machine-local and the machine is a fresh container), so the honest
   * answer there is `false` and the run is still a success: nothing local was there to tear down.
   */
  portsFreed: boolean;
  /**
   * The feature branch this run was about, canonically spelled (#660).
   *
   * Published because `--branch` is an *input* that the parse may correct: `feature/012-x` and
   * `feature/12-x` are one feature, so both arrive here as `feature/12-x`. A caller that logs what it
   * asked for and a report that says what was torn down should not be two different strings.
   */
  branch: string;
  /** Whether a registered worktree was pruned. */
  worktreePruned: boolean;
  /** Whether the feature branch was deleted (only when merged). */
  branchDeleted: boolean;
  /**
   * **Whether the feature's own manifest was read — #660.**
   *
   * The manifest is the record of what `provision --feature` actually created, and it is the only way to
   * reach a resource whose binding the branch has since dropped. It lives in the feature's worktree,
   * which is machine-local: a runner tearing down a merged pull request has none, so it deletes by
   * recomputed name alone.
   *
   * **Read, not reachable.** This answered "the directory exists", and a bare `.worktrees/<issue>-<slug>`
   * left behind by an earlier teardown satisfies that while holding no record — so a narrower teardown
   * reported that it had consulted one. It comes from `readManifest` now: `false` when no remote half
   * ran, when the worktree is not on this machine, and when the directory is there and the file is not.
   *
   * The narrowing is published rather than left to be inferred from a shorter list. The command that must
   * never "leak while reporting success" cannot answer a narrower question in silence.
   */
  manifestRead: boolean;
  /** Where that manifest is — read, or merely named when {@link manifestRead} is false. */
  manifestPath: string;
}

/** A carried value arrives as `unknown`; this is the narrowing, never a cast. */
function isDestroyReport(value: unknown): value is DestroyReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DestroyReport>;
  return candidate.command === "feature.destroy" && Array.isArray(candidate.deleted);
}

/**
 * **Where the record of a teardown that failed partway rides out of it (#380).**
 *
 * A teardown destroys infrastructure and reports what it destroyed. Until now a throw from the remote
 * half took that report with it, so an operator whose token expired on the fourth of five deletes was
 * told only that it failed — and the three databases that were already gone were gone unrecorded. The
 * report is the whole product of this command, so it survives the failure the same way a partial mint
 * does (#324).
 */
const deprovisionReport = partialWriteReport<DestroyReport>("pithy.cli.destroyReport", isDestroyReport);

/** What a failed {@link destroyFeature} run tore down before it failed, or `undefined` for any other throw. */
export function destroyedBeforeFailure(error: unknown): DestroyReport | undefined {
  return deprovisionReport.read(error);
}

/**
 * The account seams remote teardown deletes through — both, or neither (#592).
 *
 * One pair rather than two optional fields, because the failure this issue was is a teardown that ran
 * against the account and skipped a kind. Neither is "remote teardown skipped", which the report says;
 * one without the other is not expressible.
 */
export type RemoteTeardown =
  | {
      /** The provisioners to delete Cloudflare resources through. */
      provisioners: ResourceProvisioners;
      /** The account's Worker scripts, confirmed then deleted by name. */
      scripts: WorkerScripts;
      /** The account's Workflow definitions — every one a feature script hosts is deleted by name (#643). */
      workflows: WorkflowDefinitions;
      /** The feature's own Vectorize indexes, deleted by recomputed name (#643). */
      indexes?: FeatureIndexes;
    }
  | {
      /** Absent: remote teardown is skipped (e.g. `--local-only`, or no CF credentials). */
      provisioners?: undefined;
      /** Absent with `provisioners`. */
      scripts?: undefined;
      /** Absent with `provisioners`. */
      workflows?: undefined;
      /** Absent with `provisioners`. */
      indexes?: undefined;
    };

/** Options for {@link destroyFeature}. */
export type DestroyFeatureOptions = DestroyFeatureBaseOptions & RemoteTeardown;

/** Everything {@link destroyFeature} takes beside the account seams. */
export interface DestroyFeatureBaseOptions {
  /** The worktree root — where the manifest lives and the branch is checked out. */
  projectDir: string;
  /** The feature identity — project/issue/slug — for recomputing resource names and the branch name. */
  identity: FeatureIdentity;
  /**
   * Every capability the feature spans — the union of its Workers' own configs, the same one `provision`
   * derived resource names from. The remote reconcile recomputes those exact names from it.
   */
  capabilities: Capability[];
  /**
   * The project's Workers as the branch has them — what the scripts of a feature deployed before scripts
   * were recorded are recomputed from. Empty when they cannot be known.
   */
  workers: readonly Pick<ProvisionWorker, "name" | "dir">[];
  /** The environment being torn down. Recorded on each audit event. */
  env: string;
  /**
   * The account's Secrets Store, when one is reachable. Teardown removes the entries this feature
   * created; a store entry left behind is a live credential in a flat namespace with nothing pointing
   * at it.
   */
  store?: SecretsStore;
  /** Audit emitter, so every deletion leaves a record. Defaults to recording nothing. */
  audit?: CliAuditEmit;
  /** git runner seam. */
  git?: GitRunner;
  /** Override the registry file (tests inject; a real run resolves `<config>/dev-ports.json`). */
  registryPath?: string;
  /** Override the main checkout root, the registry's key (tests inject; a real run resolves it via git-common-dir). */
  root?: string;
  /**
   * The feature's own worktree, when this run is not standing in it — `pithy feature destroy --branch`
   * (#660). Defaults to `{ dir: projectDir, present: true }`, which is the inferred path exactly as before.
   *
   * **Two things are the feature's own rather than the cwd's, and both are here.** Its `.pithy-feature.json`
   * is the record teardown deletes by exact id — reading the *checkout's* copy tears down by recomputed
   * name alone and silently leaves behind anything the branch no longer declares. And its
   * `.dev.config.json` is a *worktree's* port claim: removing the one in a checkout that is not this
   * feature's deletes a live reservation belonging to a different branch.
   *
   * Everything else in the local half is addressed by identity rather than by cwd — the registry key is
   * `feature/<issue>-<slug>`, and the worktree is wherever `featureNames` puts it.
   */
  record?: FeatureRecord;
  /**
   * The issue as it was spelled, when that differs from the canonical one (#660 review).
   *
   * Every **name** this teardown composes comes from the canonical issue, because that is what
   * provisioning composed them from. Three local things may not: a feature created before the issue was
   * canonicalised has `.worktrees/012-x`, a `feature/012-x` branch and a `feature/012-x` port key, and
   * canonicalising on its own makes all three invisible while the run reports nothing local to tear
   * down. Canonical is tried first, always; this is the second thing tried, and only when the first
   * found nothing.
   */
  spelled?: string;
}

/**
 * Tear a feature down. Delete its Worker scripts and Cloudflare resources (manifest record, then
 * exact-name reconcile) when the account seams are available, free its port block, and prune its
 * worktree + branch — in that order.
 * Idempotent end to end: already-gone resources, an unallocated port block, and an absent worktree are all
 * clean no-ops, so re-running (or running on a never-provisioned feature) exits without error.
 */
export async function destroyFeature(options: DestroyFeatureOptions): Promise<DestroyReport> {
  const git = options.git ?? defaultGit;
  // The inferred path's answer, unchanged: this run is standing in the feature (#660).
  const record: FeatureRecord = options.record ?? { dir: options.projectDir, present: true };
  const manifest = manifestPath(record.dir);

  let deleted: DeprovisionedResource[] = [];
  // False until a manifest is actually read. A remote half that never ran read nothing, which is the
  // honest answer for `--local-only` and for a run with no credentials (#660 review).
  let manifestRead = false;
  const remote = options.provisioners !== undefined;
  if (options.provisioners) {
    try {
      const report = await deprovisionFeature({
        /*
          Two directories, because there are two questions and `--branch` answers them differently (#660).

          **The manifest is the feature's own, always.** It records the resources `provision --feature`
          created, by id, and it is the only way to reach one whose binding the branch has since dropped.
          The checkout's copy is a different feature's record or no record at all, so it is the feature's
          worktree or nothing — and nothing is reported, never passed over.

          **The configs are read from wherever the feature's code is.** That is its worktree when this
          machine has one. On a runner it is this checkout, and the rule that makes that sound is stated
          in `docs/commands/feature.md`: check out `refs/pull/<n>/head`, which carries the feature's own
          `apps/<name>/pithy.config.ts`. A runner left on the trunk reconciles against the trunk's
          bindings, which is the narrowing the manifest line above is reported for.
        */
        manifestDir: record.present ? record.dir : null,
        projectDir: record.present ? record.dir : options.projectDir,
        identity: options.identity,
        capabilities: options.capabilities,
        env: options.env,
        provisioners: options.provisioners,
        scripts: options.scripts,
        workflows: options.workflows,
        ...(options.indexes ? { indexes: options.indexes } : {}),
        workers: options.workers,
        ...(options.store !== undefined ? { store: options.store } : {}),
        ...(options.audit !== undefined ? { audit: options.audit } : {}),
      });
      deleted = report.deleted;
      manifestRead = report.manifest;
    } catch (error) {
      // What the remote half destroyed before it failed, moved onto this report and carried on again so
      // the command can print it beside the failure (#380). The local half below deliberately does not
      // run: pruning the worktree would remove the checkout the re-run has to happen from, and the
      // feature manifest that says what is left to delete lives in it.
      throw deprovisionReport.carry(error, {
        command: "feature.destroy",
        deleted: deletedBeforeFailure(error),
        remote,
        portsFreed: false,
        branch: `feature/${options.identity.issue}-${options.identity.slug}`,
        worktreePruned: false,
        branchDeleted: false,
        manifestRead,
        manifestPath: manifest,
      });
    }
  }

  const registryPath = options.registryPath ?? portsRegistryPath();
  // The same git-common-dir derivation the registry key was always freed by — `projectDir` is the
  // worktree (or, under `--branch`, the checkout it belongs to), and this is the main checkout. Pinned in
  // `ports.test.ts` against the `git worktree list` derivation `feature create` reserves under, because a
  // key freed under a root create never wrote frees nothing at all (#435). It would also have reported
  // `portsFreed: true` doing it; that half is `freePortBlock`'s answer now (#660).
  const root = options.root ?? (await resolveMainRepoRoot(options.projectDir));
  const canonical = featureNames(options.identity.issue, options.identity.slug, root).branch;
  // The spelling a feature created before the issue was canonicalised filed itself under, or none.
  const padded =
    options.spelled !== undefined && options.spelled !== options.identity.issue
      ? featureNames(options.spelled, options.identity.slug, root).branch
      : null;
  // Drop the feature's pinned ports **before** freeing its registry key, and in that order. Teardown leaves
  // the worktree's files on disk by design (recursive deletion is what we must never do on Linux), and
  // `.dev.config.json` is a port claim: every later `feature create`/`sync` rebuilds the registry from the
  // pinned blocks it finds under `.worktrees`, so a surviving one hands this branch its block straight back —
  // permanently, to a feature that no longer exists. Removing one file is not a recursive delete. If the run
  // dies between the two steps, the registry is the only claim left and a re-run clears it; the reverse order
  // would leave the stale claim to be reclaimed.
  // The feature's own pinned ports, and only its. On a machine that has no such worktree there is no file
  // and nothing to do; in a checkout that is not this feature's, the file belongs to another branch.
  if (record.present) await rm(devConfigPath(record.dir), { force: true });
  // Canonical first; the padded spelling only when the canonical key held nothing. Never both blindly:
  // a free that reports `true` having dropped somebody else's key is the shape #435 was.
  let portsFreed = await freePortBlock({ registryPath, root, branch: canonical });
  let branch = canonical;
  if (!portsFreed && padded !== null) {
    portsFreed = await freePortBlock({ registryPath, root, branch: padded });
    if (portsFreed) branch = padded;
  }

  // Same order for the worktree and the branch. `teardownWorktree` is a clean no-op when neither is
  // there, so a canonical run that found nothing may try the spelling it was given, and a feature
  // created after this change never reaches the second call.
  let teardown = await teardownWorktree({ issue: options.identity.issue, slug: options.identity.slug, git });
  if (!teardown.pruned && !teardown.branchDeleted && padded !== null) {
    const fallback = await teardownWorktree({ issue: options.spelled as string, slug: options.identity.slug, git });
    if (fallback.pruned || fallback.branchDeleted) {
      teardown = fallback;
      branch = padded;
    }
  }

  return {
    command: "feature.destroy",
    deleted,
    remote,
    portsFreed,
    branch,
    worktreePruned: teardown.pruned,
    branchDeleted: teardown.branchDeleted,
    manifestRead,
    manifestPath: manifest,
  };
}
