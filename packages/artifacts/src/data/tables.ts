// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { ArtifactsGrantRecord, ArtifactsRepoRecord, ArtifactsRevocationRecord, ArtifactsTokenRecord } from "./records";

/**
 * The capability's four tables. Names are camelCase constants; core's `createDatabase` installs the mandatory
 * `CamelCasePlugin`, so query code never types the snake_case `pithy_artifacts_*` columns.
 */
export const ARTIFACTS_REPOS_TABLE = "pithyArtifactsRepos";
export const ARTIFACTS_GRANTS_TABLE = "pithyArtifactsGrants";
export const ARTIFACTS_TOKENS_TABLE = "pithyArtifactsTokens";
export const ARTIFACTS_REVOCATIONS_TABLE = "pithyArtifactsRevocations";

export function artifactsTables(): Record<string, z.ZodObject> {
  return {
    [ARTIFACTS_REPOS_TABLE]: ArtifactsRepoRecord,
    [ARTIFACTS_GRANTS_TABLE]: ArtifactsGrantRecord,
    [ARTIFACTS_TOKENS_TABLE]: ArtifactsTokenRecord,
    [ARTIFACTS_REVOCATIONS_TABLE]: ArtifactsRevocationRecord,
  };
}

type ArtifactsTables = {
  [ARTIFACTS_REPOS_TABLE]: typeof ArtifactsRepoRecord;
  [ARTIFACTS_GRANTS_TABLE]: typeof ArtifactsGrantRecord;
  [ARTIFACTS_TOKENS_TABLE]: typeof ArtifactsTokenRecord;
  [ARTIFACTS_REVOCATIONS_TABLE]: typeof ArtifactsRevocationRecord;
};
export type ArtifactsDatabase = Kysely<DatabaseSchema<ArtifactsTables>>;

export function artifactsDatabase(d1: D1Database): ArtifactsDatabase {
  return createDatabase(d1, artifactsTables()) as unknown as ArtifactsDatabase;
}
