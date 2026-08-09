// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import type { CliAuditEmit } from "../audit/cliAudit";
import type { ResourceProvisioners } from "../provision/resources";
import type { SecretsStore } from "../provision/store";
import { devConfigPath } from "./devConfig";
import { freePortBlock, resolvePortsRegistryPath } from "./ports";
import { type DeprovisionedResource, deprovisionFeature } from "./provision";
import { defaultGit, type GitRunner, teardownWorktree } from "./worktree";

/**
 * `pithy feature destroy` — the teardown half, run from within the worktree. It reverses both remote and
 * local, in order: delete the manifest's Cloudflare resources then reconcile by prefix-scan, free the
 * feature's port block, and finally prune the worktree the Linux-safe way. Every step is idempotent, so a
 * partial-failed provision or a half-torn-down feature still tears down to zero, exiting 0. It is exactly
 * what the merge-to-main CI job runs headlessly.
 */

/** The structured outcome of `pithy feature destroy` — the `--json` payload and the human summary source. */
export interface DestroyReport {
  /** The command that produced the report. */
  command: "feature.destroy";
  /** Every Cloudflare resource deleted (manifest + reconcile). Empty when nothing remained or remote was skipped. */
  deleted: DeprovisionedResource[];
  /** Whether the remote teardown ran (false when no provisioners were available, e.g. no CF credentials). */
  remote: boolean;
  /** Whether the feature's port block was freed. */
  portsFreed: boolean;
  /** Whether a registered worktree was pruned. */
  worktreePruned: boolean;
  /** Whether the feature branch was deleted (only when merged). */
  branchDeleted: boolean;
}

/** Options for {@link destroyFeature}. */
export interface DestroyFeatureOptions {
  /** The worktree root — where the manifest lives and the branch is checked out. */
  projectDir: string;
  /** The feature identity — project/issue/slug — for recomputing resource names and the branch name. */
  identity: FeatureIdentity;
  /**
   * Every capability the feature spans — the union of its Workers' own configs, the same one `provision`
   * derived resource names from. The remote reconcile recomputes those exact names from it.
   */
  capabilities: Capability[];
  /** The environment being torn down. Recorded on each audit event. */
  env: string;
  /** The provisioners to delete through, or undefined to skip remote teardown (e.g. no CF credentials). */
  provisioners?: ResourceProvisioners;
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
  /** Override the resolved `.dev-ports.json` path (tests inject; a real run resolves it via git-common-dir). */
  registryPath?: string;
}

/**
 * Tear a feature down. Delete its Cloudflare resources (manifest ids, then prefix-scan reconcile) when
 * provisioners are available, free its port block, and prune its worktree + branch — in that order.
 * Idempotent end to end: already-gone resources, an unallocated port block, and an absent worktree are all
 * clean no-ops, so re-running (or running on a never-provisioned feature) exits without error.
 */
export async function destroyFeature(options: DestroyFeatureOptions): Promise<DestroyReport> {
  const git = options.git ?? defaultGit;

  let deleted: DeprovisionedResource[] = [];
  const remote = options.provisioners !== undefined;
  if (options.provisioners) {
    const report = await deprovisionFeature({
      projectDir: options.projectDir,
      identity: options.identity,
      capabilities: options.capabilities,
      env: options.env,
      provisioners: options.provisioners,
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.audit !== undefined ? { audit: options.audit } : {}),
    });
    deleted = report.deleted;
  }

  const registryPath = options.registryPath ?? (await resolvePortsRegistryPath(options.projectDir));
  const branch = `feature/${options.identity.issue}-${options.identity.slug}`;
  // Drop the feature's pinned ports **before** freeing its registry key, and in that order. Teardown leaves
  // the worktree's files on disk by design (recursive deletion is what we must never do on Linux), and
  // `.dev.config.json` is a port claim: every later `feature create`/`sync` rebuilds the registry from the
  // pinned blocks it finds under `.worktrees`, so a surviving one hands this branch its block straight back —
  // permanently, to a feature that no longer exists. Removing one file is not a recursive delete. If the run
  // dies between the two steps, the registry is the only claim left and a re-run clears it; the reverse order
  // would leave the stale claim to be reclaimed.
  await rm(devConfigPath(options.projectDir), { force: true });
  await freePortBlock({ registryPath, branch });

  const teardown = await teardownWorktree({ issue: options.identity.issue, slug: options.identity.slug, git });

  return {
    command: "feature.destroy",
    deleted,
    remote,
    portsFreed: true,
    worktreePruned: teardown.pruned,
    branchDeleted: teardown.branchDeleted,
  };
}
