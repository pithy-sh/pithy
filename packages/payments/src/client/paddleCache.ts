// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * A price nobody has to fetch twice — opt-in, and only ever where the caller said to put it.
 *
 * One built artifact quotes the marketing site and the dashboard both, and each of them wants the same
 * thing for a different reason: a marketing page a visitor moves around inside should not spend a Paddle
 * round trip per page, and a dashboard that re-mounts a pricing pane should not re-ask a question it
 * asked ten seconds ago. So the quote path can cache. What it may not do is decide any part of how.
 *
 * **Nothing is cached unless the caller names a store, a namespace and a lifetime.** All three, together.
 * A quote resolved from `customerId` is one customer's price, resolved from the address on their account
 * — so where it rests is not a detail this module may pick a default for. `sessionStorage` and
 * `localStorage` are the same interface and very different promises about a shared machine, and only the
 * program that knows who is signed in can choose between them. There is no default. There is no
 * "sensible" fallback. A caller that wants a cache says where.
 *
 * **A lifetime is stated too, for the same reason.** Every figure here is Paddle's, and Paddle's figures
 * move: two recordings of one Japanese price taken minutes apart came back ¥797 and ¥798, because the
 * FX rate moved between the calls. Tax rules change, and a customer changes their billing address. A
 * cached figure is a figure nobody re-checked, so how long that may last is the caller's call and nobody
 * inherits a number they never looked at.
 *
 * **A partial cache is a mistake, and it says so.** Two of the three is what a caller reaches for first,
 * and silently ignoring it would look exactly like caching that works — until the day somebody wonders
 * why the network tab shows a request per page. It warns, names the parts that are missing, and quotes
 * from the network. It never fails the quote: a broken cache must not be able to take a price off a page.
 *
 * **The question is inside the entry's key**, which is what makes caching a signed-in customer's price
 * safe at all. Two visitors are two questions, so one can never be handed the other's answer; and the
 * account is in there beside them, so a sandbox answer cannot survive into production.
 *
 * `console` rather than a logger, and this is the one file in the package that may. The kit's logger is
 * a Worker's — resolved from a request context that does not exist here — and this module compiles into
 * a browser program where `console` *is* the sink an adopter reads. `biome.jsonc` carries the exemption
 * and this sentence is its reason.
 */

/**
 * The slice of a storage this needs.
 *
 * `localStorage` and `sessionStorage` both satisfy it as they are, and so does a `Map` wrapper, an
 * in-memory object, or a caller's own store with a quota policy of its own. Structural for the reason
 * every seam in this directory is: an adopter must be able to satisfy it without importing anything.
 */
export interface PaddleCacheStore {
  /** The stored text under a key, or null when there is none. */
  getItem(key: string): string | null;
  /** Store text under a key, replacing whatever was there. */
  setItem(key: string, value: string): void;
  /** Forget a key. Called on every entry this module decides it may no longer trust. */
  removeItem(key: string): void;
  /**
   * How many entries the store holds, if it can say.
   *
   * `Storage` has this and `key` both, so `localStorage` and `sessionStorage` satisfy them as they are.
   * They are optional because a caller's own three-method store is still a store — it simply does not
   * get swept, which is the difference between a cache that tidies up after itself and one that does not.
   */
  readonly length?: number;
  /** The nth key, if the store can enumerate. */
  key?(index: number): string | null;
}

/** A cache, complete: where entries rest, what namespaces them, and how long one may stand. */
export interface PaddleQuoteCache {
  /** The namespace entries are stored under. Two surfaces sharing a store share nothing else. */
  readonly key: string;
  /** Where entries rest. Named by the caller, always. */
  readonly store: PaddleCacheStore;
  /** How long an entry may stand, in milliseconds. Stated by the caller, always. */
  readonly ttlMs: number;
}

/**
 * The three parts as they arrive from outside TypeScript — a script tag's attributes, a JavaScript
 * caller, a config file. Each may be absent, and each may be nonsense.
 */
export interface PaddleQuoteCacheParts {
  /** The intended namespace. */
  readonly key?: string | null;
  /**
   * The intended store, or the **name** of one that did not resolve.
   *
   * A string is how a caller says "somebody named a store and nothing came back" — a script tag whose
   * `data-paddle-cache-store` is a typo, an environment with no storage. It is not a store, so it is
   * reported missing; but it *was* asked for, so the request is a partial cache and gets a line rather
   * than the silence a caller who asked for nothing gets.
   */
  readonly store?: PaddleCacheStore | string | null;
  /** The intended lifetime, in milliseconds. */
  readonly ttlMs?: number | null;
}

/** What every entry this module writes is stored under, so a store shared with a page stays legible. */
const PREFIX = "pithy.paddle.price";

/** Whether a value can actually store: all three methods, not merely an object that arrived. */
function isStore(value: unknown): value is PaddleCacheStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof PaddleCacheStore, unknown>>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function"
  );
}

/**
 * Read a cache from parts that may be anything, or refuse it out loud.
 *
 * All three or none. Nothing given is a caller who wants no cache, and it says nothing at all. Anything
 * given that does not add up to a cache is a caller who wanted one and will not get one, and that is
 * worth a line in their console rather than a silence they would read as success.
 */
export function readQuoteCache(parts: PaddleQuoteCacheParts): PaddleQuoteCache | null {
  const key = typeof parts.key === "string" ? parts.key.trim() : "";
  const store = isStore(parts.store) ? parts.store : null;
  const ttlMs = typeof parts.ttlMs === "number" && Number.isFinite(parts.ttlMs) && parts.ttlMs > 0 ? parts.ttlMs : null;
  if (key !== "" && store !== null && ttlMs !== null) return { key, store, ttlMs };

  const asked = parts.key ?? parts.store ?? parts.ttlMs;
  if (asked === undefined || asked === null) return null;

  const missing = [key === "" ? "key" : null, store === null ? "store" : null, ttlMs === null ? "ttlMs" : null]
    .filter((part): part is string => part !== null)
    .join(", ");
  console.warn(
    `Paddle price cache ignored. Missing: ${missing}. A cache needs key, store and ttlMs together, so that where a customer's price rests and how long it stands are both stated. Pass all three, or none.`,
  );
  return null;
}

/** Everything one cache stores sits under this. */
function namespace(cache: PaddleQuoteCache): string {
  return `${PREFIX}.${cache.key}.`;
}

/** Where one answer to one question rests. */
function entryKey(cache: PaddleQuoteCache, of: string): string {
  return `${namespace(cache)}${of}`;
}

/** What one entry holds, or null for text this module will not trust. */
function readEntry(stored: string | null): { at: number; answer: unknown } | null {
  if (stored === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entry = parsed as { at?: unknown; answer?: unknown };
  if (typeof entry.at !== "number" || !("answer" in entry)) return null;
  return { at: entry.at, answer: entry.answer };
}

/**
 * Whether an entry has stopped standing.
 *
 * Both directions. A negative age is a clock that moved backwards — a laptop waking up, a device
 * correcting itself — and an entry stamped in the future would otherwise stand until the clock caught up
 * with it, which is the one expiry nobody can predict the length of.
 */
function stale(at: number, ttlMs: number): boolean {
  const age = Date.now() - at;
  return age < 0 || age > ttlMs;
}

/** Forget an entry, and never mind if the store will not let us. */
function forget(cache: PaddleQuoteCache, of: string): void {
  try {
    cache.store.removeItem(entryKey(cache, of));
  } catch {
    // A store that refuses a delete is a store this cannot repair. The entry expires on its own clock.
  }
}

/**
 * The answer this cache holds for a question, while it is still fresh.
 *
 * Null for a miss, and *every* way of being wrong is a miss: no entry, unreadable text, an entry from a
 * version that stored something else, one past its lifetime, one stamped in a future the clock has since
 * moved back from, a store that throws on read. Each of those is a reason to ask Paddle again, and none
 * of them is a reason to show a visitor no price.
 *
 * An entry it will not trust is thrown away rather than left to expire, so a store that has collected
 * something unreadable stops being asked about it.
 */
export function cachedAnswer(cache: PaddleQuoteCache, of: string): unknown | null {
  let stored: string | null;
  try {
    stored = cache.store.getItem(entryKey(cache, of));
  } catch {
    return null;
  }
  if (stored === null) return null;

  const entry = readEntry(stored);
  if (entry === null || stale(entry.at, cache.ttlMs)) {
    forget(cache, of);
    return null;
  }
  return entry.answer;
}

/**
 * Throw away this cache's own expired entries.
 *
 * **Its own, and judged by its own lifetime.** Two surfaces can share one store under different names
 * and different ttls, and sweeping a neighbour's entries against *this* cache's number would throw away
 * answers that are perfectly fresh by the rule they were kept under. Anything outside the namespace —
 * another cache's, or the page's own — is not this module's to read or to delete.
 *
 * Silent, total, and skipped entirely where the store cannot enumerate. A sweep that fails costs the
 * page nothing; the entry it did not reach expires on its own clock the next time anything asks for it.
 */
function sweep(cache: PaddleQuoteCache): void {
  const store = cache.store;
  if (typeof store.key !== "function" || typeof store.length !== "number") return;
  try {
    const expired: string[] = [];
    const mine = namespace(cache);
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key === null || key === undefined || !key.startsWith(mine)) continue;
      const entry = readEntry(store.getItem(key));
      if (entry === null || stale(entry.at, cache.ttlMs)) expired.push(key);
    }
    for (const key of expired) store.removeItem(key);
  } catch {
    // A store that will not be walked is a store that does not get tidied. Nothing else changes.
  }
}

/**
 * Remember an answer to a question, if the store will have it.
 *
 * Silent about a refusal, deliberately. A full quota and Safari's private browsing both throw on write,
 * and neither is a thing the visitor looking at the price can do anything about — the page already has
 * its figure, and the only cost is asking again next time. The warning this module does emit is for a
 * cache the *caller* got wrong, which is a thing they can fix.
 *
 * **It sweeps first.** Nothing reads a departed customer's key again, so nothing would ever expire it:
 * a dashboard caching per customer on a shared machine writes one entry per person who ever signs in,
 * the quota fills, and every write from then on throws into the silence above — caching stops working
 * for everybody, and by design nobody is told. Expiring on the way past is what bounds it.
 */
export function rememberAnswer(cache: PaddleQuoteCache, of: string, answer: unknown): void {
  sweep(cache);
  let text: string;
  try {
    text = JSON.stringify({ at: Date.now(), answer });
  } catch {
    // An answer that will not serialize is one this cannot store. Paddle's never is; a stub's might be.
    return;
  }
  try {
    cache.store.setItem(entryKey(cache, of), text);
  } catch {
    // Quota, or a store that only pretends to be one. The quote already happened.
  }
}
