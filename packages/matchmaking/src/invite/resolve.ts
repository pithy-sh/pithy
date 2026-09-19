// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AuthPeer } from "@pithy-sh/auth/src/peer";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { MatchmakingUserNotFoundError } from "../error/errors";

/**
 * Resolve an invite target — an email or a screen name — to a single authenticated user id, via the
 * optional `@pithy-sh/auth` seam: the surface the composition handed over, never an import (#645). Email is the reliable
 * key (unique on the user table); a display name is best-effort and may be ambiguous. Auth exposes no
 * unique screen name, so a name that matches zero or many users throws `matchmaking/user_not_found` —
 * invite by email for certainty. If `@pithy-sh/auth` is not composed, resolution is impossible.
 */

/** How an invitee is addressed — exactly one of these. */
export interface InviteTarget {
  email?: string;
  name?: string;
}

export async function resolveInvitee(
  db: D1Database,
  target: InviteTarget,
  authPeer: AuthPeer | undefined,
): Promise<string> {
  const byEmail = typeof target.email === "string" && target.email.length > 0;
  const byName = typeof target.name === "string" && target.name.length > 0;
  if (byEmail === byName) {
    throw new MatchmakingUserNotFoundError({
      detail: "Provide exactly one of email or name to resolve an invitee.",
    });
  }

  if (authPeer === undefined) {
    throw new MatchmakingUserNotFoundError({
      detail: "@pithy-sh/auth must be composed to resolve an invitee by email or name.",
    });
  }
  const { authDatabase, User } = authPeer;

  const auth = authDatabase(db);

  if (byEmail) {
    const row = await auth
      .selectFrom("pithyAuthUsers")
      // Normalized, so an invite typed `Ada@Example.com` finds the account that signed in as
      // `ada@example.com`. Both sides of every address comparison in the kit go through this rule.
      .where("email", "=", normalizeAddress(target.email as string))
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
