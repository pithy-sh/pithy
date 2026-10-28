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

/**
 * The control-plane routes' responses, the `Admin*` shapes. Read by a management client against a customer's Worker
 * on whatever release it runs, so a field added here later is `.optional()`.
 */

export const AdminRepoView = z
  .object({
    name: z.string().describe("The physical name, as in the clone URL."),
    displayName: z.string().describe("The label the owner chose."),
    owner: RepoOwnerView.describe("Who owns it."),
    remoteAccess: z.boolean().describe("Whether a git client may reach the repository."),
    createdAt: z.string().describe("When the repository was created, ISO 8601."),
    updatedAt: z.string().describe("When its row last changed, ISO 8601."),
    lastPushAt: z
      .string()
      .nullable()
      .optional()
      .describe(
        "When it was last pushed to, ISO 8601, or null if never. Absent when Cloudflare could not answer for this repository.",
      ),
  })
  .describe("One repository, as a management client sees it.");
export type AdminRepoView = z.infer<typeof AdminRepoView>;

export const AdminRepoList = z
  .object({
    repos: z.array(AdminRepoView).describe("Repositories the kit knows, newest first."),
    nextCursor: z.string().nullable().describe("Hand back as `cursor` for the next page, or null at the end. Opaque."),
  })
  .describe("One page of every repository the kit knows.");
export type AdminRepoList = z.infer<typeof AdminRepoList>;

export const AdminRepoDetail = z
  .object({
    repo: AdminRepoView.extend({
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
    }).describe("The repository, with what Cloudflare holds about it."),
    grants: z.array(GrantView).describe("Every grant on the repository, by user id. The owner holds no grant row."),
    commits: z.array(CommitView).describe("One page of its commit log, newest first, from Cloudflare's `log()`."),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe("Hand back as `offset` for the next page of the log, or null at its end."),
  })
  .describe("One repository: its metadata, its grants, and a page of its history.");
export type AdminRepoDetail = z.infer<typeof AdminRepoDetail>;

export const AdminTokenView = z
  .object({
    id: z.string().describe("The token id Cloudflare assigned."),
    scope: z.enum(["read", "write"]).describe("What the token may do: pull, or pull and push."),
    state: z.enum(["active", "expired", "revoked"]).describe("Whether it still works, ran out, or was revoked."),
    createdAt: z.string().describe("When Cloudflare created it, ISO 8601."),
    expiresAt: z.string().describe("When it stops working, ISO 8601."),
    minted: z
      .enum(["pithy", "outside", "unknown"])
      .describe(
        "Who minted it: `pithy`, the kit, which recorded its holder; `outside`, something else, such as Cloudflare's dashboard or a script, so it has no holder; or `unknown`, created before the kit began recording when `0002_tokens` ran, so the kit may have minted it with no record. A token expired longer ago than a record is kept also reads `unknown`, but Cloudflare's listing holds live tokens only, so it does not appear there.",
      ),
    holderId: z
      .string()
      .nullable()
      .describe(
        "The user the kit minted it for, or an `erased-` stand-in once that user's account was purged. Null for any token the kit did not record.",
      ),
    source: z
      .enum(["credential", "create"])
      .nullable()
      .describe(
        "For a token the kit recorded: `credential`, minted through the credential route, or `create`, returned with a new repository and revoked before the create answered. Null otherwise.",
      ),
  })
  .describe("One token on a repository, with who holds it where the kit knows. Never its value.");
export type AdminTokenView = z.infer<typeof AdminTokenView>;

export const AdminTokenList = z
  .object({
    tokens: z.array(AdminTokenView).describe("Every token Cloudflare lists on the repository, in its order."),
    total: z.number().int().describe("How many tokens Cloudflare reports on the repository."),
  })
  .describe("Every token on one repository.");
export type AdminTokenList = z.infer<typeof AdminTokenList>;

export const AdminRevocation = z
  .object({
    repo: z.string().describe("The repository's physical name."),
    tokenId: z.string().nullable().describe("The token revoked, or null for a revocation of every live token."),
    revoked: z.number().int().describe("How many tokens the revocation took back. Zero when none was live."),
    reason: z.string().describe("The reason the first request gave."),
    revokedAt: z.string().describe("When the first request ran, ISO 8601."),
    replayed: z
      .boolean()
      .describe("True when this answers a key already spent: nothing was revoked now, and nothing was recorded."),
  })
  .describe("What a control-plane revocation did.");
export type AdminRevocation = z.infer<typeof AdminRevocation>;
