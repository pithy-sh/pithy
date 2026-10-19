// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArtifactsAccess } from "../access/access";
import type { ArtifactsRepoMetadata } from "../binding/artifacts";
import type { ArtifactsGrantRecord, ArtifactsRepoRecord } from "../data/records";
import type { GrantView, RepoDetail, RepoView } from "./responses";

/** A repository's row, as the caller may see it. Never carries the clone URL. */
export function repoView(repo: ArtifactsRepoRecord, access: ArtifactsAccess): RepoView {
  return {
    name: repo.name,
    displayName: repo.displayName,
    owner: { kind: repo.ownerKind, id: repo.ownerId },
    access,
    remoteAccess: repo.remoteAccess,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
  };
}

/**
 * A repository's row and what Cloudflare holds about it. **The clone URL is projected only where remote access is
 * on**: a repository no git client may reach has no address, and an address in a response is one somebody saves.
 */
export function repoDetail(
  repo: ArtifactsRepoRecord,
  access: ArtifactsAccess,
  info: ArtifactsRepoMetadata,
): RepoDetail {
  return {
    ...repoView(repo, access),
    description: info.description,
    defaultBranch: info.defaultBranch,
    lastPushAt: info.lastPushAt,
    readOnly: info.readOnly,
    ...(repo.remoteAccess ? { remote: info.remote } : {}),
  };
}

/** One grant row. */
export function grantView(grant: ArtifactsGrantRecord): GrantView {
  return { repo: grant.repo, userId: grant.userId, grant: grant.grant, updatedAt: grant.updatedAt.toISOString() };
}
