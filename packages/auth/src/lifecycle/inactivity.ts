// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { AuthDatabase } from "../data/tables";

/**
 * **Inactivity, as the retention policy's class ages count it.**
 *
 * An account is active when it opens a session: a sign-in, or a token refresh. Each one stamps `lastActiveAt` on the
 * account, and a live session refreshed since counts too. An account untouched for longer than the strictest class
 * age it holds is soft-deleted through the lifecycle — `../purge/run.ts` runs the pass — with the same notice mail,
 * the same window and the same purge as any other deletion.
 */

/** Stamp an account active now. Moves the clock forward only, so a late write never makes it look older. */
export async function recordActivity(db: AuthDatabase, userId: string, at: Date): Promise<void> {
  const ms = SQLiteDate.encode(at);
  await db
    .updateTable("pithyAuthUsers")
    .set({ lastActiveAt: ms })
    .where("id", "=", userId)
    .where((eb) => eb.or([eb("lastActiveAt", "is", null), eb("lastActiveAt", "<", ms)]))
    .execute();
}

/**
 * The accounts inactive since `cutoff`, oldest first, at most `limit`: not deleted, last active before it (or, never
 * stamped, created before it), and holding no session refreshed since.
 */
export async function inactiveAccounts(db: AuthDatabase, cutoff: Date, limit: number): Promise<string[]> {
  const ms = SQLiteDate.encode(cutoff);
  const iso = cutoff.toISOString();
  const rows = await db
    .selectFrom("pithyAuthUsers")
    .select("id")
    .where("deletedAt", "is", null)
    .where((eb) =>
      eb.or([eb("lastActiveAt", "<", ms), eb.and([eb("lastActiveAt", "is", null), eb("createdAt", "<", iso)])]),
    )
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("pithyAuthSessions")
            .select("pithyAuthSessions.id")
            .whereRef("pithyAuthSessions.userId", "=", "pithyAuthUsers.id")
            .where("pithyAuthSessions.updatedAt", ">=", iso),
        ),
      ),
    )
    .orderBy("lastActiveAt", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => row.id);
}
