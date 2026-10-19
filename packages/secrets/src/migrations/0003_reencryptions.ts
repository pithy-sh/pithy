// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create `pithy_secrets_reencryptions`, where a Worker records that the values it seals under a secret have
 * moved to that secret's newest version — what a value rotation's retirement waits for (`../data/secretReencryptions`).
 *
 * **Appended, never folded into an earlier migration.** `@pithy-sh/secrets` shipped, so `0001` and `0002` are
 * history: a database already running them gains this table from this migration and from nothing else.
 *
 * **One row per place a dependent is held, not per dependent.** Two auth Workers over two databases each seal
 * their own JWKS keys under the one environment-scoped session secret. Keyed by secret and dependent alone,
 * the first to move would answer for both, and the version the second's keys are sealed under would be
 * retired. So `holder` — the database, by the binding name that within one environment names exactly one D1
 * (`docs/NAMING.md`) — is the third half of the key, and the manager waits for every holder that has recorded.
 *
 * Not retained. Losing a row costs a retirement that waits for its dependent to record again, which it does
 * on its next request — never a version retired over a value still sealed under it.
 */
export const secrets_0003_reencryptions: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithySecretsReencryptions")
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("dependent", "text", (c) => c.notNull())
      .addColumn("holder", "text", (c) => c.notNull())
      .addColumn("version", "text", (c) => c.notNull())
      .addColumn("fingerprint", "text", (c) => c.notNull())
      .addColumn("observedAt", "integer", (c) => c.notNull())
      .addColumn("movedAt", "integer")
      .addPrimaryKeyConstraint("pithySecretsReencryptionsPk", ["name", "dependent", "holder"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithySecretsReencryptions").execute();
  },
};
