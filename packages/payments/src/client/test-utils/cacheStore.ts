// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaddleCacheStore } from "../paddleCache";

/**
 * A {@link PaddleCacheStore} a test can look inside.
 *
 * `localStorage` is the store an adopter passes and the wrong one to test against: a suite that reached
 * for it would need a DOM, would leak entries between tests, and could not answer "what is in there now"
 * without re-deriving the key the module chose. This is a `Map`, and the `Map` is exposed — so a test can
 * assert an entry was written, corrupt one to see what happens next, or count what a run left behind.
 *
 * It enumerates, because `Storage` does: `length` and `key` are what a sweep walks, and a stand-in
 * missing them would quietly exercise the un-swept path on every test that thought it was testing one.
 */
export function memoryStore(): PaddleCacheStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

/** A store that refuses everything — Safari in private browsing, and a quota that is full. */
export function refusingStore(): PaddleCacheStore {
  const refuse = (): never => {
    throw new Error("the store is unavailable");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}
