// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { MatchmakingUserNotFoundError } from "../error/errors";

/**
 * Resolve an invite target — an email or a screen name — to a single authenticated user id, via the
 * optional `@pithy-sh/auth` seam (dynamic-imported, like multiplayer → leaderboard). Email is the reliable
 * key (unique on the user table); a display name is best-effort and may be ambiguous. Auth exposes no
 * unique screen name, so a name that matches zero or many users throws `matchmaking/user_not_found` —
 * invite by email for certainty. If `@pithy-sh/auth` is not installed, resolution is impossible.
 */

/** How an invitee is addressed — exactly one of these. */
export interface InviteTarget {
  email?: string;
  name?: string;
}

export async function resolveInvitee(db: D1Database, target: InviteTarget): Promise<string> {
  const byEmail = typeof target.email === "string" && target.email.length > 0;
  const byName = typeof target.name === "string" && target.name.length > 0;
  if (byEmail === byName) {
    throw new MatchmakingUserNotFoundError({
      detail: "Provide exactly one of email or name to resolve an invitee.",
    });
  }

  let authDatabase: typeof import("@pithy-sh/auth/src/data/tables").authDatabase;
  let User: typeof import("@pithy-sh/auth/src/data/betterAuth").User;
  try {
    ({ authDatabase } = await import("@pithy-sh/auth/src/data/tables"));
    ({ User } = await import("@pithy-sh/auth/src/data/betterAuth"));
  } catch (cause) {
    throw new MatchmakingUserNotFoundError(
      { detail: "@pithy-sh/auth is required to resolve an invitee by email or name." },
      { cause },
    );
  }

  const auth = authDatabase(db);

  if (byEmail) {
    const row = await auth
      .selectFrom("pithyAuthUsers")
      .where("email", "=", target.email as string)
      .selectAll()
      .executeTakeFirst();
    if (!row) {
      throw new MatchmakingUserNotFoundError({ detail: `No user with email ${target.email}.` });
    }
    return User.parse(row).id;
  }

  // Names are non-unique: zero or many matches is unresolvable.
  const rows = await auth
    .selectFrom("pithyAuthUsers")
    .where("name", "=", target.name as string)
    .selectAll()
    .execute();
  if (rows.length !== 1) {
    throw new MatchmakingUserNotFoundError({
      detail: `Name ${target.name} matched ${rows.length} users; invite by email for a unique identity.`,
    });
  }
  return User.parse(rows[0]).id;
}
