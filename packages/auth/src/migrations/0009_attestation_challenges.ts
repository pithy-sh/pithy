// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** How the issue path finds the challenges that have run out. */
const EXPIRES_INDEX = "pithyAuthAttestationChallengesExpiresAtIdx";

/**
 * `pithy_auth_attestation_challenges`: one row per challenge the attestation challenge route issued and nobody
 * has presented yet. See `../attestation/challenge.ts`. Every date is `integer`, ms-epoch.
 */
export const auth_0009_attestation_challenges: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("pithyAuthAttestationChallenges")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("issuedAt", "integer", (c) => c.notNull())
      .addColumn("expiresAt", "integer", (c) => c.notNull())
      .execute();
    await db.schema.createIndex(EXPIRES_INDEX).on("pithyAuthAttestationChallenges").column("expiresAt").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(EXPIRES_INDEX).execute();
    await db.schema.dropTable("pithyAuthAttestationChallenges").execute();
  },
};
