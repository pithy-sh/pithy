// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The four state columns, in the order `up` adds them and `down` takes them away in reverse. */
const STATE_COLUMNS = ["suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"] as const;

/**
 * The account lifecycle (#620): whether an account is suspended or deleted, and the record of how it got
 * there.
 *
 * **Four columns on `pithy_auth_users`, so a session read already carries the state.** Better Auth loads the
 * user row for every session it resolves, and returns these because `../data/kitFields.ts` declares them —
 * so refusing a suspended account costs no query on the request that is refused, and none on the requests
 * that are not.
 *
 * **One kit-owned table beside them, `pithy_auth_user_lifecycle`**, holding every transition with its
 * actor, its reason and its time. The columns say what is true now; the table says what happened. No
 * foreign key from it to the user: a purge erases the user row, and this table is the record that must
 * outlive it (`../data/userLifecycle.ts`).
 *
 * **`integer`, not `text`, unlike every Better Auth date on the same table.** Better Auth writes those, as
 * ISO-8601. Nothing but the kit writes these — they are `input: false` — so they take the house ms-epoch
 * convention, and `type: "number"` in `kitFields.ts` keeps Better Auth from converting what it reads back.
 *
 * **Nullable, with no backfill.** Every account that exists when this runs is in neither state, and null is
 * exactly that. SQLite would refuse `ADD COLUMN … NOT NULL` without a constant default anyway.
 *
 * **A `0004`, appended, never folded into `0001`.** `@pithy-sh/auth` has shipped, so its chain is history.
 */
export const auth_0004_user_lifecycle: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    for (const column of STATE_COLUMNS) {
      await db.schema.alterTable("pithyAuthUsers").addColumn(column, "integer").execute();
    }
    await db.schema
      .createTable("pithyAuthUserLifecycle")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("actorType", "text", (c) => c.notNull())
      .addColumn("actorId", "text")
      .addColumn("reason", "text")
      .addColumn("suspendedUntil", "integer")
      .addColumn("step", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();
    // A user's history, newest first, is the one read this table serves — the refusal that shows a
    // suspended person the reason, and an operator's view of what happened to one account. The trailing
    // id orders two transitions written in the same millisecond the way they were written.
    await db.schema
      .createIndex("pithyAuthUserLifecycleUserIdIdx")
      .on("pithyAuthUserLifecycle")
      .columns(["userId", "id"])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // The exact inverse. Nothing else references this table or these columns, and SQLite has supported
    // `DROP COLUMN` since 3.35, which D1 is well past.
    await db.schema.dropIndex("pithyAuthUserLifecycleUserIdIdx").execute();
    await db.schema.dropTable("pithyAuthUserLifecycle").execute();
    for (const column of [...STATE_COLUMNS].reverse()) {
      await db.schema.alterTable("pithyAuthUsers").dropColumn(column).execute();
    }
  },
};
