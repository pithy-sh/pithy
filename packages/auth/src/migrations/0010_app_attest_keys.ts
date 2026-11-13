// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * `pithy_auth_app_attest_keys`: one row per App Attest key an iOS app registered. See `../data/appAttestKey.ts`.
 * Every date is `integer`, ms-epoch.
 */
export const auth_0010_app_attest_keys: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("pithyAuthAppAttestKeys")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("publicKey", "text", (c) => c.notNull())
      .addColumn("appId", "text", (c) => c.notNull())
      .addColumn("environment", "text", (c) => c.notNull())
      .addColumn("counter", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("lastUsedAt", "integer")
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("pithyAuthAppAttestKeys").execute();
  },
};
