// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * Who owns a repository: an organization, or a person. Without `@pithy-sh/organization` composed every repository
 * is a person's, and the grant table is the whole model.
 */
export const ArtifactsOwnerKind = z
  .enum(["org", "user"])
  .describe("Whether a repository belongs to an organization (`org`) or to one person (`user`).");
export type ArtifactsOwnerKind = z.output<typeof ArtifactsOwnerKind>;

/**
 * **What a grant gives: `read` or `write`, and nothing else.** Artifacts' token scope is binary — `read` is clone,
 * fetch and pull; `write` is read plus push — and a grant is the only thing that maps onto it. A value outside the
 * two is decoded and refused, never asserted.
 */
export const ArtifactsGrant = z
  .enum(["read", "write"])
  .describe("A grant on one repository: `read` (clone, fetch, pull) or `write` (read, plus push).");
export type ArtifactsGrant = z.output<typeof ArtifactsGrant>;

/** One repository the kit knows about — the row in `pithy_artifacts_repos`. */
export const ArtifactsRepoRecord = z
  .object({
    name: z
      .string()
      .describe("The physical name: the repository's name in the namespace, and in its clone URL. The primary key."),
    displayName: z.string().describe("The label the adopter shows. Free text, unique per owner and nowhere else."),
    ownerKind: ArtifactsOwnerKind.describe("Whether the owner is an organization or a person."),
    ownerId: z.string().describe("The owning organization's id, or the owning person's user id."),
    remoteAccess: SQLiteBoolean.describe(
      "Whether a git client may reach this repository. False, the credential route answers 404 and no response discloses the clone URL; the in-Worker reads still answer.",
    ),
    createdAt: SQLiteDate.describe("When the repository was created."),
    updatedAt: SQLiteDate.describe("When this row last changed."),
  })
  .describe("A repository's identity, owner and remote-access switch.");
export type ArtifactsRepoRecord = z.output<typeof ArtifactsRepoRecord>;

/** One person's grant on one repository — the row in `pithy_artifacts_grants`. */
export const ArtifactsGrantRecord = z
  .object({
    repo: z.string().describe("The repository's physical name."),
    userId: z.string().describe("The person the grant is for."),
    grant: ArtifactsGrant.describe("What the grant gives, and the scope of every token minted against it."),
    createdAt: SQLiteDate.describe("When the grant was first made."),
    updatedAt: SQLiteDate.describe("When the grant last changed."),
  })
  .describe("One person's read or write grant on one repository.");
export type ArtifactsGrantRecord = z.output<typeof ArtifactsGrantRecord>;

/**
 * Where a recorded token came from: a mint through the credential route, or the token Cloudflare hands back with a
 * new repository, which the kit revokes before the create answers.
 */
export const ArtifactsTokenSource = z
  .enum(["credential", "create"])
  .describe(
    "Where a token the kit recorded came from: `credential`, minted for a person through the credential route, or `create`, the token Cloudflare returns with a new repository and the kit revokes before answering.",
  );
export type ArtifactsTokenSource = z.output<typeof ArtifactsTokenSource>;

/**
 * **One token the kit minted, and who it was minted for** — the row in `pithy_artifacts_tokens`. Cloudflare's own
 * metadata has no holder; this is the half it lacks. Never the plaintext, which Cloudflare returns once: there is no
 * field for it, so a record handed one drops it on encode.
 */
export const ArtifactsTokenRecord = z
  .object({
    id: z.string().describe("The token id Cloudflare assigned. The primary key, and the join with `listTokens`."),
    repo: z.string().describe("The repository's physical name."),
    userId: z.string().describe("The person the token was minted for."),
    scope: ArtifactsGrant.describe("What the token may do: `read`, or `write`."),
    source: ArtifactsTokenSource.describe("Whether it came from the credential route or with a new repository."),
    createdAt: SQLiteDate.describe("When the kit minted it."),
    expiresAt: SQLiteDate.describe("When it stops working."),
  })
  .describe("A token the kit minted, with the person it was minted for. Never its plaintext.");
export type ArtifactsTokenRecord = z.output<typeof ArtifactsTokenRecord>;

/** What one control-plane revocation was for: one token, or every live token on a repository. */
export const ArtifactsRevocationKind = z
  .enum(["token", "all"])
  .describe("What a control-plane revocation was for: one token (`token`), or every live token (`all`).");
export type ArtifactsRevocationKind = z.output<typeof ArtifactsRevocationKind>;

/**
 * **A spent idempotency key** — the row in `pithy_artifacts_revocations`. It holds what the first call did, so a
 * replay answers the same, revokes nothing new, and emits nothing.
 */
export const ArtifactsRevocationRecord = z
  .object({
    connectionId: z.string().describe("The control-plane connection that spent the key."),
    idempotencyKey: z.string().describe("The key the management client supplied. Unique per connection."),
    kind: ArtifactsRevocationKind.describe("Whether one token or every live token was revoked."),
    repo: z.string().describe("The repository's physical name."),
    tokenId: z.string().nullable().describe("The token revoked, for a revocation of one. Null for every token."),
    reason: z.string().describe("Why, in the operator's words. Recorded on the audit event too."),
    revoked: z.number().int().describe("How many tokens the first call revoked."),
    createdAt: SQLiteDate.describe("When the first call ran."),
  })
  .describe("A control-plane revocation, recorded against its idempotency key.");
export type ArtifactsRevocationRecord = z.output<typeof ArtifactsRevocationRecord>;

/**
 * **How long a token record outlives its token: thirty days.** A record is what names a holder, so it is kept while
 * Cloudflare may still list the token, and pruned on the repository's next mint after that. A listed token with no
 * record that expired longer ago than this reads as `unknown`, never as minted outside Pithy: its record may simply
 * have been pruned.
 */
export const TOKEN_RECORD_RETENTION_MS = 30 * 86_400_000;

/**
 * **The id of the row that says when this database began recording tokens.** `0002_tokens` writes it, in
 * `pithy_artifacts_tokens`, with its `createdAt` set to the moment the migration ran. Every token the kit minted
 * before then has no record, so a listed token created earlier is `unknown` rather than minted outside Pithy. Its
 * `repo` is empty, which no repository's name can be, so no read of a repository's tokens, no prune and no delete ever
 * reaches it. Cloudflare's token ids carry no colon, so it cannot collide with one.
 */
export const TOKEN_RECORDS_BEGAN_ID = "pithy:records-began";
