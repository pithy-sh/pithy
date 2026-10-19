// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What the repository routes return, as Zod objects a client can validate against and the OpenAPI contract can
 * describe. JSON on the wire, so nothing here carries a codec: parsing a response hands back exactly what went in.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`**, because a client generated from the
 * contract reads Workers on older releases too.
 */

export const RepoOwnerView = z
  .object({
    kind: z.enum(["org", "user"]).describe("Whether an organization or a person owns the repository."),
    id: z.string().describe("The owning organization's id, or the owning person's user id."),
  })
  .describe("Who owns a repository.");
export type RepoOwnerView = z.infer<typeof RepoOwnerView>;

export const RepoView = z
  .object({
    name: z.string().describe("The physical name, as in the clone URL."),
    displayName: z.string().describe("The label the owner chose."),
    owner: RepoOwnerView.describe("Who owns it."),
    access: z
      .enum(["owner", "write", "read"])
      .describe("What the caller may do: everything, push and pull, or pull only. A token is minted at this scope."),
    remoteAccess: z.boolean().describe("Whether a git client may reach the repository."),
    createdAt: z.string().describe("When the repository was created, ISO 8601."),
    updatedAt: z.string().describe("When its row last changed, ISO 8601."),
  })
  .describe("One repository, as the caller may see it.");
export type RepoView = z.infer<typeof RepoView>;

export const RepoList = z
  .object({
    repos: z.array(RepoView).describe("Every repository the caller may see. Never a listing of the namespace."),
  })
  .describe("The repositories a caller may see.");
export type RepoList = z.infer<typeof RepoList>;

export const RepoDetail = RepoView.extend({
  description: z.string().nullable().describe("The description Cloudflare holds, or null."),
  defaultBranch: z.string().describe("The default branch, e.g. `main`."),
  lastPushAt: z.string().nullable().describe("When it was last pushed to, ISO 8601, or null if never."),
  readOnly: z.boolean().describe("Whether Cloudflare holds it read-only."),
  remote: z
    .string()
    .optional()
    .describe(
      "The clone URL. Absent when `remoteAccess` is false: a repository no git client may reach has no address.",
    ),
}).describe("One repository, with what Cloudflare holds about it.");
export type RepoDetail = z.infer<typeof RepoDetail>;

export const GrantView = z
  .object({
    repo: z.string().describe("The repository's physical name."),
    userId: z.string().describe("The person the grant is for."),
    grant: z.enum(["read", "write"]).describe("What the grant gives."),
    updatedAt: z.string().describe("When the grant last changed, ISO 8601."),
  })
  .describe("One person's grant on one repository.");
export type GrantView = z.infer<typeof GrantView>;

export const RepoCredential = z
  .object({
    token: z
      .string()
      .describe(
        "A repository-scoped git token, `art_v1_<40 hex>?expires=<unix seconds>`. Send it as `Authorization: Bearer`, or as the HTTP Basic password with any username. Never stored by the kit.",
      ),
    scope: z.enum(["read", "write"]).describe("What the token may do: pull, or pull and push."),
    expiresAt: z.string().describe("When the token stops working, ISO 8601. Come back for another before then."),
    remote: z.string().describe("The clone URL the token is for."),
  })
  .describe("A short-lived git credential for one repository.");
export type RepoCredential = z.infer<typeof RepoCredential>;

export const RevokedTokens = z
  .object({ revoked: z.number().int().describe("How many live tokens were revoked.") })
  .describe("What revoking every token on a repository did.");
export type RevokedTokens = z.infer<typeof RevokedTokens>;

const Identity = z
  .object({
    name: z.string().describe("The name recorded on the commit."),
    email: z.string().describe("The address recorded on the commit."),
  })
  .describe("A commit's author or committer.");

export const CommitView = z
  .object({
    hash: z.string().describe("The commit id, 40 lowercase hex characters."),
    treeHash: z.string().describe("The id of the commit's root tree."),
    message: z.string().describe("The commit message."),
    author: Identity.describe("Who wrote the change."),
    committer: Identity.describe("Who committed it."),
    parents: z.array(z.string()).describe("The parent commit ids, in Git order. Empty for a root commit."),
    authoredAt: z.number().describe("When it was authored, in Unix seconds."),
    committedAt: z.number().describe("When it was committed, in Unix seconds."),
  })
  .describe("One decoded commit.");
export type CommitView = z.infer<typeof CommitView>;

export const LogView = z
  .object({ commits: z.array(CommitView).describe("Commits along the first-parent chain, newest first.") })
  .describe("A repository's history from one ref.");
export type LogView = z.infer<typeof LogView>;

export const TreeView = z
  .object({
    entries: z
      .array(
        z
          .object({
            name: z.string().describe("The entry's name in the tree."),
            mode: z.string().describe("Its Git mode, e.g. `100644`."),
            hash: z.string().describe("Its object id."),
            type: z
              .enum(["tree", "blob", "symlink", "gitlink", "exec"])
              .describe("What it is: a directory, a file, a link, a submodule, or an executable."),
          })
          .describe("One entry of a tree."),
      )
      .describe("The tree's immediate children."),
  })
  .describe("One Git tree.");
export type TreeView = z.infer<typeof TreeView>;
