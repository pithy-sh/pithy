// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import type { ArtifactsGrant, ArtifactsRepoRecord } from "../data/records";

/**
 * **What a caller may do with one repository.** `owner` may do everything, a grant may do what it says, and
 * `null` is nothing at all — which every route answers with the same 404 a repository that does not exist gets.
 */
export type ArtifactsAccess = "owner" | ArtifactsGrant;

/** Everything one access decision reads. Nothing in it comes from the request body. */
export interface AccessQuestion {
  /** The repository's row. */
  repo: ArtifactsRepoRecord;
  /** The signed-in caller. */
  userId: string;
  /** The caller's grant row on this repository, already decoded, or `undefined`. */
  grant: ArtifactsGrant | undefined;
  /** The organization this request acts for, from core's seam, or `null`. */
  acting: ActingOrganization | null;
  /** The power that manages an organization's repositories. Absent where `organization` is not composed. */
  managePower?: string;
}

/**
 * Whether the acting organization's role holds the manage power. A power nobody named allows nothing, so an
 * organization's repository is reached through a grant alone until the adopter names one.
 */
export function mayManage(acting: ActingOrganization | null, managePower: string | undefined): boolean {
  return acting !== null && managePower !== undefined && acting.roleAllows(managePower);
}

/**
 * **Who the caller is to this repository.** Two questions, answered separately: ownership — the person, or a member
 * acting for the owning organization whose role holds `managePower` — and the grant row. An owner implies `write`,
 * so ownership wins. A user id that happens to equal an organization's id owns nothing of the organization's,
 * because the owner's kind is part of the question.
 */
export function accessTo(question: AccessQuestion): ArtifactsAccess | null {
  const { repo } = question;
  if (repo.ownerKind === "user" && repo.ownerId === question.userId) return "owner";
  if (
    repo.ownerKind === "org" &&
    question.acting?.organizationId === repo.ownerId &&
    mayManage(question.acting, question.managePower)
  ) {
    return "owner";
  }
  return question.grant ?? null;
}

/**
 * The scope a token is minted with: `write` for an owner or a write grant, `read` for a read grant. **A read grant
 * can never obtain a write token**, because nothing else decides the scope.
 */
export function tokenScope(access: ArtifactsAccess): ArtifactsGrant {
  return access === "read" ? "read" : "write";
}
