// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Add `pithy_auth_sessions.authenticated_at` — when this session's holder last actually authenticated,
 * as distinct from when this row was written.
 *
 * **Why the distinction exists.** `/token/rotate` mints a successor session, and Better Auth's
 * `createSession` stamps `created_at` with the moment of the call. So a session's own age is reset by
 * every rotation — which is ordinary on the bearer path and, for anyone holding a stolen refresh token,
 * resettable on demand. Anything that needs to know *how recently the person authenticated* therefore
 * cannot read `created_at`. `authenticated_at` is stamped once, at sign-in, and carried forward verbatim
 * by every rotation (#558).
 *
 * **A `0002` rather than an amendment to `0001_init`, and the condition was checked rather than assumed.**
 * `@pithy-sh/auth` is past `0.0.0`, so `0300_auth_0001_init` has run against databases holding real rows,
 * and a migration that has run somewhere real is history. `CLAUDE.md` states the window and
 * `cli/src/migrations/oneMigration.test.ts` enforces it.
 *
 * **`text`, not `integer`.** Better Auth stores its `date` fields as ISO-8601 strings on SQLite (the
 * kysely adapter reports `supportsDates: false`), which is why every timestamp on this table is `text`
 * while Pithy's own device columns are ms-epoch integers. A column typed against the wrong convention
 * reads back as the wrong thing rather than failing.
 *
 * **It shares the `0002` band with the generated plugin keys, and that is fine.** An adopter's Better
 * Auth plugin migration is keyed `0002_plugin_<id>` whatever the kit's own chain looks like, so the two
 * numbering spaces collide by construction rather than by accident. Within the band the ledger sorts
 * lexicographically, which puts `plugin_*` first — harmless, because no auth migration references
 * another's schema, and deterministic, which is what matters. Renumbering this to `0003` to dodge the
 * band would change nothing about the ordering and would leave a gap that implies a missing step.
 *
 * **Nullable, with no backfill.** A session written before this column cannot be told when it
 * authenticated, and inventing a value would be worse than admitting none. The gate treats absent as
 * not-fresh, so such a session is asked to re-authenticate once; legacy nulls disappear on their own
 * within one session lifetime. Nullable is also forced: SQLite refuses `ADD COLUMN … NOT NULL` without a
 * constant default, and there is no constant that would be true.
 */
export const auth_0002_session_authenticated_at: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyAuthSessions").addColumn("authenticatedAt", "text").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // SQLite has supported `DROP COLUMN` since 3.35, and D1 is well past it. The inverse is exact: the
    // column carries nothing another table references and nothing else derives from it.
    await db.schema.alterTable("pithyAuthSessions").dropColumn("authenticatedAt").execute();
  },
};
