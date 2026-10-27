// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArtifactsAccess } from "../access/access";
import type { ArtifactsRepoMetadata, ArtifactsTokenMetadata } from "../binding/artifacts";
import {
  type ArtifactsGrantRecord,
  type ArtifactsRepoRecord,
  type ArtifactsRevocationRecord,
  type ArtifactsTokenRecord,
  TOKEN_RECORD_RETENTION_MS,
} from "../data/records";
import type {
  AdminRepoDetail,
  AdminRepoView,
  AdminRevocation,
  AdminTokenView,
  CommitView,
  GrantView,
  RepoDetail,
  RepoView,
} from "./responses";

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

/**
 * A repository as a management client sees it. `info` is what Cloudflare answered for it, or `undefined` when it could
 * not, which costs the row its last push rather than costing the page.
 */
export function adminRepoView(repo: ArtifactsRepoRecord, info: ArtifactsRepoMetadata | undefined): AdminRepoView {
  return {
    name: repo.name,
    displayName: repo.displayName,
    owner: { kind: repo.ownerKind, id: repo.ownerId },
    remoteAccess: repo.remoteAccess,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
    ...(info ? { lastPushAt: info.lastPushAt } : {}),
  };
}

/** One repository with what Cloudflare holds. The clone URL only where remote access is on, as on the owner's read. */
export function adminRepoDetailView(repo: ArtifactsRepoRecord, info: ArtifactsRepoMetadata): AdminRepoDetail["repo"] {
  return {
    ...adminRepoView(repo, info),
    description: info.description,
    defaultBranch: info.defaultBranch,
    lastPushAt: info.lastPushAt,
    readOnly: info.readOnly,
    ...(repo.remoteAccess ? { remote: info.remote } : {}),
  };
}

/**
 * **One listed token, joined to the kit's record of it.** A record names the holder. No record means something other
 * than the kit minted it — Cloudflare's dashboard, a script — so it is `outside` and has no holder, never a guessed
 * one. Two exceptions are `unknown` rather than a claim the kit cannot back: a token created before this database
 * began recording (`began`, when `0002_tokens` ran, or `undefined` when that cannot be read), which the kit may well
 * have minted with no record, and a token that expired before the oldest record the kit still keeps, whose record may
 * have been pruned.
 */
export function adminTokenView(
  token: ArtifactsTokenMetadata,
  record: ArtifactsTokenRecord | undefined,
  now: Date,
  began: Date | undefined,
): AdminTokenView {
  const facts = {
    id: token.id,
    scope: token.scope,
    state: token.state,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  };
  if (record !== undefined && record.id === token.id) {
    return { ...facts, minted: "pithy", holderId: record.userId, source: record.source };
  }
  const unrecorded = began === undefined || Date.parse(token.createdAt) < began.getTime();
  const pruned = Date.parse(token.expiresAt) < now.getTime() - TOKEN_RECORD_RETENTION_MS;
  return { ...facts, minted: unrecorded || pruned ? "unknown" : "outside", holderId: null, source: null };
}

/** What a revocation did, from its record, and whether this call is the replay of it. */
export function revocationView(record: ArtifactsRevocationRecord, replayed: boolean): AdminRevocation {
  return {
    repo: record.repo,
    tokenId: record.tokenId,
    revoked: record.revoked,
    reason: record.reason,
    revokedAt: record.createdAt.toISOString(),
    replayed,
  };
}

/** A commit, with only the fields the contract states. */
export function commitView(commit: CommitView): CommitView {
  return {
    hash: commit.hash,
    treeHash: commit.treeHash,
    message: commit.message,
    author: { name: commit.author.name, email: commit.author.email },
    committer: { name: commit.committer.name, email: commit.committer.email },
    parents: [...commit.parents],
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
  };
}
