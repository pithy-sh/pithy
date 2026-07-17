import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types";
import { type LeaderboardDatabase, leaderboardDatabase } from "../data/tables";

/**
 * Read-your-own-writes across D1 read replication.
 *
 * D1 replicas "may be arbitrarily out of date" and Cloudflare publishes no staleness bound. On a
 * leaderboard that lands exactly where a player notices: submit a score, read the board, and your own
 * submission is missing. It reads as a lost write, not as replication lag, and it is the one
 * inconsistency a ranking product cannot shrug off.
 *
 * The D1 Sessions API is the fix. Every query through a session is sequentially consistent with the
 * session's bookmark, so threading a bookmark from a write to the player's next read guarantees they see
 * themselves. The bookmark travels on {@link BOOKMARK_HEADER}: responses return the newest one, and a
 * client echoes it back on the next request.
 *
 * The header is safe to expose and safe to ignore. It is an opaque replication watermark, not a
 * credential — it carries no identity and grants nothing. A client that never echoes it is not broken,
 * only unprotected against lag; a client that sends a stale or unparseable one is anchored no earlier
 * than the write it names. Every route is authenticated regardless, so a bookmark cannot widen access.
 */

/** The header a bookmark travels on, in both directions. */
export const BOOKMARK_HEADER = "x-pithy-d1-bookmark";

/**
 * Where a session with no bookmark starts.
 *
 * Writes anchor at the primary — a submission must land there, and the bookmark it returns is what makes
 * the player's next read see it. Reads with no bookmark are unconstrained and may serve from any replica:
 * that is the point of replication, and a reader who has not written has nothing of their own to miss.
 */
type SessionStart = "first-primary" | "first-unconstrained";

export interface LeaderboardSession {
  /** The Kysely database bound to this session. Every query through it is sequentially consistent. */
  db: LeaderboardDatabase;
  /** The newest bookmark across this session's queries, or null if it ran none. */
  bookmark(): string | null;
}

/**
 * Open a D1 session anchored at `bookmark` when the client sent one, or at `start` when it did not.
 *
 * An unparseable or expired bookmark is D1's to reject, not ours to pre-validate: it is opaque to us, and
 * guessing at its shape here would just be a second place to get it wrong.
 */
export function leaderboardSession(
  d1: D1Database,
  bookmark: string | undefined,
  start: SessionStart,
): LeaderboardSession {
  const session: D1DatabaseSession = d1.withSession(bookmark ?? start);
  return {
    // kysely-d1 drives the database through `prepare` alone, which a session provides — so a session
    // stands in for the binding without the dialect knowing the difference.
    db: leaderboardDatabase(session as unknown as D1Database),
    bookmark: () => session.getBookmark(),
  };
}

/** The bookmark a client echoed back, or undefined. */
export function readBookmark(headers: Headers): string | undefined {
  return headers.get(BOOKMARK_HEADER)?.trim() || undefined;
}
