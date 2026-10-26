// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The window read's index: rows issued in a range, newest first, the id ordering a millisecond's ties. */
const ISSUED_INDEX = "pithyAuthVerificationOutcomesIssuedAtIdx";
/** How a use finds the row it stamps, and how a wrong code's re-issue moves it. */
const VERIFICATION_INDEX = "pithyAuthVerificationOutcomesVerificationIdIdx";
/** How a purge finds an account's rows. */
const USER_INDEX = "pithyAuthVerificationOutcomesUserIdIdx";

/**
 * The verification ledger (#829): `pithy_auth_verification_outcomes`, one row per sign-in link or code auth
 * issues, stamped when it is used. See `../data/verificationOutcome.ts` for why it exists and what it never holds.
 *
 * **Every date is `integer`**, ms-epoch: nothing but the kit writes this table. **No backfill**: the links and
 * codes issued before this ran left nothing to read back — a used one was deleted on use — so the ledger starts
 * empty, and a window reaching back before the upgrade counts only what was issued after it.
 *
 * **A `0006`, appended.** `@pithy-sh/auth` has shipped, so its chain is history.
 */
export const auth_0006_verification_outcomes: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("pithyAuthVerificationOutcomes")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("verificationId", "text", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("userId", "text")
      .addColumn("emailJobId", "text")
      .addColumn("issuedAt", "integer", (c) => c.notNull())
      .addColumn("expiresAt", "integer", (c) => c.notNull())
      .addColumn("usedAt", "integer")
      .execute();
    await db.schema.createIndex(ISSUED_INDEX).on("pithyAuthVerificationOutcomes").columns(["issuedAt", "id"]).execute();
    await db.schema
      .createIndex(VERIFICATION_INDEX)
      .on("pithyAuthVerificationOutcomes")
      .column("verificationId")
      .execute();
    await db.schema.createIndex(USER_INDEX).on("pithyAuthVerificationOutcomes").column("userId").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(USER_INDEX).execute();
    await db.schema.dropIndex(VERIFICATION_INDEX).execute();
    await db.schema.dropIndex(ISSUED_INDEX).execute();
    await db.schema.dropTable("pithyAuthVerificationOutcomes").execute();
  },
};
