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
