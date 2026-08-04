// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The replay guard: a control-plane token is spendable exactly once.
 *
 * Every other check asks what the call *is* — signature, issuer, audience, environment, scope, body
 * digest, expiry. None of them notices the same valid call arriving twice. {@link ReplayGuard.claim} is
 * what notices: it records the token's `jti` and reports whether this caller was the first to do so. A
 * second arrival is refused, and the caller denies.
 *
 * ## Two implementations, and D1 is the default
 *
 * `d1ReplayGuard` (`./d1Guard`) is the one the seam composes. It claims with
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`, so the primary key decides the winner and the decision is
 * strongly consistent — of N concurrent presentations of one token, exactly one row is inserted and
 * exactly one caller is told it won, wherever the requests landed.
 *
 * `kvReplayGuard` (`./kvGuard`) remains available and selectable, and is **best-effort by construction**.
 * Workers KV has no compare-and-set and is eventually consistent across colocations, so a read-then-write
 * claim admits a genuine race: two copies of one token presented in two PoPs inside the propagation
 * window can both read a miss and both claim. That is why it is no longer the default. It is kept because
 * the trade is legitimate for an adopter who would rather not pay a D1 write on this path and whose admin
 * operations are all idempotent — but it is now an explicit choice with the cost written down, rather
 * than the silent default it used to be.
 *
 * ## Why the default moved
 *
 * The exploitable surface is narrow: same connection, same scope, same body digest, inside a 60-second
 * expiry. What can be replayed is *one exact call*. Most admin operations shrug that off. Not all do — a
 * nudge sends real people a second email, a key registration appends, and anything that enqueues work
 * enqueues it again.
 *
 * And the cost of closing it is close to nothing **here specifically**. A control-plane hot path is an
 * administrator clicking something: low volume, high privilege. Trading a few milliseconds for
 * correctness is the obvious side of that bargain, which is a different calculation from a per-request
 * user path. The seam already owns a D1 namespace, so this is a second migration in an existing one
 * rather than new infrastructure — and single-use-by-unique-constraint is the house pattern besides:
 * `@pithy-sh/auth` consumes a refresh token exactly this way, and `@pithy-sh/payments` keys idempotency
 * off a `UNIQUE`. KV was the outlier.
 */

/**
 * The single-use gate over a token's `jti`. One method, so the storage decision behind it stays
 * replaceable — the interface is the substitution point, and it is why moving the default from KV to D1
 * touched no call site.
 */
export interface ReplayGuard {
  /**
   * Claim `jti` for `connectionId`. Returns true when this call was the first to spend it, and
   * **false when it was already spent — the caller must then deny.** The false case is not an error to
   * log and continue past; it is the replay.
   */
  claim(jti: string, connectionId: string): Promise<boolean>;
}
