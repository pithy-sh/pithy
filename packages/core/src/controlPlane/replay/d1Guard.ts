// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ControlPlaneReplay } from "../data/replay";
import { CONTROL_PLANE_REPLAYS_TABLE, type ControlPlaneDatabase } from "../data/tables";
import type { ReplayGuard } from "./guard";

/**
 * The D1-backed {@link ReplayGuard} — the seam's default.
 *
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` is the whole thing. The insert either wins the `jti`
 * primary key and returns a row, or conflicts and returns nothing; there is no read-then-write, so there
 * is no window between deciding and recording. Of N concurrent presentations of one token, SQLite admits
 * exactly one, and it does so identically whichever colocation each request landed in — which is
 * precisely what the KV guard could not promise.
 *
 * It is the same move `@pithy-sh/auth` makes on the other side, consuming a refresh token with a
 * conditional delete so that of N presentations exactly one wins. Single-use-by-constraint is the house
 * pattern; KV was the outlier.
 */

/** What the guard needs from its caller. Injected, so nothing here reaches for a clock or a global. */
export interface D1ReplayGuardOptions {
  /** The clock. Injected so a test can stand at any instant. */
  now: () => Date;
  /**
   * How long a spent `jti` is remembered — `jtiTtlSeconds` from the seam config, which is itself
   * cross-checked at assembly to outlive the widest window a token can be accepted in. A row's
   * `expiresAt` is stamped from it, and the prune below is the only thing that reads it back.
   */
  ttlSeconds: number;
}

/**
 * Delete rows whose token could no longer be accepted under any clock this Worker honors.
 *
 * **Pruning is the one thing KV gave for nothing** — its entries expired themselves, and a table does
 * not. A replay table that only grows is a slow leak in every adopter's database, so this is deliberate
 * rather than left to a future sweep.
 *
 * It runs **only after a successful claim**, which is the load-bearing detail. Pruning on every call
 * would let an attacker replaying one token in a loop drive an unbounded `DELETE` per attempt; a refused
 * claim now costs exactly one conflicting insert and nothing else. And a successful claim is already a
 * write, so the prune rides along on a path that was never read-only, on an administrator-paced route.
 *
 * A failure here is swallowed. Pruning is housekeeping: a claim that has already been decided must not
 * be reported as failed because a cleanup that had nothing to do with the decision could not run.
 */
async function prune(db: ControlPlaneDatabase, now: Date): Promise<void> {
  try {
    await db
      .deleteFrom(CONTROL_PLANE_REPLAYS_TABLE)
      .where("expiresAt", "<", ControlPlaneReplay.shape.expiresAt.encode(now))
      .execute();
  } catch {
    // Deliberate. See above.
  }
}

/** A {@link ReplayGuard} over the seam's own D1 table — strongly consistent, and the default. */
export function d1ReplayGuard(db: ControlPlaneDatabase, options: D1ReplayGuardOptions): ReplayGuard {
  return {
    async claim(jti: string, connectionId: string): Promise<boolean> {
      const now = options.now();
      const record = ControlPlaneReplay.encode({
        jti,
        connectionId,
        expiresAt: new Date(now.getTime() + options.ttlSeconds * 1000),
      });

      const won = await db
        .insertInto(CONTROL_PLANE_REPLAYS_TABLE)
        .values(record)
        // The conflict IS the replay. `doNothing` rather than an upsert: overwriting would refresh the
        // row's expiry on every replay attempt and keep a spent token remembered forever, and it would
        // also return a row, which is the answer that admits the call.
        .onConflict((oc) => oc.column("jti").doNothing())
        .returning("jti")
        .executeTakeFirst();

      if (won === undefined) return false;

      await prune(db, now);
      return true;
    },
  };
}
