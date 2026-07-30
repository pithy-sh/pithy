import { ControlPlaneKeyConflictError, ControlPlaneKeyNotFoundError } from "../error/errors";
import type { RegisteredKey } from "./connection";

/**
 * The registered-key lifecycle: pure array logic over a connection's `keys` column.
 *
 * **Registering a key and expiring one are two operations, and folding them into a single `rotate()`
 * is the one design mistake this module exists to prevent.** One call would make append-and-expire
 * atomic, and atomic is precisely wrong here. The whole safety property is that the old key outlives
 * the new one's first successful call: a mis-copied JWK, a private key the management client cannot
 * actually sign with, or a Worker that never answers leaves the adopter holding a credential that
 * still works. Fuse the two writes together and that same mistake locks them out of the seam with
 * nothing left to authenticate the fix with. Kept apart, a broken rotation costs a stale key.
 *
 * So the safe ordering is enforced here rather than documented: {@link appendKey} may not touch an
 * existing key's window, and {@link expireKey} refuses unless another key is already live.
 *
 * Nothing in this module reads a clock, a binding, or D1. `now` is injected on every call, which is
 * what lets a test assert what a connection looks like a year into a failed rotation.
 */

/** Every key that may verify a call at `now`: not revoked, started, and not yet ended. */
export function activeKeys(keys: readonly RegisteredKey[], now: Date): RegisteredKey[] {
  return keys.filter((key) => !isRetired(key, now) && key.validFrom.getTime() <= now.getTime());
}

/**
 * The key that may verify this call, or null. Matching on `kid` alone would be the vulnerability —
 * the window and the revocation are checked here so no caller can forget them.
 */
export function findVerifyingKey(keys: readonly RegisteredKey[], keyId: string, now: Date): RegisteredKey | null {
  return activeKeys(keys, now).find((key) => key.keyId === keyId) ?? null;
}

/**
 * Register a key. Appends, and appends only — no existing key's `validUntil` moves, so a connection
 * mid-rotation always has the key it arrived with.
 *
 * A key that is already retired at `now` is refused rather than stored: it could never be proven by a
 * ping, so registering it would only offer a second step that can never safely be taken.
 */
export function appendKey(keys: readonly RegisteredKey[], key: RegisteredKey, now: Date): RegisteredKey[] {
  if (keys.some((existing) => existing.keyId === key.keyId)) {
    throw new ControlPlaneKeyConflictError({
      message: "That key id is already registered on this connection.",
      action: "Register the replacement under a new key id.",
      detail: `duplicate keyId ${key.keyId}`,
    });
  }
  if (isRetired(key, now)) {
    throw new ControlPlaneKeyConflictError({
      message: "That key has already expired or been revoked.",
      action: "Register a key with an open-ended validity window.",
      detail: `keyId ${key.keyId} is retired at registration`,
    });
  }
  return [...keys, key];
}

/**
 * Close a key's window at `now`, once a replacement has proven itself.
 *
 * `provenKeyId` is the key that verified the request asking for this expiry — proof by use, and the
 * reason the seam's `ping` scope is held implicitly by every connection. Two refusals guard the
 * ordering: a prover that is not itself live has proven nothing, and an expiry that would leave no
 * live key is the lockout, whatever the caller believes about their replacement.
 *
 * Re-expiring a key already closed is a no-op on its end date. The window a call was rejected under
 * must not move retroactively.
 */
export function expireKey(
  keys: readonly RegisteredKey[],
  keyId: string,
  options: { provenKeyId: string; now: Date },
): RegisteredKey[] {
  const { provenKeyId, now } = options;
  if (!keys.some((key) => key.keyId === keyId)) {
    throw new ControlPlaneKeyNotFoundError({ detail: `keyId ${keyId} is not registered on this connection` });
  }
  if (findVerifyingKey(keys, provenKeyId, now) === null) {
    throw new ControlPlaneKeyConflictError({
      message: "The replacement key has not been proven on this connection.",
      action: "Call the ping route with the replacement key, then expire this one.",
      detail: `provenKeyId ${provenKeyId} is not live at ${now.toISOString()}`,
    });
  }

  const expired = keys.map((key) =>
    key.keyId === keyId && key.validUntil === null ? { ...key, validUntil: now } : key,
  );
  if (activeKeys(expired, now).length === 0) {
    throw new ControlPlaneKeyConflictError({
      message: "Expiring that key would leave this connection with no live key.",
      action: "Register a replacement key and prove it before expiring this one.",
      detail: `expiring keyId ${keyId} would empty the connection's live set`,
    });
  }
  return expired;
}

/**
 * Drop keys retired longer ago than `retentionMs`, then cap the array at `maxKeys`.
 *
 * The column is versioned, not a log — a superseded key is kept only long enough for the audit trail
 * and a `GET /control-plane/keys` to explain a rotation. Two keys are never dropped: a live one, and
 * one registered ahead of its `validFrom`, which is unretired rather than dead. So the cap is a
 * target, not a guarantee; a connection with more live keys than `maxKeys` keeps all of them.
 */
export function pruneKeys(
  keys: readonly RegisteredKey[],
  options: { now: Date; retentionMs: number; maxKeys: number },
): RegisteredKey[] {
  const { now, retentionMs, maxKeys } = options;
  const live = new Set(activeKeys(keys, now).map((key) => key.keyId));

  const kept = keys.filter((key) => {
    if (live.has(key.keyId)) return true;
    const retired = retiredAt(key);
    if (retired === null) return true;
    return now.getTime() - retired.getTime() <= retentionMs;
  });
  if (kept.length <= maxKeys) return kept;

  // Over the cap: shed the keys that have been retired longest, which are the least useful to anyone
  // reading the trail. `keyId` is unique (appendKey enforces it), so a set of ids is a safe drop list.
  const dropped = new Set(
    kept
      .flatMap((key) => {
        const retired = live.has(key.keyId) ? null : retiredAt(key);
        return retired === null ? [] : [{ keyId: key.keyId, retiredAt: retired.getTime() }];
      })
      .sort((a, b) => a.retiredAt - b.retiredAt)
      .slice(0, kept.length - maxKeys)
      .map((entry) => entry.keyId),
  );
  return kept.filter((key) => !dropped.has(key.keyId));
}

/**
 * When a key stopped being usable, or null while it is still in play. Revocation and expiry can both
 * be set; the earlier one is when the key actually went cold.
 */
function retiredAt(key: RegisteredKey): Date | null {
  const ends = [key.revokedAt, key.validUntil].filter((date): date is Date => date !== null);
  if (ends.length === 0) return null;
  return ends.reduce((earliest, date) => (date.getTime() < earliest.getTime() ? date : earliest));
}

/**
 * Is this key cold at `now`? Revocation counts whatever date it carries — it is the adopter's
 * unilateral control and does not wait for a window to close. A `validUntil` still ahead is not
 * retirement, and neither is a `validFrom` still ahead: that key is pending, not spent.
 */
function isRetired(key: RegisteredKey, now: Date): boolean {
  return key.revokedAt !== null || (key.validUntil !== null && key.validUntil.getTime() <= now.getTime());
}
