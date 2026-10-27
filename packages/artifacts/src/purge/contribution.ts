// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type ErasingPurgeContribution, exportRows, purgeBinding } from "@pithy-sh/core/src/capability/purge";
import { artifactsBinding, callArtifacts } from "../binding/artifacts";
import { ArtifactsGrantRecord, ArtifactsRepoRecord } from "../data/records";
import { artifactsStore } from "../data/store";
import { ARTIFACTS_GRANTS_TABLE, ARTIFACTS_REPOS_TABLE, artifactsDatabase } from "../data/tables";

/**
 * What erasing one person means for `@pithy-sh/artifacts` (#814): every repository they own, with its contents in
 * the Artifacts namespace and every grant on it, and every grant they hold on somebody else's — and what exporting
 * them hands back.
 *
 * **The repository goes first, then its rows.** The row is the only thing that names a repository in the
 * namespace, so a row deleted ahead of its repository would leave a git remote nothing can find. A delete that
 * fails throws, and this step fails and retries alone, with the rows not yet reached still naming what is left.
 * **Idempotent**: the namespace answers `false` for a repository already gone, and a person with nothing finds
 * nothing.
 *
 * Only `ownerKind` `user` decides. A repository an organization owns is the organization's, whoever created it,
 * and its organization's purge is what erases it.
 */

/** The one sentence the purge records with this step. */
export const ARTIFACTS_PURGE_SUMMARY =
  "Deletes every repository the user owns, with its contents and every grant on it, and every grant the user holds on another's.";

/** The user contribution `artifacts()` declares, over the D1 binding and the namespace binding its config names. */
export function artifactsUserPurge(namespace = "ARTIFACTS", database = "DB"): ErasingPurgeContribution {
  const open = (env: Record<string, unknown>) =>
    artifactsDatabase(purgeBinding<D1Database>(env, database, "artifacts"));
  return {
    subject: "user",
    summary: ARTIFACTS_PURGE_SUMMARY,
    erase: async ({ subject, env }) => {
      const db = open(env);
      const store = artifactsStore(db);
      const owned = await store.listOwned("user", subject.id);
      // Resolved only once there is a repository to delete, so a person with none needs no namespace bound.
      if (owned.length > 0) {
        const binding = artifactsBinding(env, namespace);
        for (const repo of owned) {
          await callArtifacts(`delete repository ${repo.name}`, () => binding.delete(repo.name));
          await store.deleteRepo(repo.name);
        }
      }
      await db.deleteFrom(ARTIFACTS_GRANTS_TABLE).where("userId", "=", subject.id).execute();
    },
    export: async ({ subject, env }) => {
      const db = open(env);
      const [repos, grants] = await Promise.all([
        db
          .selectFrom(ARTIFACTS_REPOS_TABLE)
          .selectAll()
          .where("ownerKind", "=", "user")
          .where("ownerId", "=", subject.id)
          .orderBy("createdAt")
          .orderBy("name")
          .execute(),
        db
          .selectFrom(ARTIFACTS_GRANTS_TABLE)
          .selectAll()
          .where("userId", "=", subject.id)
          .orderBy("createdAt")
          .orderBy("repo")
          .execute(),
      ]);
      return {
        repositories: exportRows(repos.map((row) => ArtifactsRepoRecord.parse(row))),
        grants: exportRows(grants.map((row) => ArtifactsGrantRecord.parse(row))),
      };
    },
  };
}
