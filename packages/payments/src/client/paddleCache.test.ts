// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cachedAnswer, type PaddleCacheStore, readQuoteCache, rememberAnswer } from "./paddleCache";
import { memoryStore, refusingStore } from "./test-utils/cacheStore";

/**
 * The cache seam, against a store that is a `Map` and a clock that is a fake.
 *
 * Nothing here touches `localStorage`: the store is injected, which is the whole point of the seam, so
 * a test can hand it one that throws, one that holds nonsense, or one it can read afterwards.
 */

/** Five minutes, as a caller states it. */
const FIVE_MINUTES = 300_000;

/** What one quote is asked under. In the Worker this is the account and the query, already serialized. */
const QUERY = '[[["pri_01kzvyz9e21z9vbhd7xqq3csyh",1]],null,null,null,null,null]';

/** A second, different question. */
const OTHER_QUERY = '[[["pri_01kzvyz9khsdy36z10wb8bgmq4",1]],null,"ctm_01kzvyz9",null,null,null]';

/** A recorded answer, standing in for the `{ data, meta }` envelope Paddle resolves. */
const ANSWER = { data: { currencyCode: "USD", details: { lineItems: [] } } };

let warned: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readQuoteCache", () => {
  test("takes a cache that states all three of what it needs", () => {
    const store = memoryStore();
    const cache = readQuoteCache({ key: "pricing", store, ttlMs: FIVE_MINUTES });

    expect(cache).toEqual({ key: "pricing", store, ttlMs: FIVE_MINUTES });
    expect(warned).not.toHaveBeenCalled();
  });

  test("says nothing at all when a caller asked for no cache", () => {
    expect(readQuoteCache({})).toBeNull();
    expect(warned).not.toHaveBeenCalled();
  });

  test("warns and caches nothing when a key arrives with no store and no ttl", () => {
    // Half a cache is the shape a caller reaches for first, and the one that would otherwise look like
    // it worked. Nothing is stored, and the reason says which halves are missing.
    expect(readQuoteCache({ key: "pricing" })).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]?.[0])).toContain("store");
    expect(String(warned.mock.calls[0]?.[0])).toContain("ttlMs");
  });

  test("warns when a store arrives with nothing naming it or timing it", () => {
    expect(readQuoteCache({ store: memoryStore() })).toBeNull();
    expect(String(warned.mock.calls[0]?.[0])).toContain("key");
  });

  test("refuses a ttl that is not a positive number of milliseconds", () => {
    const store = memoryStore();
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readQuoteCache({ key: "pricing", store, ttlMs })).toBeNull();
    }
    expect(warned).toHaveBeenCalledTimes(4);
  });

  test("refuses a key that is not a name", () => {
    expect(readQuoteCache({ key: "  ", store: memoryStore(), ttlMs: FIVE_MINUTES })).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  test("refuses a store that cannot store", () => {
    // A caller compiled from JavaScript can hand this anything. A store missing `removeItem` would read
    // and write happily and never expire an entry, which is the worst of the three ways to be wrong.
    const half = { getItem: () => null, setItem: () => undefined } as unknown as PaddleCacheStore;
    expect(readQuoteCache({ key: "pricing", store: half, ttlMs: FIVE_MINUTES })).toBeNull();
    expect(String(warned.mock.calls[0]?.[0])).toContain("store");
  });
});

describe("rememberAnswer sweeps what it can see", () => {
  test("clears its own expired entries as it writes, so a long-lived store does not fill up", () => {
    // A dashboard caching per customer on a shared machine writes one entry per person who ever signs
    // in, and nothing reads a departed customer's key again — so nothing would ever expire it. The
    // quota fills, `setItem` starts throwing, and caching silently stops working for everybody.
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);
    rememberAnswer(cache, OTHER_QUERY, ANSWER);
    expect(cache.store.entries.size).toBe(2);

    vi.advanceTimersByTime(FIVE_MINUTES + 1);
    rememberAnswer(cache, '[[["pri_third",1]],null,null,null,null,null]', ANSWER);

    expect(cache.store.entries.size).toBe(1);
  });

  test("leaves its own fresh entries where they are", () => {
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);
    vi.advanceTimersByTime(FIVE_MINUTES - 1);
    rememberAnswer(cache, OTHER_QUERY, ANSWER);

    expect(cache.store.entries.size).toBe(2);
    expect(cachedAnswer(cache, QUERY)).toEqual(ANSWER);
  });

  test("never touches another namespace, whose lifetime is not this one's to judge", () => {
    // Two surfaces can share one store with different lifetimes. Sweeping a neighbor's entries against
    // *our* ttl would throw away answers that are still perfectly fresh by the rule they were kept under.
    const store = memoryStore();
    rememberAnswer({ key: "marketing", store, ttlMs: FIVE_MINUTES * 12 }, QUERY, ANSWER);
    vi.advanceTimersByTime(FIVE_MINUTES + 1);
    rememberAnswer({ key: "dashboard", store, ttlMs: FIVE_MINUTES }, OTHER_QUERY, ANSWER);

    expect(store.entries.size).toBe(2);
  });

  test("leaves anything that is not ours alone", () => {
    const store = memoryStore();
    store.entries.set("somebody-elses-key", "not ours to read");
    rememberAnswer({ key: "pricing", store, ttlMs: FIVE_MINUTES }, QUERY, ANSWER);

    expect(store.entries.get("somebody-elses-key")).toBe("not ours to read");
  });

  test("writes happily into a store that cannot be enumerated at all", () => {
    // `length` and `key` are `Storage`'s, and the seam asks for neither. A caller's own three-method
    // store still caches; it just does not get swept.
    const store = memoryStore();
    const minimal: PaddleCacheStore = {
      getItem: (key: string) => store.getItem(key),
      setItem: (key: string, value: string) => store.setItem(key, value),
      removeItem: (key: string) => store.removeItem(key),
    };
    const cache = { key: "pricing", store: minimal, ttlMs: FIVE_MINUTES };

    expect(() => rememberAnswer(cache, QUERY, ANSWER)).not.toThrow();
    expect(cachedAnswer(cache, QUERY)).toEqual(ANSWER);
  });
});

describe("cachedAnswer", () => {
  test("hands back what was remembered, while it is still fresh", () => {
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);
    vi.advanceTimersByTime(FIVE_MINUTES - 1);

    expect(cachedAnswer(cache, QUERY)).toEqual(ANSWER);
  });

  test("misses on a question it was never asked", () => {
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);

    // The whole reason a customer's quote is safe to cache: the customer is inside the question, so one
    // visitor's answer cannot be handed to another.
    expect(cachedAnswer(cache, OTHER_QUERY)).toBeNull();
  });

  test("misses across cache names, so two surfaces sharing a store do not share entries", () => {
    const store = memoryStore();
    rememberAnswer({ key: "marketing", store, ttlMs: FIVE_MINUTES }, QUERY, ANSWER);

    expect(cachedAnswer({ key: "dashboard", store, ttlMs: FIVE_MINUTES }, QUERY)).toBeNull();
  });

  test("misses once the ttl has passed, and throws the entry away", () => {
    // Paddle's FX rate moved between two calls minutes apart while these fixtures were recorded. A cached
    // figure is a figure nobody re-checked, so the caller's ttl is the whole of how long that may last.
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);
    vi.advanceTimersByTime(FIVE_MINUTES + 1);

    expect(cachedAnswer(cache, QUERY)).toBeNull();
    expect(cache.store.entries.size).toBe(0);
  });

  test("misses on an entry stamped in the future, rather than trusting it until the clock catches up", () => {
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);
    vi.setSystemTime(new Date("2026-08-20T11:00:00.000Z"));

    expect(cachedAnswer(cache, QUERY)).toBeNull();
  });

  test("misses on stored text that is not an entry, rather than handing back nonsense", () => {
    const store = memoryStore();
    const cache = { key: "pricing", store, ttlMs: FIVE_MINUTES };
    rememberAnswer(cache, QUERY, ANSWER);
    const [stored] = [...store.entries.keys()];
    store.entries.set(stored ?? "", "not json");

    expect(cachedAnswer(cache, QUERY)).toBeNull();
    expect(store.entries.size).toBe(0);
  });

  test("misses on stored JSON that is not an object at all", () => {
    // A store is shared with the page, and a page can write anything into it under any key. Each of
    // these parses cleanly and is not an entry, so each is a miss and each is thrown away.
    for (const text of ["null", "42", '"a price"', "[]", '[{"at":1,"answer":{}}]']) {
      const store = memoryStore();
      const cache = { key: "pricing", store, ttlMs: FIVE_MINUTES };
      rememberAnswer(cache, QUERY, ANSWER);
      const [stored] = [...store.entries.keys()];
      store.entries.set(stored ?? "", text);

      expect(cachedAnswer(cache, QUERY)).toBeNull();
      expect(store.entries.size).toBe(0);
    }
  });

  test("misses on an entry with no stamp and on one with no answer, which is what an older shape looks like", () => {
    // The shape this module stores may change. An entry the last version wrote is a miss rather than a
    // price nobody validated — the same call `previewPrices` makes when a cached answer no longer reads.
    for (const entry of [{ answer: ANSWER }, { at: "2026-08-20", answer: ANSWER }, { at: 0 }]) {
      const store = memoryStore();
      const cache = { key: "pricing", store, ttlMs: FIVE_MINUTES };
      rememberAnswer(cache, QUERY, ANSWER);
      const [stored] = [...store.entries.keys()];
      store.entries.set(stored ?? "", JSON.stringify(entry));

      expect(cachedAnswer(cache, QUERY)).toBeNull();
      expect(store.entries.size).toBe(0);
    }
  });

  test("misses rather than throwing when the store itself refuses to be read", () => {
    // Safari in private browsing, and a full quota. A cache that cannot be read is a cache miss; taking
    // the price off the page over one would be a worse outcome than fetching it again.
    const cache = { key: "pricing", store: refusingStore(), ttlMs: FIVE_MINUTES };

    expect(() => rememberAnswer(cache, QUERY, ANSWER)).not.toThrow();
    expect(cachedAnswer(cache, QUERY)).toBeNull();
  });

  test("remembers nothing it cannot serialize, and does not take the quote down over it", () => {
    const cache = { key: "pricing", store: memoryStore(), ttlMs: FIVE_MINUTES };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => rememberAnswer(cache, QUERY, circular)).not.toThrow();
    expect(cache.store.entries.size).toBe(0);
  });
});
