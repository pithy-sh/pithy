// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ArtifactsGrant } from "../data/records";

/**
 * What the repository routes accept. Declared on the route line with `validate(target, Schema)`, after the guards,
 * so a malformed request is a `validation/invalid_input` 400 and an unauthenticated one is still a 401.
 *
 * The param schemas are **shape** checks. Whether a repository exists, and whether this caller may see it, stays in
 * the handler and answers the one 404.
 */

/** A repository name as a path segment: Cloudflare's charset, at most 63 characters. */
const REPO_SEGMENT = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "A repository name is a letter or digit, then letters, digits, `.`, `_` and `-`.",
  );

/** A user id: opaque, bounded, never parsed. */
const USER_ID = z.string().min(1).max(200);

/** A Git object id: lowercase, 40 hex characters. */
const OBJECT_ID = z.string().regex(/^[0-9a-f]{40}$/, "A Git object id is 40 lowercase hex characters.");

/** A branch, tag or commit id. */
const REF = z.string().min(1).max(256);

export const RepoParams = z
  .object({ name: REPO_SEGMENT.describe("The repository's physical name, as in its clone URL.") })
  .describe("The path params of a route about one repository.");
export type RepoParams = z.output<typeof RepoParams>;

export const GrantParams = z
  .object({
    name: REPO_SEGMENT.describe("The repository's physical name."),
    userId: USER_ID.describe("The person whose grant is removed."),
  })
  .describe("The path params of a route about one person's grant on one repository.");
export type GrantParams = z.output<typeof GrantParams>;

export const ObjectParams = z
  .object({
    name: REPO_SEGMENT.describe("The repository's physical name."),
    hash: OBJECT_ID.describe("The Git object to read, by id."),
  })
  .describe("The path params of a read of one Git object.");
export type ObjectParams = z.output<typeof ObjectParams>;

export const CreateRepoBody = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("The label to show. Free text, unique per owner and nowhere else."),
    name: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "The physical name, for a Worker configured with `acceptRepoName`. Refused otherwise. Held to Cloudflare's charset and the 2-to-63 cap, and refused rather than shortened. Omit it for a random UUID.",
      ),
    description: z.string().max(500).optional().describe("A description Cloudflare stores with the repository."),
    remoteAccess: z
      .boolean()
      .default(true)
      .describe(
        "Whether a git client may reach the repository. False, the credential route answers 404 and no response carries the clone URL; the in-Worker reads still answer. Defaults to true.",
      ),
  })
  .describe("The body of a create-repository request.");
export type CreateRepoBody = z.output<typeof CreateRepoBody>;

export const SetGrantBody = z
  .object({
    userId: USER_ID.describe("The person the grant is for."),
    grant: ArtifactsGrant.describe("What the grant gives: `read` or `write`."),
  })
  .describe("The body of a set-grant request.");
export type SetGrantBody = z.output<typeof SetGrantBody>;

export const LogQuery = z
  .object({
    ref: REF.optional().describe("The branch, tag or commit to walk back from. Defaults to `HEAD`."),
    limit: z.coerce.number().int().min(1).max(1000).optional().describe("At most this many commits. Defaults to 50."),
    offset: z.coerce.number().int().min(0).optional().describe("Skip this many commits first. Defaults to 0."),
  })
  .describe("The query of a history read.");
export type LogQuery = z.output<typeof LogQuery>;

export const FileQuery = z
  .object({
    ref: REF.describe("The branch, tag or commit to read the file at."),
    path: z.string().min(1).max(4096).describe("The file's path in the repository."),
  })
  .describe("The query of a read of one file at one ref.");
export type FileQuery = z.output<typeof FileQuery>;
