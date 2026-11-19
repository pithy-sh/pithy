// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OidcJwk } from "./oidcWebhook";

/**
 * Where a fetched key set is held between requests.
 *
 * **Injected, never a module global.** A cache in a module variable is one cache for the whole isolate that
 * no caller owns, which is how `resetGoogleJwksCache` came to exist: once the state is unreachable, a test
 * suite needs an exported function whose only purpose is to undo the previous suite. Passing the store in
 * deletes that function and the class of bug it papers over — a test seeds its own, and a Worker gives one
 * over KV or the Cache API and shares it across isolates.
 *
 * **Owning the store is not the same as having none.** {@link requireOidcWebhook} builds one per guard when a
 * route gives none, because the guard is the surface anonymous traffic arrives on: with no store, a 49-byte
 * forged token buys a round trip to the issuer, 1:1, until the issuer rate-limits us and the real deliveries
 * 502 alongside the forgeries. `verifyOidcToken` called directly is the other case and does fetch per
 * call — its caller holds one token it has already decided to check, so there is no flood to absorb and no
 * cache to acquire by surprise.
 *
 * **Two facts, not one, and the second is the one that bounds an attacker.** `get`/`set` hold what the issuer
 * published, which answers a `kid` we have seen. `claimRefresh` holds *when we last asked*, which is
 * what answers a `kid` we have not — and that is the whole of the miss path, where an unverified header used
 * to buy an outbound request per delivery. Both live in the store rather than in a closure so that a store
 * shared across isolates (KV, the Cache API) shares the bound too: one ask per window for the deployment,
 * not one per isolate.
 *
 * Public keys, so nothing here is what CLAUDE.md's secrets rule governs: the whole point of a JWKS endpoint
 * is that anyone may read it. What the store buys is one round trip per TTL on the hit path and one per
 * `OIDC_JWKS_MIN_REFRESH_SECONDS` (`./oidcWebhook`) on the miss path, instead of one per delivery on both.
 */
export interface JwksCache {
  /** The key set held for `url`, or `undefined` when nothing usable is held. */
  get(url: string): Promise<readonly OidcJwk[] | undefined>;
  /** Hold a freshly fetched key set for `url` for `ttlSeconds`. */
  set(url: string, keys: readonly OidcJwk[], ttlSeconds: number): Promise<void>;
  /**
   * **May the issuer's endpoint be asked for `url` right now?** `true` grants the ask and records it for
   * `seconds`; `false` says somebody already asked inside that window.
   *
   * One call rather than a read and a write, because the question and the claim are the same act: two
   * deliveries that both read *nobody has asked* and then both ask are the flood this exists to stop. An
   * implementation decides and records before it yields — {@link memoryJwksCache} does it synchronously
   * inside the promise, so concurrent deliveries in one isolate produce exactly one ask. A store over a
   * network is best-effort about that, and best-effort is still a bound.
   *
   * It is about the *ask*, never about the answer, which is what keeps a failing endpoint from being a
   * second amplifier: a refresh that ends in `core/upstream_failed` has still spent the window, so a flood
   * arriving while the issuer is down costs one attempt per window rather than one per delivery.
   */
  claimRefresh(url: string, seconds: number): Promise<boolean>;
}

/**
 * A key cache in memory, expiring on a clock the caller owns.
 *
 * One object per call, so two callers never share one by accident and a test's cache dies with its test. The
 * clock is injected for the same reason it is everywhere else here: an expiry that depends on wall time is an
 * assertion nobody can write.
 */
export function memoryJwksCache(options: { now?: () => Date } = {}): JwksCache {
  const now = options.now ?? (() => new Date());
  const held = new Map<string, { keys: readonly OidcJwk[]; expiresAt: number }>();
  /** When the endpoint behind each url may be asked again. The miss path's whole state. */
  const askedUntil = new Map<string, number>();
  return {
    get: async (url) => {
      const entry = held.get(url);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now().getTime()) {
        held.delete(url);
        return undefined;
      }
      return entry.keys;
    },
    set: async (url, keys, ttlSeconds) => {
      held.set(url, { keys, expiresAt: now().getTime() + ttlSeconds * 1000 });
    },
    // Decided and recorded with no `await` between the read and the write, which is what makes this a claim
    // rather than a check: an isolate handling a thousand concurrent forgeries runs this body a thousand
    // times and grants it once. The async signature is the seam's, for the stores that do reach a network.
    claimRefresh: async (url, seconds) => {
      const at = now().getTime();
      const until = askedUntil.get(url);
      if (until !== undefined && until > at) return false;
      askedUntil.set(url, at + seconds * 1000);
      return true;
    },
  };
}
