import { RotatedToken } from "../data/rotatedToken";
import type { AuthDatabase } from "../data/tables";

/**
 * Refresh-token rotation primitives: the atomic consume that makes rotation race-safe, and the
 * reuse-detection ledger that turns a replayed refresh token into a family-wide revocation
 * (OAuth refresh rotation, RFC 6819 §5.2.2.3). The HTTP route (`http/routes.ts`) composes these; they
 * stay here as small, directly testable units over the shared Kysely.
 */

/** The outcome of consuming a session: whether THIS call removed the row, and the consumed family. */
export interface ConsumeResult {
  /** True when this call deleted the session row — the single winner of a concurrent rotation. */
  won: boolean;
  /** The consumed session's family id, or null when it had none (a fresh, never-rotated session). */
  familyId: string | null;
}

/**
 * Atomically consume a live session by its token. The conditional `DELETE ... RETURNING` is the single
 * race gate: of N concurrent rotations presenting the same token, exactly one deletes the row and sees
 * `won: true`; the rest see `won: false` and must not mint a successor. One presented token yields one
 * successor.
 */
export async function consumeSession(db: AuthDatabase, token: string): Promise<ConsumeResult> {
  const row = await db
    .deleteFrom("pithyAuthSessions")
    .where("token", "=", token)
    .returning("familyId")
    .executeTakeFirst();
  return row ? { won: true, familyId: row.familyId ?? null } : { won: false, familyId: null };
}

/**
 * Record a consumed token in the reuse-detection ledger, tagged with the family it belonged to. Idempotent
 * on the token PK — a redundant record (e.g. a retried write) is a no-op, never an error.
 */
export async function recordConsumedToken(
  db: AuthDatabase,
  entry: { token: string; familyId: string; userId: string; rotatedAt: Date },
): Promise<void> {
  await db
    .insertInto("pithyAuthRotatedTokens")
    .values(RotatedToken.encode(entry))
    .onConflict((oc) => oc.column("token").doNothing())
    .execute();
}

/** The family/owner a consumed token belonged to, or null when the token was never consumed. */
export async function findConsumedToken(
  db: AuthDatabase,
  token: string,
): Promise<{ familyId: string; userId: string } | null> {
  const row = await db
    .selectFrom("pithyAuthRotatedTokens")
    .select(["familyId", "userId"])
    .where("token", "=", token)
    .executeTakeFirst();
  return row ? { familyId: row.familyId, userId: row.userId } : null;
}

/** The tokens of every live session in a family — the set a family revocation must sign out. */
export async function familySessionTokens(db: AuthDatabase, familyId: string): Promise<string[]> {
  const rows = await db.selectFrom("pithyAuthSessions").select("token").where("familyId", "=", familyId).execute();
  return rows.map((row) => row.token);
}

/**
 * Revoke an entire refresh-token family: sign out every live session sharing the id. Deletion goes
 * through Better Auth's `deleteSession` (injected) so any adapter-side bookkeeping stays consistent —
 * the same path device-revoke uses. Returns the number of sessions revoked.
 */
export async function revokeFamily(
  db: AuthDatabase,
  familyId: string,
  deleteSession: (token: string) => Promise<unknown>,
): Promise<number> {
  const tokens = await familySessionTokens(db, familyId);
  for (const token of tokens) {
    await deleteSession(token);
  }
  return tokens.length;
}
