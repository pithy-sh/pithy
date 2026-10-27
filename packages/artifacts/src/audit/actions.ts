// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";

/**
 * Every act this capability records, as an audit action code.
 *
 * **A write grant is transitively a credential to whatever the repository holds**, so the question somebody asks a
 * fortnight later — who could push, who gave them that, who minted the token that did — has to have an answer.
 * Emitted through core's `emit()` seam (`c.var.emit`), never by importing `@pithy-sh/audit`: with no audit capability
 * composed the seam is a no-op, so there is no null check and no dependency.
 *
 * **No row carries a token.** A mint records the token's id and scope and when it expires; the plaintext exists in
 * one response body and nowhere else. A code is stable forever once a row holds one: add, never rename.
 */
export const ArtifactsAuditActions = {
  /** A repository was created, in the namespace and in the ownership table. */
  repoCreated: "artifacts/repo_created",
  /** A repository was deleted, with every token on it and every grant. */
  repoDeleted: "artifacts/repo_deleted",
  /** A person was given a grant, or their grant changed. */
  grantSet: "artifacts/grant_set",
  /** A person's grant was taken away. Tokens already minted against it live out their TTL. */
  grantRemoved: "artifacts/grant_removed",
  /** A git token was minted. Records its id, scope and expiry, never its value. */
  tokenMinted: "artifacts/token_minted",
  /** Every live token on a repository was revoked: by its owner, or by a management client with a reason. */
  tokensRevoked: "artifacts/tokens_revoked",
  /** A management client revoked one token on a repository, with a reason. */
  tokenRevoked: "artifacts/token_revoked",
} as const;

/** One of this capability's audit actions. */
export type ArtifactsAuditAction = (typeof ArtifactsAuditActions)[keyof typeof ArtifactsAuditActions];

/** The acts that take a credential back, recorded at `warning`. */
const REVOCATIONS: ReadonlySet<ArtifactsAuditAction> = new Set([
  ArtifactsAuditActions.tokensRevoked,
  ArtifactsAuditActions.tokenRevoked,
]);

/** One recorded act: who, which repository, for which organization if any, and facts that are never a credential. */
export interface ArtifactsAuditEntry {
  /** What happened. */
  action: ArtifactsAuditAction;
  /**
   * Who did it: a signed-in person (`user`, the default), or a management client (`control-plane`), which is never a
   * user of the adopter's app and is never recorded as one.
   */
  actorType?: "user" | "control-plane";
  /** The signed-in person, or the management client's subject. */
  actorId: string;
  /** The repository's physical name. */
  repo: string;
  /** The owning organization, when an organization owns it. */
  tenant: string | null;
  /** Short, flat facts — a grant, a scope, a count, an expiry. Never a token. */
  facts?: Record<string, string | number | boolean | null>;
}

/**
 * Record one act. **The only writer**, so the rule that no row carries a token is one function's rule: a fact shaped
 * like an Artifacts token (`art_v1_…`) is refused on the way past rather than written into a trail nobody prunes.
 */
export async function recordArtifactsAction(emit: AuditEmit, entry: ArtifactsAuditEntry): Promise<void> {
  const facts = entry.facts ?? {};
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value === "string" && value.includes("art_v1_")) delete facts[key];
  }
  await emit({
    action: entry.action,
    outcome: "success",
    severity: REVOCATIONS.has(entry.action) ? "warning" : "info",
    actorType: entry.actorType ?? "user",
    actorId: entry.actorId,
    resourceType: "artifacts_repo",
    resourceId: entry.repo,
    tenant: entry.tenant,
    metadata: facts,
  });
}
